#!/usr/bin/env bash
# Read-only convergence observer for a Q4 DORMANT deployment after the
# production-deploy CAS.  It never invokes a deployer or changes Git/release state.
set -euo pipefail

: "${TARGET_SHA:?TARGET_SHA is required}"
: "${Q4_RELEASE_ID:?Q4_RELEASE_ID is required}"
: "${Q4_MIGRATION:?Q4_MIGRATION is required}"
: "${PUBLIC_API_URL:?PUBLIC_API_URL is required}"
: "${PUBLIC_FRONTEND_URL:?PUBLIC_FRONTEND_URL is required}"
: "${ADMIN_RELEASE_URL:?ADMIN_RELEASE_URL is required}"

poll_attempts="${POLL_ATTEMPTS:-30}"
poll_seconds="${POLL_SECONDS:-10}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
source "$(dirname "$0")/release-api.sh"

[[ "$(scripts/read-production-deploy-ref.sh)" == "$TARGET_SHA" ]] || {
  echo AGENT_REFERRALS_Q4_OBSERVE_PRODUCTION_POINTER_MISMATCH >&2
  exit 1
}

api "$PUBLIC_API_URL/v1/internal/release-control/status" > initial-status.json
api "$PUBLIC_API_URL/v1/internal/release-control/completion/$Q4_RELEASE_ID" > initial-completion.json
jq -e --arg source "$TARGET_SHA" --arg migration "$Q4_MIGRATION" \
  '.expected | {expected:{source_commit, migration, legal_version, legal_manifest_sha256}} | select(.expected.source_commit == $source and .expected.migration == $migration)' \
  initial-status.json > q4-gate-projection.json
jq -e '.expected.legal_version != null and .expected.legal_manifest_sha256 != null' q4-gate-projection.json >/dev/null || {
  echo AGENT_REFERRALS_Q4_OBSERVE_LEGAL_PROJECTION_UNAVAILABLE >&2
  exit 1
}
jq -e --arg id "$Q4_RELEASE_ID" --slurpfile gate q4-gate-projection.json \
  '.owner_release_id == $id and .owner_mode == "ROLLING" and .sales_paused == false and .expected == $gate[0].expected' \
  initial-status.json >/dev/null || {
  echo AGENT_REFERRALS_Q4_OBSERVE_AUTHORITY_MISMATCH >&2
  exit 1
}
jq -e '.complete == false' initial-completion.json >/dev/null || {
  echo AGENT_REFERRALS_Q4_OBSERVE_COMPLETION_MISMATCH >&2
  exit 1
}

for attempt in $(seq 1 "$poll_attempts"); do
  if ! api "$PUBLIC_API_URL/v1/internal/release-control/status" > observed-status.json; then sleep "$poll_seconds"; continue; fi
  if ! api "$PUBLIC_API_URL/v1/internal/release-control/completion/$Q4_RELEASE_ID" > observed-completion.json; then sleep "$poll_seconds"; continue; fi
  jq -e --arg id "$Q4_RELEASE_ID" --slurpfile gate q4-gate-projection.json \
    '.owner_release_id == $id and .owner_mode == "ROLLING" and .sales_paused == false and .expected == $gate[0].expected' \
    observed-status.json >/dev/null || {
    echo AGENT_REFERRALS_Q4_OBSERVE_AUTHORITY_MISMATCH >&2
    exit 1
  }
  jq -e '.complete == false' observed-completion.json >/dev/null || {
    echo AGENT_REFERRALS_Q4_OBSERVE_COMPLETION_MISMATCH >&2
    exit 1
  }
  runtime_source="$(jq -r '.runtime.source_commit // empty' observed-status.json)"
  worker_source="$(jq -r '.runtime.worker_source_commit // empty' observed-status.json)"
  health="$(curl --fail --silent "$PUBLIC_API_URL/healthz" | jq -r '.ok // false' 2>/dev/null || true)"
  ready="$(curl --fail --silent "$PUBLIC_API_URL/readyz" | jq -r '.ok // false' 2>/dev/null || true)"
  frontend_source="$(curl --fail --silent "$PUBLIC_FRONTEND_URL/release.json" | jq -r '.source_commit // empty' 2>/dev/null || true)"
  admin_source="$(curl --fail --silent "$ADMIN_RELEASE_URL" | jq -r '.source_commit // empty' 2>/dev/null || true)"
  if [[ "$runtime_source" == "$TARGET_SHA" && "$worker_source" == "$TARGET_SHA" && "$health" == true && "$ready" == true && "$frontend_source" == "$TARGET_SHA" && "$admin_source" == "$TARGET_SHA" ]]; then
    {
      echo "## Q4 post-CAS convergence observation"
      echo "- classification: CONVERGED_Q4"
      echo "- attempts: $attempt"
      echo "- mutations performed: NONE"
    } >> "$summary"
    exit 0
  fi
  echo "Q4_STILL_CONVERGING attempt=$attempt runtime=$runtime_source worker=$worker_source frontend=$frontend_source admin=$admin_source health=$health ready=$ready"
  sleep "$poll_seconds"
done

echo AGENT_REFERRALS_Q4_OBSERVE_CONVERGENCE_TIMEOUT >&2
exit 1
