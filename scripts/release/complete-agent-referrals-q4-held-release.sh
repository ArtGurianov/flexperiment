#!/usr/bin/env bash
# Executes the sole terminalization consequence for the already-held Q4 owner.
# It deliberately never retries: the controller reconciles UNKNOWN from durable
# completion/status evidence instead.
set -euo pipefail

: "${COMMERCE_RELEASE_CONTROL_TOKEN:?COMMERCE_RELEASE_CONTROL_TOKEN is required}"
: "${PUBLIC_API_URL:?PUBLIC_API_URL is required}"
: "${Q4_RELEASE_REQUEST:?Q4_RELEASE_REQUEST is required}"
: "${Q4_COMPLETION_OUTCOME:?Q4_COMPLETION_OUTCOME is required}"

umask 077
mkdir -p "$(dirname "$Q4_COMPLETION_OUTCOME")"
response="${Q4_COMPLETION_OUTCOME}.response"
status=""
curl_status=0
status="$(curl --silent --show-error --output "$response" --write-out '%{http_code}' \
  --connect-timeout 10 --max-time 30 \
  -H "Authorization: Bearer $COMMERCE_RELEASE_CONTROL_TOKEN" \
  -H 'Content-Type: application/json' \
  -X POST --data-binary "@$Q4_RELEASE_REQUEST" \
  "$PUBLIC_API_URL/v1/internal/release-control/complete-rolling")" || curl_status=$?

outcome="UNKNOWN"
if [[ "$curl_status" -eq 0 && "$status" =~ ^2[0-9][0-9]$ ]] && jq -e . "$response" >/dev/null 2>&1; then
  outcome="ACCEPTED"
elif [[ "$curl_status" -eq 0 && "$status" =~ ^4[0-9][0-9]$ ]]; then
  outcome="KNOWN_FAILED"
fi
temporary="${Q4_COMPLETION_OUTCOME}.tmp"
jq -nc --arg outcome "$outcome" --arg status "$status" \
  '{outcome:$outcome,http_status:($status | if . == "" then null else . end)}' > "$temporary"
mv "$temporary" "$Q4_COMPLETION_OUTCOME"

[[ "$outcome" != "KNOWN_FAILED" ]] || {
  echo AGENT_REFERRALS_Q4_COMPLETE_KNOWN_FAILED >&2
  exit 1
}
