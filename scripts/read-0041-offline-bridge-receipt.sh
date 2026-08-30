#!/usr/bin/env bash
set -euo pipefail

# Sent over SSH by the deploy controller. It performs no mutation and reads no
# runtime API: at this point the only valid Gen1 containers are stopped ones
# retained solely to locate the durable SQLite volume.
readonly GEN1_RUNTIME_SHA="68f80a411b7f286928ef10826ed225228098d246"
readonly GEN2_RUNTIME_SHA="0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34"
readonly DATABASE_DESTINATION="/var/lib/flexperiment"
readonly RECEIPT_NAME=".0041-gen1-to-gen2-offline-bridge.receipt"
expected_maintenance_artifact_sha="${COMMERCE_GEN1_TO_GEN2_BRIDGE_MAINTENANCE_ARTIFACT_SHA:-}"
[[ "$expected_maintenance_artifact_sha" =~ ^[a-f0-9]{40}$ ]] || { echo "0041_OFFLINE_RECEIPT_MAINTENANCE_ARTIFACT_SHA_INVALID" >&2; exit 1; }
node_bin="${COMMERCE_GEN1_TO_GEN2_BRIDGE_NODE_BIN:-}"
[[ "$node_bin" == /* && -x "$node_bin" ]] || { echo "0041_OFFLINE_RECEIPT_NODE_BIN_INVALID" >&2; exit 1; }

database_directory=""
commerce_count=0
worker_count=0
while IFS= read -r container_id; do
  [[ -n "$container_id" ]] || continue
  service_name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")"
  [[ "$service_name" == "commerce" || "$service_name" == "commerce-worker" ]] || continue
  environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")"
  grep -Fqx "SOURCE_COMMIT=$GEN1_RUNTIME_SHA" <<<"$environment" || continue
  grep -Fqx "COMMERCE_DATABASE_PATH=$DATABASE_DESTINATION/commerce.sqlite" <<<"$environment" || continue
  [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" == "false" ]] || { echo "0041_OFFLINE_RECEIPT_GEN1_READER_RUNNING" >&2; exit 1; }
  [[ "$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container_id")" == "no" ]] || { echo "0041_OFFLINE_RECEIPT_RESTART_PATH_ENABLED" >&2; exit 1; }
  volume_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/flexperiment"}}{{.Source}}{{end}}{{end}}' "$container_id")"
  [[ -n "$volume_source" && -f "$volume_source/commerce.sqlite" ]] || { echo "0041_OFFLINE_RECEIPT_DATABASE_VOLUME_INVALID" >&2; exit 1; }
  if [[ -z "$database_directory" ]]; then database_directory="$volume_source";
  elif [[ "$database_directory" != "$volume_source" ]]; then echo "0041_OFFLINE_RECEIPT_DATABASE_VOLUME_SPLIT" >&2; exit 1; fi
  case "$service_name" in commerce) commerce_count=$((commerce_count + 1));; commerce-worker) worker_count=$((worker_count + 1));; esac
done < <(docker ps --all --quiet)
[[ "$commerce_count" == 1 && "$worker_count" == 1 ]] || { echo "0041_OFFLINE_RECEIPT_GEN1_READERS_NOT_EXACT" >&2; exit 1; }
while IFS= read -r running_container; do
  [[ -n "$running_container" ]] || continue
  running_source="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/flexperiment"}}{{.Source}}{{end}}{{end}}' "$running_container")"
  [[ "$running_source" != "$database_directory" ]] || { echo "0041_OFFLINE_RECEIPT_LIVE_DATABASE_READER" >&2; exit 1; }
done < <(docker ps --quiet)

receipt="$database_directory/$RECEIPT_NAME"
[[ -f "$receipt" ]] || { echo "0041_OFFLINE_RECEIPT_MISSING" >&2; exit 1; }
[[ "$(stat -c '%u:%a' "$receipt")" == "0:600" ]] || { echo "0041_OFFLINE_RECEIPT_PERMISSIONS_INVALID" >&2; exit 1; }
field() { awk -F= -v key="$1" '$1 == key { if (++matches != 1) exit 1; print substr($0, length(key) + 2) } END { if (matches != 1) exit 1 }' "$receipt"; }
[[ "$(field schema_version)" == 1 && "$(field release_id)" == "outbox-attempt-authority-v1:$GEN1_RUNTIME_SHA" && "$(field gen1_source_commit)" == "$GEN1_RUNTIME_SHA" && "$(field gen2_source_commit)" == "$GEN2_RUNTIME_SHA" && "$(field candidate_generation)" == 2 && "$(field phase)" == PAUSED && "$(field authority_revision)" == 7 ]] || { echo "0041_OFFLINE_RECEIPT_CONTENT_INVALID" >&2; exit 1; }
[[ "$(field state_hash)" =~ ^[a-f0-9]{64}$ ]] || { echo "0041_OFFLINE_RECEIPT_STATE_HASH_INVALID" >&2; exit 1; }
[[ "$(field maintenance_artifact_sha)" == "$expected_maintenance_artifact_sha" ]] || { echo "0041_OFFLINE_RECEIPT_MAINTENANCE_ARTIFACT_MISMATCH" >&2; exit 1; }
maintenance_worktree="$(field maintenance_worktree)"
[[ "$maintenance_worktree" == /* && "$(git -C "$maintenance_worktree" rev-parse HEAD)" == "$expected_maintenance_artifact_sha" ]] || { echo "0041_OFFLINE_RECEIPT_MAINTENANCE_WORKTREE_INVALID" >&2; exit 1; }
[[ "$(git -C "$maintenance_worktree" show -s --format=%P HEAD)" == "1f76c0eb73958e89356ff830036b8ef1c8b49c5b $GEN2_RUNTIME_SHA" ]] || { echo "0041_OFFLINE_RECEIPT_MAINTENANCE_TOPOLOGY_INVALID" >&2; exit 1; }
git -C "$maintenance_worktree" cat-file -e "$expected_maintenance_artifact_sha:.release/maintenance-only" || { echo "0041_OFFLINE_RECEIPT_MAINTENANCE_MARKER_MISSING" >&2; exit 1; }
git -C "$maintenance_worktree" diff --quiet && [[ -z "$(git -C "$maintenance_worktree" status --porcelain --untracked-files=all)" ]] || { echo "0041_OFFLINE_RECEIPT_MAINTENANCE_WORKTREE_DIRTY" >&2; exit 1; }
cd "$maintenance_worktree"
COMMERCE_DATABASE_PATH="$database_directory/commerce.sqlite" \
COMMERCE_GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH="$(field state_hash)" \
"$node_bin" --import tsx commerce/src/assert-gen1-to-gen2-offline-bridge.ts >/dev/null
[[ "$(wc -l < "$receipt" | tr -d ' ')" == 10 ]] || { echo "0041_OFFLINE_RECEIPT_SHAPE_INVALID" >&2; exit 1; }
echo "0041_OFFLINE_BRIDGE_RECEIPT_VALID"
