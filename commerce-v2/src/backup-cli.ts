import Database from "better-sqlite3";
import { readBuildIdentity } from "./build-identity";
import { backupFoundation } from "./foundation-storage";

export function openBackupSource(filename: string) {
  return new Database(filename, { readonly: true, fileMustExist: true });
}

/** Separate from the writable foundation durability/migration commands. */
export async function backupRuntime(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const target = environment.COMMERCE_V2_ENVIRONMENT;
  if (target !== "canary" && target !== "production") throw new Error("V2_BACKUP_ENVIRONMENT_REQUIRED");
  if (environment.COMMERCE_V2_DATABASE_PATH !== "/var/lib/flexperiment-v2/commerce.sqlite"
    || environment.COMMERCE_V2_BACKUP_PATH !== "/var/lib/flexperiment-v2-backups"
    || environment.BUILD_IDENTITY_FILE !== "/app/.identity/identity.json") throw new Error("V2_BACKUP_PATH_REQUIRED");
  const identity = readBuildIdentity("commerce-v2", environment);
  const db = openBackupSource(environment.COMMERCE_V2_DATABASE_PATH);
  try {
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 5000");
    return await backupFoundation(db, { environment: target, sourceCommit: identity.sourceCommit },
      environment.COMMERCE_V2_BACKUP_PATH, environment.COMMERCE_V2_BACKUP_AGE_RECIPIENT ?? "");
  } finally { db.close(); }
}

// Importing the module for tests does not run the operator command.
if (process.argv[1]?.endsWith("/backup-cli.ts")) {
  backupRuntime().then((proof) => console.log(JSON.stringify(proof))).catch(() => {
    console.error("V2_BACKUP_REFUSED"); process.exitCode = 1;
  });
}
