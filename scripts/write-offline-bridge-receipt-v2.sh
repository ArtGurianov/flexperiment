#!/usr/bin/env bash
set -euo pipefail

# Future offline bridges call this only after their own reviewed controller has
# proved the storage substrate. The volume variables are controller-owned
# evidence outputs, never workflow_dispatch inputs. This helper repeats Docker
# inspection so a copied/mismatched mountpoint cannot become a receipt locator.
receipt_id="${COMMERCE_OFFLINE_BRIDGE_RECEIPT_ID:-}"
volume_name="${COMMERCE_OFFLINE_BRIDGE_VERIFIED_DATABASE_VOLUME_NAME:-}"
database_directory="${COMMERCE_OFFLINE_BRIDGE_VERIFIED_DATABASE_DIRECTORY:-}"
database_destination="${COMMERCE_OFFLINE_BRIDGE_DATABASE_DESTINATION:-}"
node_bin="${COMMERCE_OFFLINE_BRIDGE_RECEIPT_NODE_BIN:-}"

[[ "$receipt_id" =~ ^[a-z0-9][a-z0-9-]{2,80}$ && "$receipt_id" != *..* && "$receipt_id" != */* ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_ID_INVALID" >&2; exit 1; }
readonly RECEIPT_NAME=".offline-bridge-${receipt_id}.receipt"
[[ "$volume_name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$ ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_VOLUME_INVALID" >&2; exit 1; }
[[ "$database_directory" == /* && "$database_destination" == /* ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_DATABASE_PATH_INVALID" >&2; exit 1; }
[[ "$node_bin" == /* && -x "$node_bin" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_NODE_BIN_INVALID" >&2; exit 1; }

mapfile -t inspected < <(docker volume inspect --format '{{.Name}}|{{.Mountpoint}}' "$volume_name")
[[ "${#inspected[@]}" == 1 ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_VOLUME_NOT_EXACT" >&2; exit 1; }
IFS='|' read -r inspected_name inspected_directory <<<"${inspected[0]}"
[[ "$inspected_name" == "$volume_name" && "$inspected_directory" == "$database_directory" && -f "$database_directory/commerce.sqlite" ]] || {
  echo "OFFLINE_BRIDGE_RECEIPT_V2_SUBSTRATE_MISMATCH" >&2
  exit 1
}

for value in RELEASE_ID GEN1_SOURCE_COMMIT GEN2_SOURCE_COMMIT CANDIDATE_GENERATION PHASE AUTHORITY_REVISION STATE_HASH MAINTENANCE_ARTIFACT_SHA MAINTENANCE_WORKTREE; do
  [[ -n "${!value:-}" ]] || { echo "OFFLINE_BRIDGE_RECEIPT_V2_${value}_REQUIRED" >&2; exit 1; }
done
export RECEIPT_NAME receipt_id volume_name database_destination database_directory
"$node_bin" - <<'NODE'
const { closeSync, openSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const requiredCommit = (value, name) => {
  if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw new Error(`OFFLINE_BRIDGE_RECEIPT_V2_${name}_INVALID`);
  return value;
};
const requiredStateHash = (value) => {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error("OFFLINE_BRIDGE_RECEIPT_V2_STATE_HASH_INVALID");
  return value;
};
const integer = (value, name) => {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) throw new Error(`OFFLINE_BRIDGE_RECEIPT_V2_${name}_INVALID`);
  return value;
};
const fields = [
  ["schema_version", "2"],
  ["bridge_receipt_id", process.env.receipt_id],
  ["release_id", process.env.RELEASE_ID],
  ["gen1_source_commit", requiredCommit(process.env.GEN1_SOURCE_COMMIT, "GEN1_SOURCE_COMMIT")],
  ["gen2_source_commit", requiredCommit(process.env.GEN2_SOURCE_COMMIT, "GEN2_SOURCE_COMMIT")],
  ["candidate_generation", integer(process.env.CANDIDATE_GENERATION, "CANDIDATE_GENERATION")],
  ["phase", process.env.PHASE],
  ["authority_revision", integer(process.env.AUTHORITY_REVISION, "AUTHORITY_REVISION")],
  ["state_hash", requiredStateHash(process.env.STATE_HASH)],
  ["maintenance_artifact_sha", requiredCommit(process.env.MAINTENANCE_ARTIFACT_SHA, "MAINTENANCE_ARTIFACT_SHA")],
  ["maintenance_worktree", process.env.MAINTENANCE_WORKTREE],
  ["database_storage_kind", "docker_volume"],
  ["database_volume_name", process.env.volume_name],
  ["database_destination", process.env.database_destination],
];
if (!fields.every(([, value]) => typeof value === "string" && value.length > 0)) throw new Error("OFFLINE_BRIDGE_RECEIPT_V2_CONTENT_INVALID");
const receipt = fields.map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
const receiptPath = join(process.env.database_directory, process.env.RECEIPT_NAME);
try {
  const handle = openSync(receiptPath, "wx", 0o600);
  writeFileSync(handle, receipt, { encoding: "utf8" });
  closeSync(handle);
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  if (readFileSync(receiptPath, "utf8") !== receipt) throw new Error("OFFLINE_BRIDGE_RECEIPT_V2_MISMATCH");
}
NODE

echo "OFFLINE_BRIDGE_RECEIPT_V2_WRITTEN"
