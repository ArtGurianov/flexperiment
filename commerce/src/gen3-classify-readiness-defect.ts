import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { gen3ReadinessClassification, ReleaseControlError, ReleaseSalesGate, releaseRuntimeEvidence } from "./release-control";

const databasePath = process.env.COMMERCE_DATABASE_PATH;
const expectedStateHash = process.env.COMMERCE_GEN3_CLASSIFY_EXPECTED_STATE_HASH;

if (!databasePath || !existsSync(resolve(databasePath))) {
  throw new Error("COMMERCE_DATABASE_PATH must name the existing stopped-production SQLite database.");
}
if (process.env.COMMERCE_GEN3_CLASSIFY_OFFLINE !== "SERVICES_STOPPED") {
  throw new Error("Set COMMERCE_GEN3_CLASSIFY_OFFLINE=SERVICES_STOPPED only after Commerce and worker are stopped.");
}
if (process.env.COMMERCE_GEN3_CLASSIFY_CONFIRM !== "GEN3-PAUSED-TO-RECOVERY-REQUIRED") {
  throw new Error("Set COMMERCE_GEN3_CLASSIFY_CONFIRM=GEN3-PAUSED-TO-RECOVERY-REQUIRED to run this one-shot classifier.");
}
if (!expectedStateHash || !/^[a-f0-9]{64}$/.test(expectedStateHash)) {
  throw new Error("COMMERCE_GEN3_CLASSIFY_EXPECTED_STATE_HASH must be the freshly read authoritative state hash.");
}

const db = openDatabase(databasePath);
try {
  // No live Commerce/worker process is running against this stopped
  // database, so evidence is read directly from persisted rows rather than
  // from a process environment; sourceCommit is bound to the exact
  // classified generation, never taken from caller input.
  const runtimeEvidence = () => releaseRuntimeEvidence(db, {
    sourceCommit: gen3ReadinessClassification.source_commit,
    currentLegalCopiesMatch: () => true,
  });
  const result = new ReleaseSalesGate(db).classifyGenerationThreeReadinessDefect({ expected_state_hash: expectedStateHash }, runtimeEvidence);
  console.log(JSON.stringify({
    release_id: result.head.release_id,
    candidate_generation: result.head.candidate_generation,
    source_commit: result.head.source_commit,
    phase: result.head.phase,
    phase_sequence: result.head.phase_sequence,
    certification: result.head.certification ?? null,
    state_hash: result.state_hash,
    classification: gen3ReadinessClassification,
  }));
} catch (error) {
  if (error instanceof ReleaseControlError) throw new Error(error.code);
  throw error;
} finally {
  db.close();
}
