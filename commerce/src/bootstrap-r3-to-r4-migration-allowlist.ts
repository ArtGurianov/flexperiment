import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase } from "./db";
import { r3ToR4MigrationAllowlistBootstrap, requiredMigrationsFor, ReleaseControlError, ReleaseSalesGate } from "./release-control";

const databasePath = process.env.COMMERCE_DATABASE_PATH;
const expectedStateHash = process.env.COMMERCE_R3_R4_BOOTSTRAP_EXPECTED_STATE_HASH;

if (!databasePath || !existsSync(resolve(databasePath))) {
  throw new Error("COMMERCE_DATABASE_PATH must name the existing stopped-production SQLite database.");
}
if (process.env.COMMERCE_R3_R4_BOOTSTRAP_OFFLINE !== "SERVICES_STOPPED") {
  throw new Error("Set COMMERCE_R3_R4_BOOTSTRAP_OFFLINE=SERVICES_STOPPED only after Commerce and worker are stopped.");
}
if (process.env.COMMERCE_R3_R4_BOOTSTRAP_CONFIRM !== "R3-COMPLETE-TO-R4-DEPLOY-PAUSED") {
  throw new Error("Set COMMERCE_R3_R4_BOOTSTRAP_CONFIRM=R3-COMPLETE-TO-R4-DEPLOY-PAUSED to run this one-shot bootstrap.");
}
if (!expectedStateHash || !/^[a-f0-9]{64}$/.test(expectedStateHash)) {
  throw new Error("COMMERCE_R3_R4_BOOTSTRAP_EXPECTED_STATE_HASH must be the freshly read authoritative state hash.");
}
// Proves this exact checkout actually carries R4's fix before opening the
// database - a behavioral check on the real function this bootstrap relies
// on, rather than a file-hash pin, since the fix and this script are
// necessarily committed together (see the doc comment on
// r3ToR4MigrationAllowlistBootstrap for why a self-referential file hash
// does not apply here the way it does for the other bridges).
if (requiredMigrationsFor(r3ToR4MigrationAllowlistBootstrap.expected_migration) === undefined) {
  throw new Error("R3_R4_BOOTSTRAP_TARGET_MIGRATION_NOT_SUPPORTED");
}

const db = openDatabase(databasePath);
try {
  const result = new ReleaseSalesGate(db).bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: expectedStateHash });
  console.log(JSON.stringify({
    sales_paused: result.sales_paused,
    owner_release_id: result.owner_release_id,
    owner_mode: result.owner_mode,
    bootstrap: r3ToR4MigrationAllowlistBootstrap,
  }, null, 2));
} catch (error) {
  if (error instanceof ReleaseControlError) throw new Error(error.code);
  throw error;
} finally {
  db.close();
}
