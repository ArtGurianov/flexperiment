#!/usr/bin/env bash
set -euo pipefail

request_path="${1:?Pass the durable release request JSON path.}"
: "${PUBLIC_API_URL:?PUBLIC_API_URL is required}"
: "${PUBLIC_FRONTEND_URL:?PUBLIC_FRONTEND_URL is required}"
: "${ADMIN_RELEASE_URL:?ADMIN_RELEASE_URL is required}"
: "${COMMERCE_RELEASE_CONTROL_TOKEN:?COMMERCE_RELEASE_CONTROL_TOKEN is required}"
: "${TARGET_SHA:?TARGET_SHA is required}"
: "${CHECKOUT_CONTRACT_VERSION:?CHECKOUT_CONTRACT_VERSION is required}"
: "${ADMIN_CONTRACT_VERSION:?ADMIN_CONTRACT_VERSION is required}"
: "${POLL_ATTEMPTS:?POLL_ATTEMPTS is required}"
: "${POLL_SECONDS:?POLL_SECONDS is required}"

poll_connect_timeout="${POLL_CONNECT_TIMEOUT:-3}"
poll_max_time="${POLL_MAX_TIME:-7}"
[[ "$POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ && "$POLL_SECONDS" =~ ^[0-9]+$ ]] || { echo "READINESS_POLL_CONFIGURATION_INVALID" >&2; exit 2; }
[[ "$poll_connect_timeout" =~ ^[1-9][0-9]*$ && "$poll_max_time" =~ ^[1-9][0-9]*$ && "$poll_connect_timeout" -le "$poll_max_time" ]] || { echo "READINESS_POLL_TIMEOUT_CONFIGURATION_INVALID" >&2; exit 2; }

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
  [[ -s "$directory/runtime.stderr" ]] && {
    echo "Runtime readiness diagnostic:" >&2
    sed -n '1p' "$directory/runtime.stderr" >&2
  }
}

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
  elif ! node --import tsx commerce/src/assert-generic-production-deploy-ready.ts "$attempt_dir/status.json" "$request_path" paused >/dev/null 2>"$attempt_dir/runtime.stderr"; then
    reason="GENERIC_DEPLOY_RUNTIME_EVIDENCE_NOT_READY"
  elif ! jq -e --arg sha "$TARGET_SHA" --arg contract "$CHECKOUT_CONTRACT_VERSION" '.source_commit == $sha and .checkout_contract_version == $contract' "$attempt_dir/frontend.json" >/dev/null; then
    reason="GENERIC_DEPLOY_FRONTEND_RELEASE_EVIDENCE_MISMATCH"
  elif ! jq -e --arg sha "$TARGET_SHA" --arg contract "$ADMIN_CONTRACT_VERSION" '.source_commit == $sha and .admin_contract_version == $contract' "$attempt_dir/admin.json" >/dev/null; then
    reason="GENERIC_DEPLOY_ADMIN_RELEASE_EVIDENCE_MISMATCH"
  elif ! jq -e --slurpfile request "$request_path" '(.version == $request[0].expected.legal_version) and ({PUBLIC_OFFER: .manifest.documents.PUBLIC_OFFER.sha256, PRIVACY_POLICY: .manifest.documents.PRIVACY_POLICY.sha256, PD_CONSENT: .manifest.documents.PD_CONSENT.sha256, CHECKOUT_DISCLOSURE: .manifest.documents.CHECKOUT_DISCLOSURE.sha256} == $request[0].expected.legal_hashes)' "$attempt_dir/legal.json" >/dev/null; then
    reason="GENERIC_DEPLOY_PUBLIC_LEGAL_EVIDENCE_MISMATCH"
  elif ! jq -e '.ok == true' "$attempt_dir/health.json" >/dev/null; then
    reason="GENERIC_DEPLOY_HEALTHZ_NOT_READY"
  elif ! jq -e '.ok == true' "$attempt_dir/ready.json" >/dev/null; then
    reason="GENERIC_DEPLOY_READYZ_NOT_READY"
  else
    echo "Readiness attempt $attempt/$POLL_ATTEMPTS: PASS"
    exit 0
  fi
  if [[ "$attempt" == "$POLL_ATTEMPTS" ]]; then
    echo "Readiness attempt $attempt/$POLL_ATTEMPTS: $reason"
    echo "READINESS_POLL_EXHAUSTED: $reason" >&2
    emit_observed "$last_attempt_dir"
    exit 1
  fi
  echo "Readiness attempt $attempt/$POLL_ATTEMPTS: SURFACES_CONVERGING ($reason)"
  sleep "$POLL_SECONDS"
done
