import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { gen4PublicFrontendRecoveryBridge, ReleaseControlError, ReleaseSalesGate } from "./release-control";

const databasePath = process.env.COMMERCE_DATABASE_PATH;
const expectedStateHash = process.env.COMMERCE_GEN4_BRIDGE_EXPECTED_STATE_HASH;

if (!databasePath || !existsSync(resolve(databasePath))) {
  throw new Error("COMMERCE_DATABASE_PATH must name the existing stopped-production SQLite database.");
}
if (process.env.COMMERCE_GEN4_BRIDGE_OFFLINE !== "SERVICES_STOPPED") {
  throw new Error("Set COMMERCE_GEN4_BRIDGE_OFFLINE=SERVICES_STOPPED only after Commerce and worker are stopped.");
}
if (process.env.COMMERCE_GEN4_BRIDGE_CONFIRM !== "GEN4-CERTIFIED-TO-GEN5-PAUSED") {
  throw new Error("Set COMMERCE_GEN4_BRIDGE_CONFIRM=GEN4-CERTIFIED-TO-GEN5-PAUSED to run this one-shot bridge.");
}
if (!expectedStateHash || !/^[a-f0-9]{64}$/.test(expectedStateHash)) {
  throw new Error("COMMERCE_GEN4_BRIDGE_EXPECTED_STATE_HASH must be the freshly read authoritative state hash.");
}
if (createHash("sha256").update(readFileSync(resolve(process.cwd(), "commerce/src/release-generation.ts"))).digest("hex") !== gen4PublicFrontendRecoveryBridge.target_replay_sha256) {
  throw new Error("GEN4_BRIDGE_TARGET_REPLAY_SOURCE_MISMATCH");
}

const db = openDatabase(databasePath);
try {
  const result = new ReleaseSalesGate(db).bridgeGenerationFourToFive({ expected_state_hash: expectedStateHash });
  console.log(JSON.stringify({
    release_id: result.head.release_id,
    candidate_generation: result.head.candidate_generation,
    source_commit: result.head.source_commit,
    phase: result.head.phase,
    phase_sequence: result.head.phase_sequence,
    certification: result.head.certification ?? null,
    state_hash: result.state_hash,
    bridge: gen4PublicFrontendRecoveryBridge,
  }));
} catch (error) {
  if (error instanceof ReleaseControlError) throw new Error(error.code);
  throw error;
} finally {
  db.close();
}
