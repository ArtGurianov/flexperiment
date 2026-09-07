#!/usr/bin/env bash
# One-shot recovery for the proven Q4 post-CAS stale commerce/frontend topology.
# This is deliberately not a generic deploy helper: its target and its two
# services are fixed here, and its only output is webhook-attempt evidence.
set -euo pipefail

readonly TARGET_SHA="e0cf268496660dade2db3fa43b189682d059c25c"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN is required}"
: "${COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL:?COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL is required}"
: "${COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL:?COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL is required}"
: "${COOLIFY_Q4_STALE_SURFACES_OUTCOMES:?COOLIFY_Q4_STALE_SURFACES_OUTCOMES is required}"

umask 077
mkdir -p "$(dirname "$COOLIFY_Q4_STALE_SURFACES_OUTCOMES")"

production_deploy() {
  local ref
  ref="$(git ls-remote --exit-code origin refs/heads/production-deploy)" || return 1
  awk 'NR == 1 { print $1 }' <<<"$ref"
}

observed_production="$(production_deploy)" || {
  echo AGENT_REFERRALS_Q4_STALE_SURFACES_PRODUCTION_POINTER_UNREADABLE >&2
  exit 1
}
[[ "$observed_production" == "$TARGET_SHA" ]] || {
  echo AGENT_REFERRALS_Q4_STALE_SURFACES_PRODUCTION_POINTER_MISMATCH >&2
  exit 1
}

outcomes='[]'
persist_outcomes() {
  local temporary_outcomes="${COOLIFY_Q4_STALE_SURFACES_OUTCOMES}.tmp"
  printf '%s\n' "$outcomes" > "$temporary_outcomes"
  mv "$temporary_outcomes" "$COOLIFY_Q4_STALE_SURFACES_OUTCOMES"
}

attempt() {
  local service="$1" webhook="$2" http_status="" curl_status=0 outcome
  # Re-read immediately before every consequence; the second independent
  # request is forbidden if the durable Git pointer changes after the first.
  observed_production="$(production_deploy)" || {
    echo AGENT_REFERRALS_Q4_STALE_SURFACES_PRODUCTION_POINTER_UNREADABLE >&2
    exit 1
  }
  [[ "$observed_production" == "$TARGET_SHA" ]] || {
    echo AGENT_REFERRALS_Q4_STALE_SURFACES_PRODUCTION_POINTER_MISMATCH >&2
    exit 1
  }
  http_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $COOLIFY_TOKEN" -X POST "$webhook")" || curl_status=$?
  if [[ "$curl_status" -ne 0 ]]; then
    outcome="UNKNOWN"
    http_status=""
  elif [[ "$http_status" =~ ^2[0-9][0-9]$ ]]; then
    outcome="ACCEPTED"
  elif [[ "$http_status" =~ ^4[0-9][0-9]$ ]]; then
    outcome="KNOWN_FAILED"
  else
    outcome="UNKNOWN"
  fi
  outcomes="$(jq -c --arg service "$service" --arg outcome "$outcome" --arg status "$http_status" \
    '. + [{service:$service, outcome:$outcome, http_status:($status | if . == "" then null else . end)}]' <<<"$outcomes")"
  # Evidence for a completed consequence survives a pointer change that forbids
  # the next independent request.
  persist_outcomes
}

attempt commerce "$COOLIFY_COMMERCE_DEPLOY_WEBHOOK_URL"
attempt frontend "$COOLIFY_FRONTEND_DEPLOY_WEBHOOK_URL"
