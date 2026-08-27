import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { r4ToR5GenericOwnerRecovery, ReleaseControlError, ReleaseSalesGate } from "./release-control";

const databasePath = process.env.COMMERCE_DATABASE_PATH;
const expectedStateHash = process.env.COMMERCE_R4_R5_RECOVERY_EXPECTED_STATE_HASH;

if (!databasePath || !existsSync(resolve(databasePath))) {
  throw new Error("COMMERCE_DATABASE_PATH must name the existing production SQLite database.");
}
// This is the ordinary updateExpectations() implementation, but the
// currently-running R3 container cannot execute this specific call live:
// its own supportedMigrationExpectation() does not recognize
// 0036_tochka_provider_error_evidence.sql (the exact bug R4 fixed), so the
// same "must run from the fixed commit, not the running one" reasoning as
// the R3->R4 bootstrap applies here too - the OFFLINE contract is honored
// literally, not reinterpreted, regardless of how small the resulting write is.
if (process.env.COMMERCE_R4_R5_RECOVERY_OFFLINE !== "SERVICES_STOPPED") {
  throw new Error("Set COMMERCE_R4_R5_RECOVERY_OFFLINE=SERVICES_STOPPED only after Commerce and worker are stopped.");
}
if (process.env.COMMERCE_R4_R5_RECOVERY_CONFIRM !== "R4-PAUSED-OWNER-TO-R5-EXPECTATIONS") {
  throw new Error("Set COMMERCE_R4_R5_RECOVERY_CONFIRM=R4-PAUSED-OWNER-TO-R5-EXPECTATIONS to run this one-shot recovery.");
}
if (!expectedStateHash || !/^[a-f0-9]{64}$/.test(expectedStateHash)) {
  throw new Error("COMMERCE_R4_R5_RECOVERY_EXPECTED_STATE_HASH must be the freshly read authoritative promo-codes-v0 state hash.");
}

const db = openDatabase(databasePath);
try {
  const result = new ReleaseSalesGate(db).recoverGenericOwnerR4ToR5({ expected_state_hash: expectedStateHash });
  console.log(JSON.stringify({
    sales_paused: result.sales_paused,
    owner_release_id: result.owner_release_id,
    owner_mode: result.owner_mode,
    expected: result.expected,
    recovery: r4ToR5GenericOwnerRecovery,
  }, null, 2));
} catch (error) {
  if (error instanceof ReleaseControlError) throw new Error(error.code);
  throw error;
} finally {
  db.close();
}
