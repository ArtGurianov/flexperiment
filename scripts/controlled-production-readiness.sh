#!/usr/bin/env bash
set -euo pipefail

# Two questions, deliberately answered by two different mechanisms.
#
#   1. "Has observable production state converged yet?"  -> the poll loop.
#      Surfaces legitimately lag a deployment: a container mid-restart returns
#      a truncated body, the frontend image swaps after the API, the worker
#      records its first successful sweep some seconds after it starts. These
#      are retryable by construction, and only they may ever mean
#      READINESS_POLL_EXHAUSTED.
#
#   2. "Is this runtime admissible?" -> one single-shot assertion, after
#      convergence, outside the loop. Sales state, owner identity, migration
#      expectation and legal evidence do not change by waiting, so re-running
#      the assertion inside the poll would conflate a deterministic defect
#      with ordinary Coolify delay - exactly the 2026-08-28 defect recorded in
#      docs/release/DEPLOYMENT_INVARIANTS.md ("A read-only convergence loop
#      must not collapse a parser exception into 'not converged yet'"), where
#      a TypeError reproduced identically on all 30 attempts and still
#      reported VERIFY_RUNTIME_NOT_CONVERGED_YET.
#
# Exit codes are distinct so a caller can tell the two apart and never treat
# an admission failure as grounds to retry or redeploy:
#
#   0   admitted
#   2   configuration/usage error                                    (terminal)
#   3   READINESS_ADMISSION_REFUSED  converged, not admissible       (terminal)
#   75  READINESS_POLL_EXHAUSTED     never converged  -- THE ONLY RETRYABLE CODE
#   1, and anything else: unexpected failure                         (terminal)
#
# 75 rather than 1 is deliberate, and it is the whole point of the contract.
# A caller is allowed to re-fire a production deployment on the retryable code,
# so that code must never be one this script can return by accident. In shell,
# 1 is exactly that: `set -e` returns it for an unbound ${VAR:?}, a failed
# mktemp/mkdir/cd, and any future command added to this file. Granting 1
# retryable status would let an unrelated latent defect authorise a redeploy.
# 75 is sysexits.h EX_TEMPFAIL - "temporary failure, the user is invited to
# retry" - and nothing here produces it except the exhaustion path below.
#
# Callers MUST gate any retry on equality with 75, never on `!= 0`.

readonly READINESS_EXIT_CONFIGURATION=2
readonly READINESS_EXIT_ADMISSION=3
readonly READINESS_EXIT_CONVERGENCE=75

# ${VAR:?} would exit 1 under `set -e`, which this contract reserves for
# unexpected failure. A missing input is a configuration error and says so.
require_configuration() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || { echo "READINESS_REQUIRED_CONFIGURATION_MISSING: $name" >&2; exit "$READINESS_EXIT_CONFIGURATION"; }
  done
}

[[ -n "${1:-}" ]] || { echo "READINESS_REQUEST_PATH_REQUIRED" >&2; exit "$READINESS_EXIT_CONFIGURATION"; }
request_path="$1"
readiness_phase="${2:-promotion}"
require_configuration PUBLIC_API_URL PUBLIC_FRONTEND_URL ADMIN_RELEASE_URL COMMERCE_RELEASE_CONTROL_TOKEN \
  TARGET_SHA CHECKOUT_CONTRACT_VERSION ADMIN_CONTRACT_VERSION POLL_ATTEMPTS POLL_SECONDS

# A pinned runtime parser runs from its own detached worktree, so the
# controller-owned request must be resolved before that directory change.
[[ -f "$request_path" ]] || { echo "READINESS_REQUEST_PATH_NOT_A_FILE: $request_path" >&2; exit "$READINESS_EXIT_CONFIGURATION"; }
request_path="$(cd "$(dirname "$request_path")" && pwd)/$(basename "$request_path")"

case "$readiness_phase" in
  promotion) ;;
  candidate-pre-publication)
    require_configuration PREVIOUS_LEGAL_VERSION
    ;;
  *) echo "READINESS_PHASE_INVALID" >&2; exit "$READINESS_EXIT_CONFIGURATION" ;;
esac

poll_connect_timeout="${POLL_CONNECT_TIMEOUT:-3}"
poll_max_time="${POLL_MAX_TIME:-7}"
[[ "$POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ && "$POLL_SECONDS" =~ ^[0-9]+$ ]] || { echo "READINESS_POLL_CONFIGURATION_INVALID" >&2; exit "$READINESS_EXIT_CONFIGURATION"; }
[[ "$poll_connect_timeout" =~ ^[1-9][0-9]*$ && "$poll_max_time" =~ ^[1-9][0-9]*$ && "$poll_connect_timeout" -le "$poll_max_time" ]] || { echo "READINESS_POLL_TIMEOUT_CONFIGURATION_INVALID" >&2; exit "$READINESS_EXIT_CONFIGURATION"; }

workspace="$(mktemp -d "${TMPDIR:-/tmp}/flexperiment-readiness.XXXXXX")"
last_attempt_dir=""
trap 'rm -rf "$workspace"' EXIT

fetch_json() {
  local label="$1" url="$2" destination="$3" authenticated="$4"
  local temporary="${destination}.tmp" stderr_path="${destination}.stderr" curl_status
  local -a headers=(--fail --silent --show-error --connect-timeout "$poll_connect_timeout" --max-time "$poll_max_time" --output "$temporary")
  if [[ "$authenticated" == "yes" ]]; then headers+=(-H "Authorization: Bearer $COMMERCE_RELEASE_CONTROL_TOKEN"); fi
  if curl "${headers[@]}" "$url" 2>"$stderr_path"; then
    if jq -e 'type == "object"' "$temporary" >/dev/null 2>&1; then
      mv "$temporary" "$destination"
      return 0
    fi
    rm -f "$temporary"
    return 65
  else
    curl_status=$?
    rm -f "$temporary"
    return "$curl_status"
  fi
}

emit_observed() {
  local directory="$1"
  [[ -f "$directory/status.json" ]] && jq -c '{sales_paused, owner_release_id, runtime: {source_commit: .runtime.source_commit, worker_source_commit: .runtime.worker_source_commit, worker_started_at: .runtime.worker_started_at, worker_last_successful_sweep_at: .runtime.worker_last_successful_sweep_at}}' "$directory/status.json" >&2 || true
  [[ -f "$directory/frontend.json" ]] && jq -c '{frontend_source_commit: .source_commit}' "$directory/frontend.json" >&2 || true
  [[ -f "$directory/admin.json" ]] && jq -c '{admin_source_commit: .source_commit}' "$directory/admin.json" >&2 || true
  [[ -f "$directory/legal.json" ]] && jq -c '{legal_version: .version}' "$directory/legal.json" >&2 || true
  [[ -s "$directory/admission.stderr" ]] && {
    echo "Admission diagnostic:" >&2
    cat "$directory/admission.stderr" >&2
  }
  return 0
}

# Observable convergence only. Every reason this can return is a state that a
# still-rolling deployment legitimately passes through on its way to the
# target, so every one of them is retryable.
converged_reason() {
  local directory="$1"
  if ! jq -e --arg sha "$TARGET_SHA" '.runtime.source_commit == $sha' "$directory/status.json" >/dev/null; then
    echo "GENERIC_DEPLOY_RUNTIME_SOURCE_NOT_CONVERGED"; return 1
  fi
  if ! jq -e --arg sha "$TARGET_SHA" '.runtime.worker_source_commit == $sha' "$directory/status.json" >/dev/null; then
    echo "GENERIC_DEPLOY_WORKER_SOURCE_NOT_CONVERGED"; return 1
  fi
  # Presence only. Whether the timestamps are *fresh enough* is an eligibility
  # judgement and belongs to the one-shot admission below, not to this loop.
  if ! jq -e '.runtime.worker_started_at != null and .runtime.worker_observed_at != null and .runtime.worker_last_successful_sweep_at != null' "$directory/status.json" >/dev/null; then
    echo "GENERIC_DEPLOY_WORKER_SWEEP_NOT_OBSERVED"; return 1
  fi
  if ! jq -e --arg sha "$TARGET_SHA" --arg contract "$CHECKOUT_CONTRACT_VERSION" '.source_commit == $sha and .checkout_contract_version == $contract' "$directory/frontend.json" >/dev/null; then
    echo "GENERIC_DEPLOY_FRONTEND_RELEASE_EVIDENCE_MISMATCH"; return 1
  fi
  if ! jq -e --arg sha "$TARGET_SHA" --arg contract "$ADMIN_CONTRACT_VERSION" '.source_commit == $sha and .admin_contract_version == $contract' "$directory/admin.json" >/dev/null; then
    echo "GENERIC_DEPLOY_ADMIN_RELEASE_EVIDENCE_MISMATCH"; return 1
  fi
  if [[ "$readiness_phase" == "candidate-pre-publication" ]] && ! jq -e --arg previous "$PREVIOUS_LEGAL_VERSION" '.version == $previous' "$directory/legal.json" >/dev/null; then
    echo "GENERIC_DEPLOY_PREVIOUS_LEGAL_EVIDENCE_MISMATCH"; return 1
  fi
  if [[ "$readiness_phase" == "promotion" ]] && ! jq -e --slurpfile request "$request_path" '(.version == $request[0].expected.legal_version) and ({PUBLIC_OFFER: .manifest.documents.PUBLIC_OFFER.sha256, PRIVACY_POLICY: .manifest.documents.PRIVACY_POLICY.sha256, PD_CONSENT: .manifest.documents.PD_CONSENT.sha256, CHECKOUT_DISCLOSURE: .manifest.documents.CHECKOUT_DISCLOSURE.sha256} == $request[0].expected.legal_hashes)' "$directory/legal.json" >/dev/null; then
    echo "GENERIC_DEPLOY_PUBLIC_LEGAL_EVIDENCE_MISMATCH"; return 1
  fi
  if ! jq -e '.ok == true' "$directory/health.json" >/dev/null; then
    echo "GENERIC_DEPLOY_HEALTHZ_NOT_READY"; return 1
  fi
  if ! jq -e '.ok == true' "$directory/ready.json" >/dev/null; then
    echo "GENERIC_DEPLOY_READYZ_NOT_READY"; return 1
  fi
  return 0
}

# Runs at most once, only after convergence. Never inside the loop above.
run_admission() {
  local directory="$1"
  if [[ "$readiness_phase" == "candidate-pre-publication" ]]; then
    node --import tsx commerce/src/assert-candidate-runtime-ready.ts "$directory/status.json" "$TARGET_SHA" "$(jq -er '.expected.migration' "$request_path")" "$PREVIOUS_LEGAL_VERSION" >/dev/null 2>"$directory/admission.stderr"
    return
  fi
  if [[ -n "${RUNTIME_ASSERT_DIR:-}" ]]; then
    [[ -d "$RUNTIME_ASSERT_DIR" ]] || { echo "RUNTIME_ASSERT_WORKTREE_MISSING" >"$directory/admission.stderr"; return 1; }
    (cd "$RUNTIME_ASSERT_DIR" && node --import tsx commerce/src/assert-generic-production-deploy-ready.ts "$directory/status.json" "$request_path" paused) >/dev/null 2>"$directory/admission.stderr"
    return
  fi
  node --import tsx commerce/src/assert-generic-production-deploy-ready.ts "$directory/status.json" "$request_path" paused >/dev/null 2>"$directory/admission.stderr"
}

converged="no"
for attempt in $(seq 1 "$POLL_ATTEMPTS"); do
  attempt_dir="$workspace/attempt-$attempt"
  mkdir "$attempt_dir"
  last_attempt_dir="$attempt_dir"
  labels=(status frontend admin legal health ready)
  urls=(
    "$PUBLIC_API_URL/v1/internal/release-control/status"
    "$PUBLIC_FRONTEND_URL/release.json"
    "$ADMIN_RELEASE_URL"
    "$PUBLIC_API_URL/v1/public/legal-config"
    "$PUBLIC_API_URL/healthz"
    "$PUBLIC_API_URL/readyz"
  )
  auth=(yes no no no no no)
  pids=()
  for index in "${!labels[@]}"; do
    fetch_json "${labels[$index]}" "${urls[$index]}" "$attempt_dir/${labels[$index]}.json" "${auth[$index]}" &
    pids+=("$!")
  done
  failed=()
  failed_statuses=()
  for index in "${!pids[@]}"; do
    wait_status=0
    wait "${pids[$index]}" || wait_status=$?
    if ((wait_status)); then
      failed+=("${labels[$index]}")
      failed_statuses+=("$wait_status")
    fi
  done
  if ((${#failed[@]})); then
    fetch_reasons=()
    for index in "${!failed[@]}"; do
      label="${failed[$index]}"
      if [[ "${failed_statuses[$index]}" == "65" ]]; then
        fetch_reasons+=("${label} returned invalid JSON")
      else
        fetch_reasons+=("${label} fetch failed (curl exit ${failed_statuses[$index]})")
      fi
    done
    reason="GENERIC_DEPLOY_READINESS_FETCH_FAILED:${fetch_reasons[*]}"
  else
    reason=""
    reason="$(converged_reason "$attempt_dir")" || true
    if [[ -z "$reason" ]]; then
      echo "Readiness attempt $attempt/$POLL_ATTEMPTS: CONVERGED"
      converged="yes"
      break
    fi
  fi
  if [[ "$attempt" == "$POLL_ATTEMPTS" ]]; then
    echo "Readiness attempt $attempt/$POLL_ATTEMPTS: $reason"
    echo "READINESS_POLL_EXHAUSTED: $reason" >&2
    emit_observed "$last_attempt_dir"
    exit "$READINESS_EXIT_CONVERGENCE"
  fi
  echo "Readiness attempt $attempt/$POLL_ATTEMPTS: SURFACES_CONVERGING ($reason)"
  sleep "$POLL_SECONDS"
done

# Unreachable defensively: the loop either breaks converged or exits above.
[[ "$converged" == "yes" ]] || { echo "READINESS_POLL_EXHAUSTED: GENERIC_DEPLOY_CONVERGENCE_UNRESOLVED" >&2; exit "$READINESS_EXIT_CONVERGENCE"; }

if ! run_admission "$last_attempt_dir"; then
  echo "READINESS_ADMISSION_REFUSED" >&2
  emit_observed "$last_attempt_dir"
  exit "$READINESS_EXIT_ADMISSION"
fi
echo "Readiness: ADMITTED"
exit 0
