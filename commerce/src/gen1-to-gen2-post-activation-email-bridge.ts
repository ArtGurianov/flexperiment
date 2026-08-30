import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { gen1PostActivationEmailToGen2Bridge, ReleaseControlError, ReleaseSalesGate } from "./release-control";

const databasePath = process.env.COMMERCE_DATABASE_PATH;
const expectedStateHash = process.env.COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH;
const bridge = gen1PostActivationEmailToGen2Bridge;

if (!databasePath || !existsSync(resolve(databasePath))) {
  throw new Error("COMMERCE_DATABASE_PATH must name the existing stopped-production SQLite database.");
}
if (process.env.COMMERCE_GEN1_TO_GEN2_BRIDGE_OFFLINE !== "GEN1_READERS_STOPPED_NO_RESTART") {
  throw new Error("Set COMMERCE_GEN1_TO_GEN2_BRIDGE_OFFLINE=GEN1_READERS_STOPPED_NO_RESTART only after every gen1 ledger/DB reader and writer is stopped and its restart path is disabled.");
}
if (process.env.COMMERCE_GEN1_TO_GEN2_BRIDGE_CONFIRM !== "GEN1-CERTIFIED-TO-GEN2-PAUSED") {
  throw new Error("Set COMMERCE_GEN1_TO_GEN2_BRIDGE_CONFIRM=GEN1-CERTIFIED-TO-GEN2-PAUSED to run this one-shot bridge.");
}
if (!expectedStateHash || !/^[a-f0-9]{64}$/.test(expectedStateHash)) {
  throw new Error("COMMERCE_GEN1_TO_GEN2_BRIDGE_EXPECTED_STATE_HASH must be the freshly read authoritative state hash.");
}

// The bridge executes its local replay implementation, so pin and compare the
// entire executed semantic closure against literal Gen2 Git objects.  Checking
// only the future parser would let a maintenance-only dependency silently
// reinterpret the same durable event chain.
for (const [file, expectedHash] of Object.entries(bridge.target_replay_closure_sha256)) {
  let target: Buffer;
  try { target = execFileSync("git", ["show", `${bridge.to_source_commit}:${file}`]); }
  catch { throw new Error("GEN1_TO_GEN2_BRIDGE_TARGET_REPLAY_SOURCE_UNAVAILABLE"); }
  const targetHash = createHash("sha256").update(target).digest("hex");
  if (targetHash !== expectedHash) throw new Error("GEN1_TO_GEN2_BRIDGE_TARGET_REPLAY_SOURCE_MISMATCH");
  if (!existsSync(resolve(file)) || createHash("sha256").update(readFileSync(resolve(file))).digest("hex") !== expectedHash) {
    throw new Error("GEN1_TO_GEN2_BRIDGE_MAINTENANCE_REPLAY_CLOSURE_MISMATCH");
  }
}

const db = openDatabase(databasePath);
try {
  const result = new ReleaseSalesGate(db).bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: expectedStateHash });
  console.log(JSON.stringify({ ...result, bridge }));
} catch (error) {
  if (error instanceof ReleaseControlError) throw new Error(error.code);
  throw error;
} finally {
  db.close();
}
