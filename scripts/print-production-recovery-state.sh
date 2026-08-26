#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: print-production-recovery-state.sh [--api-url <url>] [--release-id <id>] [--container <id-or-name>]

Produces a redacted, read-only release-control snapshot. Set PUBLIC_API_URL and
COMMERCE_RELEASE_CONTROL_TOKEN in the environment, or pass --container to read
the token from exactly one existing Commerce container on the VPS.
EOF
}

api_url="${PUBLIC_API_URL:-}"
release_id=""
commerce_container=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-url) api_url="${2:-}"; shift 2 ;;
    --release-id) release_id="${2:-}"; shift 2 ;;
    --container) commerce_container="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "PRODUCTION_RECOVERY_STATE_INVALID_ARGUMENT" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$api_url" ]] || { echo "PRODUCTION_RECOVERY_STATE_API_URL_REQUIRED" >&2; exit 2; }
[[ "$api_url" =~ ^https?://[^[:space:]]+$ ]] || { echo "PRODUCTION_RECOVERY_STATE_API_URL_INVALID" >&2; exit 2; }
[[ -z "$release_id" || "$release_id" =~ ^[A-Za-z0-9._:-]+$ ]] || { echo "PRODUCTION_RECOVERY_STATE_RELEASE_ID_INVALID" >&2; exit 2; }
api_url="${api_url%/}"

select_commerce_container() {
  if [[ -n "$commerce_container" ]]; then
    printf '%s\n' "$commerce_container"
    return
  fi

  local candidates
  candidates="$(docker ps --format '{{.ID}}\t{{.Names}}' 2>/dev/null | awk -F '\t' '$2 ~ /(^|[-_])commerce([_-]|$)/ { print $1 }')" || {
    echo "PRODUCTION_RECOVERY_STATE_COMMERCE_CONTAINER_UNAVAILABLE" >&2
    return 1
  }
  local count
  count="$(printf '%s\n' "$candidates" | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "$count" == 1 ]] || {
    echo "PRODUCTION_RECOVERY_STATE_COMMERCE_CONTAINER_AMBIGUOUS" >&2
    return 1
  }
  printf '%s\n' "$candidates"
}

token="${COMMERCE_RELEASE_CONTROL_TOKEN:-}"
if [[ -z "$token" ]]; then
  selected_container="$(select_commerce_container)" || exit 1
  token="$(docker exec "$selected_container" printenv COMMERCE_RELEASE_CONTROL_TOKEN 2>/dev/null)" || {
    echo "PRODUCTION_RECOVERY_STATE_TOKEN_UNAVAILABLE" >&2
    exit 1
  }
fi
[[ -n "$token" && "$token" != *$'\n'* && "$token" != *$'\r'* ]] || {
  echo "PRODUCTION_RECOVERY_STATE_TOKEN_UNAVAILABLE" >&2
  exit 1
}

workspace="$(mktemp -d)"
trap 'rm -rf "$workspace"' EXIT
status_file="$workspace/status.json"
completion_file="$workspace/completion.json"

fetch_json() {
  local url="$1" destination="$2" label="$3"
  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
    -H "Authorization: Bearer $token" \
    --output "$destination" \
    "$url" || {
      echo "${label}_FETCH_FAILED" >&2
      return 1
    }
  jq -e 'type == "object"' "$destination" >/dev/null 2>&1 || {
    echo "${label}_INVALID_JSON" >&2
    return 1
  }
}

fetch_json "$api_url/v1/internal/release-control/status" "$status_file" "PRODUCTION_RECOVERY_STATE_STATUS" || exit 1
jq -e '
  type == "object"
  and (.sales_paused | type == "boolean")
  and (.owner_release_id == null or (.owner_release_id | type == "string" and length > 0))
  and (.owner_mode == null or (.owner_mode == "CONTROLLED_CUTOVER" or .owner_mode == "ROLLING"))
  and (.expected == null or (
    (.expected | type == "object")
    and (.expected.source_commit | type == "string" and test("^[0-9a-fA-F]{40}$"))
    and (.expected.migration | type == "string" and length > 0)
    and (.expected.legal_version | type == "string" and length > 0)
    and (.expected.legal_manifest_sha256 | type == "string" and test("^[0-9a-fA-F]{64}$"))
  ))
  and (.runtime | type == "object")
  and (.runtime.source_commit == null or (.runtime.source_commit | type == "string" and test("^[0-9a-fA-F]{40}$")))
  and (.runtime.worker_source_commit == null or (.runtime.worker_source_commit | type == "string" and test("^[0-9a-fA-F]{40}$")))
  and (.runtime.legal_version == null or (.runtime.legal_version | type == "string" and length > 0))
  and (.runtime.legal_manifest_sha256 == null or (.runtime.legal_manifest_sha256 | type == "string" and test("^[0-9a-fA-F]{64}$")))
  and (.runtime.current_legal_copies_match | type == "boolean")
' "$status_file" >/dev/null || {
  echo "PRODUCTION_RECOVERY_STATE_STATUS_FIELDS_INVALID" >&2
  exit 1
}

if [[ -z "$release_id" ]]; then
  release_id="$(jq -r '.owner_release_id // empty' "$status_file")"
fi

completion_json='null'
if [[ -n "$release_id" ]]; then
  fetch_json "$api_url/v1/internal/release-control/completion/$release_id" "$completion_file" "PRODUCTION_RECOVERY_STATE_COMPLETION" || exit 1
  jq -e '
    type == "object"
    and (.complete | type == "boolean")
    and (.expected == null or (.expected | type == "object"))
    and (.reopened_at == null or (.reopened_at | type == "string" and length > 0))
  ' "$completion_file" >/dev/null || {
    echo "PRODUCTION_RECOVERY_STATE_COMPLETION_FIELDS_INVALID" >&2
    exit 1
  }
  completion_json="$(jq -c '{ complete, expected, reopened_at }' "$completion_file")"
fi

jq -cn --slurpfile status "$status_file" --argjson completion "$completion_json" '
  $status[0] as $state |
  {
    sales_paused: $state.sales_paused,
    owner_release_id: $state.owner_release_id,
    owner_mode: $state.owner_mode,
    expected_source_commit: ($state.expected.source_commit // null),
    runtime_source_commit: $state.runtime.source_commit,
    worker_source_commit: $state.runtime.worker_source_commit,
    legal_version: $state.runtime.legal_version,
    legal_manifest_sha256: $state.runtime.legal_manifest_sha256,
    current_legal_copies_match: $state.runtime.current_legal_copies_match,
    completion: $completion
  }
'
