#!/usr/bin/env bash
set -euo pipefail

# One-shot 0041 recovery reader for the case where the stopped Gen1 container
# objects were removed after the bridge.  The volume identity is deliberately
# literal reviewed code, never a caller input or discovery result.
readonly GEN1_RUNTIME_SHA="68f80a411b7f286928ef10826ed225228098d246"
readonly GEN2_RUNTIME_SHA="0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34"
readonly DATABASE_VOLUME_NAME="jmawd0cmudtiwtquptyvhm0l_commerce-data"
readonly RECEIPT_NAME=".0041-gen1-to-gen2-offline-bridge.receipt"
expected_maintenance_artifact_sha="${COMMERCE_GEN1_TO_GEN2_BRIDGE_MAINTENANCE_ARTIFACT_SHA:-}"
[[ "$expected_maintenance_artifact_sha" =~ ^[a-f0-9]{40}$ ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_MAINTENANCE_ARTIFACT_SHA_INVALID" >&2; exit 1; }
node_bin="${COMMERCE_GEN1_TO_GEN2_BRIDGE_NODE_BIN:-}"
[[ "$node_bin" == /* && -x "$node_bin" ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_NODE_BIN_INVALID" >&2; exit 1; }

mapfile -t inspected_volumes < <(docker volume inspect --format '{{.Name}}|{{.Mountpoint}}' "$DATABASE_VOLUME_NAME")
[[ "${#inspected_volumes[@]}" == 1 ]] || { echo "0041_OFFLINE_PINNED_VOLUME_NOT_EXACT" >&2; exit 1; }
IFS='|' read -r inspected_volume_name database_directory <<<"${inspected_volumes[0]}"
[[ "$inspected_volume_name" == "$DATABASE_VOLUME_NAME" && "$database_directory" == /* && -d "$database_directory" ]] || {
  echo "0041_OFFLINE_PINNED_VOLUME_NOT_EXACT" >&2
  exit 1
}
[[ -f "$database_directory/commerce.sqlite" && -f "$database_directory/$RECEIPT_NAME" ]] || {
  echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_OR_DATABASE_MISSING" >&2
  exit 1
}

# No running process may have this exact volume mounted, whether Docker reports
# it by named-volume identity or by the inspected host mountpoint.
while IFS= read -r running_container; do
  [[ -n "$running_container" ]] || continue
  while IFS='|' read -r mounted_name mounted_source; do
    [[ "$mounted_name" != "$DATABASE_VOLUME_NAME" && "$mounted_source" != "$database_directory" ]] || {
      echo "0041_OFFLINE_PINNED_VOLUME_LIVE_READER" >&2
      exit 1
    }
  done < <(docker inspect --format '{{range .Mounts}}{{printf "%s|%s\n" .Name .Source}}{{end}}' "$running_container")
done < <(docker ps --quiet)

receipt="$database_directory/$RECEIPT_NAME"
[[ "$(stat -c '%u:%a' "$receipt")" == "0:600" ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_PERMISSIONS_INVALID" >&2; exit 1; }
field() { awk -F= -v key="$1" '$1 == key { if (++matches != 1) exit 1; print substr($0, length(key) + 2) } END { if (matches != 1) exit 1 }' "$receipt"; }
[[ "$(field schema_version)" == 1 && "$(field release_id)" == "outbox-attempt-authority-v1:$GEN1_RUNTIME_SHA" && "$(field gen1_source_commit)" == "$GEN1_RUNTIME_SHA" && "$(field gen2_source_commit)" == "$GEN2_RUNTIME_SHA" && "$(field candidate_generation)" == 2 && "$(field phase)" == PAUSED && "$(field authority_revision)" == 7 ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_CONTENT_INVALID" >&2; exit 1; }
[[ "$(field state_hash)" =~ ^[a-f0-9]{64}$ ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_STATE_HASH_INVALID" >&2; exit 1; }
[[ "$(field maintenance_artifact_sha)" == "$expected_maintenance_artifact_sha" ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_MAINTENANCE_ARTIFACT_MISMATCH" >&2; exit 1; }
[[ "$(wc -l < "$receipt" | tr -d ' ')" == 10 ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_SHAPE_INVALID" >&2; exit 1; }
maintenance_worktree="$(field maintenance_worktree)"
[[ "$maintenance_worktree" == /* && "$(git -C "$maintenance_worktree" rev-parse HEAD)" == "$expected_maintenance_artifact_sha" ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_MAINTENANCE_WORKTREE_INVALID" >&2; exit 1; }
[[ "$(git -C "$maintenance_worktree" show -s --format=%P HEAD)" == "1f76c0eb73958e89356ff830036b8ef1c8b49c5b $GEN2_RUNTIME_SHA" ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_MAINTENANCE_TOPOLOGY_INVALID" >&2; exit 1; }
git -C "$maintenance_worktree" cat-file -e "$expected_maintenance_artifact_sha:.release/maintenance-only" || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_MAINTENANCE_MARKER_MISSING" >&2; exit 1; }
git -C "$maintenance_worktree" diff --quiet && [[ -z "$(git -C "$maintenance_worktree" status --porcelain --untracked-files=all)" ]] || { echo "0041_OFFLINE_PINNED_VOLUME_RECEIPT_MAINTENANCE_WORKTREE_DIRTY" >&2; exit 1; }
cd "$maintenance_worktree"
COMMERCE_DATABASE_PATH="$database_directory/commerce.sqlite" \
COMMERCE_GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH="$(field state_hash)" \
"$node_bin" --import tsx commerce/src/assert-gen1-to-gen2-offline-bridge.ts >/dev/null
echo "0041_OFFLINE_BRIDGE_RECEIPT_VALID"
