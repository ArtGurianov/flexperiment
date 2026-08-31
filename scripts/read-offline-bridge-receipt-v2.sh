#!/usr/bin/env bash
set -euo pipefail

# A future controller binds this exact name in reviewed code and exports it as
# evidence, never as an operator-supplied dispatch input. The receipt must bind
# back to that same durable storage identity; there is no volume scan or SQLite
# discovery fallback.
receipt_id="${COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID:-}"
expected_volume_name="${COMMERCE_OFFLINE_BRIDGE_RECEIPT_VOLUME_NAME:-}"
node_bin="${COMMERCE_OFFLINE_BRIDGE_RECEIPT_NODE_BIN:-}"
verifier_path="${COMMERCE_OFFLINE_BRIDGE_RECEIPT_VERIFIER_PATH:-}"

[[ "$receipt_id" =~ ^[a-z0-9][a-z0-9-]{2,80}$ && "$receipt_id" != *..* && "$receipt_id" != */* ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_ID_INVALID" >&2; exit 1; }
readonly RECEIPT_NAME=".offline-bridge-${receipt_id}.receipt"
[[ "$expected_volume_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$ ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_EXPECTED_VOLUME_INVALID" >&2; exit 1; }
[[ "$node_bin" == /* && -x "$node_bin" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_NODE_BIN_INVALID" >&2; exit 1; }
[[ "$verifier_path" == /* && -f "$verifier_path" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_VERIFIER_INVALID" >&2; exit 1; }

mapfile -t inspected < <(docker volume inspect --format '{{.Name}}|{{.Mountpoint}}' "$expected_volume_name")
[[ "${#inspected[@]}" == 1 ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_VOLUME_NOT_EXACT" >&2; exit 1; }
IFS='|' read -r inspected_name database_directory <<<"${inspected[0]}"
[[ "$inspected_name" == "$expected_volume_name" && "$database_directory" == /* && -d "$database_directory" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_VOLUME_NOT_EXACT" >&2; exit 1; }
receipt="$database_directory/$RECEIPT_NAME"
[[ -f "$database_directory/commerce.sqlite" && -f "$receipt" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_RECEIPT_OR_DATABASE_MISSING" >&2; exit 1; }

# A stopped original container is optional evidence. A live mount is always a
# reader and therefore blocks the read-only proof before SQLite is opened.
while IFS= read -r running_container; do
  [[ -n "$running_container" ]] || continue
  while IFS='|' read -r mounted_name mounted_source; do
    [[ "$mounted_name" != "$expected_volume_name" && "$mounted_source" != "$database_directory" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_LIVE_MOUNT" >&2; exit 1; }
  done < <(docker inspect --format '{{range .Mounts}}{{printf "%s|%s\n" .Name .Source}}{{end}}' "$running_container")
done < <(docker ps --quiet)

[[ "$(stat -c '%u:%a' "$receipt")" == "0:600" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_PERMISSIONS_INVALID" >&2; exit 1; }
field() { awk -F= -v key="$1" '$1 == key { if (++matches != 1) exit 1; print substr($0, length(key) + 2) } END { if (matches != 1) exit 1 }' "$receipt"; }
[[ "$(field schema_version)" == 2 && "$(field bridge_receipt_id)" == "$receipt_id" && "$(field database_storage_kind)" == docker_volume && "$(field database_volume_name)" == "$expected_volume_name" && "$(field database_destination)" == /* ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_CONTENT_INVALID" >&2; exit 1; }
[[ "$(field state_hash)" =~ ^[a-f0-9]{64}$ ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_STATE_HASH_INVALID" >&2; exit 1; }

COMMERCE_DATABASE_PATH="$database_directory/commerce.sqlite" \
COMMERCE_OFFLINE_BRIDGE_RECEIPT_STATE_HASH="$(field state_hash)" \
"$node_bin" --import tsx "$verifier_path" >/dev/null
echo "OFFLINE_BRIDGE_RECEIPT_V2_VALID"
