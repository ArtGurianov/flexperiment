#!/usr/bin/env bash
set -euo pipefail

# This script runs only on the Docker host that owns 0041's SQLite volume.
# It is deliberately not a Coolify webhook: the first ledger event is unknown
# to Gen1, so Commerce and its worker must be durably unable to restart before
# the bridge opens the database.

readonly GEN1_RUNTIME_SHA="68f80a411b7f286928ef10826ed225228098d246"
readonly GEN2_RUNTIME_SHA="0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34"
readonly MAIN_CONTROLLER_SHA="1f76c0eb73958e89356ff830036b8ef1c8b49c5b"
readonly BRIDGE_CONFIRMATION="STOP-GEN1-READERS-NO-RESTART-AND-BRIDGE"
readonly DATABASE_DESTINATION="/var/lib/flexperiment"
readonly DATABASE_NAME="commerce.sqlite"
readonly RECEIPT_NAME=".0041-gen1-to-gen2-offline-bridge.receipt"

[[ "${COMMERCE_GEN1_TO_GEN2_BRIDGE_STOP_CONFIRM:-}" == "$BRIDGE_CONFIRMATION" ]] || {
  echo "0041_OFFLINE_BRIDGE_STOP_CONFIRMATION_REQUIRED" >&2
  exit 1
}
expected_state_hash="${COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH:-}"
[[ "$expected_state_hash" =~ ^[a-f0-9]{64}$ ]] || {
  echo "0041_OFFLINE_BRIDGE_EXPECTED_STATE_HASH_INVALID" >&2
  exit 1
}
maintenance_artifact_sha="${COMMERCE_GEN1_TO_GEN2_BRIDGE_MAINTENANCE_ARTIFACT_SHA:-}"
[[ "$maintenance_artifact_sha" =~ ^[a-f0-9]{40}$ ]] || {
  echo "0041_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_SHA_INVALID" >&2
  exit 1
}
export COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH="$expected_state_hash"
export COMMERCE_GEN1_TO_GEN2_BRIDGE_MAINTENANCE_ARTIFACT_SHA="$maintenance_artifact_sha"

maintenance_worktree="$(git rev-parse --show-toplevel)"
[[ "$(git -C "$maintenance_worktree" rev-parse HEAD)" == "$maintenance_artifact_sha" ]] || {
  echo "0041_OFFLINE_BRIDGE_MAINTENANCE_ARTIFACT_MISMATCH" >&2
  exit 1
}
[[ "$(git -C "$maintenance_worktree" show -s --format=%P HEAD)" == "$MAIN_CONTROLLER_SHA $GEN2_RUNTIME_SHA" ]] || {
  echo "0041_OFFLINE_BRIDGE_MAINTENANCE_TOPOLOGY_INVALID" >&2
  exit 1
}
git -C "$maintenance_worktree" cat-file -e "$maintenance_artifact_sha:.release/maintenance-only" || {
  echo "0041_OFFLINE_BRIDGE_MAINTENANCE_MARKER_MISSING" >&2
  exit 1
}
git -C "$maintenance_worktree" diff --quiet && [[ -z "$(git -C "$maintenance_worktree" status --porcelain --untracked-files=all)" ]] || {
  echo "0041_OFFLINE_BRIDGE_MAINTENANCE_WORKTREE_DIRTY" >&2
  exit 1
}
cd "$maintenance_worktree"

commerce_container=""
worker_container=""
database_directory=""

container_environment_has() {
  local container_id="$1" expected="$2" environment
  environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id")"
  grep -Fqx "$expected" <<<"$environment"
}

container_volume_source() {
  local container_id="$1"
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/flexperiment"}}{{.Source}}{{end}}{{end}}' "$container_id"
}

discover_gen1_readers() {
  local container_id service_name volume_source
  commerce_container=""
  worker_container=""
  database_directory=""
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    service_name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container_id")"
    [[ "$service_name" == "commerce" || "$service_name" == "commerce-worker" ]] || continue
    container_environment_has "$container_id" "SOURCE_COMMIT=$GEN1_RUNTIME_SHA" || continue
    container_environment_has "$container_id" "COMMERCE_DATABASE_PATH=$DATABASE_DESTINATION/$DATABASE_NAME" || continue
    volume_source="$(container_volume_source "$container_id")"
    [[ -n "$volume_source" && -d "$volume_source" && -f "$volume_source/$DATABASE_NAME" ]] || {
      echo "0041_OFFLINE_BRIDGE_DATABASE_VOLUME_INVALID" >&2
      exit 1
    }
    case "$service_name" in
      commerce)
        [[ -z "$commerce_container" ]] || { echo "0041_OFFLINE_BRIDGE_COMMERCE_READER_AMBIGUOUS" >&2; exit 1; }
        commerce_container="$container_id"
        ;;
      commerce-worker)
        [[ -z "$worker_container" ]] || { echo "0041_OFFLINE_BRIDGE_WORKER_READER_AMBIGUOUS" >&2; exit 1; }
        worker_container="$container_id"
        ;;
    esac
    if [[ -z "$database_directory" ]]; then database_directory="$volume_source";
    elif [[ "$database_directory" != "$volume_source" ]]; then
      echo "0041_OFFLINE_BRIDGE_DATABASE_VOLUME_SPLIT" >&2
      exit 1
    fi
  done < <(docker ps --all --quiet)
  [[ -n "$commerce_container" && -n "$worker_container" && -n "$database_directory" ]] || {
    echo "0041_OFFLINE_BRIDGE_GEN1_READERS_NOT_EXACT" >&2
    exit 1
  }
}

assert_gen1_readers_stopped() {
  local container_id running restart_policy other_id other_source
  for container_id in "$commerce_container" "$worker_container"; do
    running="$(docker inspect --format '{{.State.Running}}' "$container_id")"
    restart_policy="$(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$container_id")"
    [[ "$running" == "false" ]] || { echo "0041_OFFLINE_BRIDGE_READER_STILL_RUNNING" >&2; exit 1; }
    [[ "$restart_policy" == "no" ]] || { echo "0041_OFFLINE_BRIDGE_RESTART_PATH_STILL_ENABLED" >&2; exit 1; }
  done
  # A stale additional container mounted against this exact volume is also a
  # ledger reader, even if it lacks the expected Compose service label.
  while IFS= read -r other_id; do
    [[ -n "$other_id" ]] || continue
    other_source="$(container_volume_source "$other_id")"
    [[ "$other_source" != "$database_directory" ]] || {
      echo "0041_OFFLINE_BRIDGE_UNEXPECTED_LIVE_DATABASE_READER" >&2
      exit 1
    }
  done < <(docker ps --quiet)
}

discover_gen1_readers
# Disable Docker's autonomous restart path before asking either process to
# stop. A failure half-way through containment leaves readers stopped or less
# restartable; it never reaches the bridge mutation.
docker update --restart=no "$commerce_container" "$worker_container" >/dev/null
for reader_container in "$commerce_container" "$worker_container"; do
  [[ "$(docker inspect --format '{{.State.Running}}' "$reader_container")" == "true" ]] || continue
  docker stop --time 30 "$reader_container" >/dev/null
done
assert_gen1_readers_stopped

bridge_result="$(mktemp)"
trap 'rm -f "$bridge_result"' EXIT
COMMERCE_DATABASE_PATH="$database_directory/$DATABASE_NAME" \
COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH="$expected_state_hash" \
COMMERCE_GEN1_TO_GEN2_BRIDGE_OFFLINE="GEN1_READERS_STOPPED_NO_RESTART" \
COMMERCE_GEN1_TO_GEN2_BRIDGE_CONFIRM="GEN1-CERTIFIED-TO-GEN2-PAUSED" \
node --import tsx commerce/src/gen1-to-gen2-post-activation-email-bridge.ts > "$bridge_result"
assert_gen1_readers_stopped

node - "$bridge_result" "$database_directory/$RECEIPT_NAME" <<'NODE'
const { closeSync, openSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const [resultPath, receiptPath] = process.argv.slice(2);
const result = JSON.parse(readFileSync(resultPath, "utf8"));
const bridge = result.bridge;
if (!result.state_hash?.match(/^[a-f0-9]{64}$/) || result.head?.candidate_generation !== 2 || result.head?.phase !== "PAUSED") {
  throw new Error("0041_OFFLINE_BRIDGE_RESULT_INVALID");
}
const receipt = [
  "schema_version=1",
  `release_id=${bridge.release_id}`,
  `gen1_source_commit=${bridge.from_source_commit}`,
  `gen2_source_commit=${bridge.to_source_commit}`,
  "candidate_generation=2",
  "phase=PAUSED",
  "authority_revision=7",
  `state_hash=${result.state_hash}`,
  `maintenance_artifact_sha=${process.env.COMMERCE_GEN1_TO_GEN2_BRIDGE_MAINTENANCE_ARTIFACT_SHA}`,
  `maintenance_worktree=${process.cwd()}`,
].join("\n") + "\n";
try {
  const handle = openSync(receiptPath, "wx", 0o600);
  writeFileSync(handle, receipt, { encoding: "utf8" });
  closeSync(handle);
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  if (readFileSync(receiptPath, "utf8") !== receipt) throw new Error("0041_OFFLINE_BRIDGE_RECEIPT_MISMATCH");
}
NODE

echo "0041_OFFLINE_BRIDGE_COMMITTED_AND_GEN1_READERS_STOPPED"
