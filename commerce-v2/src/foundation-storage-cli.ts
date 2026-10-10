import { readBuildIdentity } from "./build-identity";
import { openV2Database } from "./db";
import { backupFoundation, markDurability, verifyDurability } from "./foundation-storage";

// Runs through owner SSH/docker exec, not through a new public mutation endpoint.
async function main() {
  if (process.env.COMMERCE_V2_FOUNDATION_MODE !== "true" || process.env.PAYMENT_MODE !== "disabled") throw new Error("FOUNDATION_STORAGE_FORBIDDEN");
  if (process.env.COMMERCE_V2_DATABASE_PATH !== "/var/lib/flexperiment-v2/commerce.sqlite") throw new Error("FOUNDATION_DATABASE_PATH_REQUIRED");
  const environment = process.env.COMMERCE_V2_ENVIRONMENT;
  if (environment !== "canary" && environment !== "production") throw new Error("FOUNDATION_ENVIRONMENT_REQUIRED");
  if (process.env.BUILD_IDENTITY_FILE !== "/app/.identity/identity.json") throw new Error("FOUNDATION_BAKED_IDENTITY_REQUIRED");
  const identity = readBuildIdentity("commerce-v2");
  const db = openV2Database();
  const context: { environment: "canary" | "production"; sourceCommit: string } = { environment, sourceCommit: identity.sourceCommit };
  try {
    const [command, id] = process.argv.slice(2);
    if (command === "mark") console.log(JSON.stringify({ marker: markDurability(db, context) }));
    else if (command === "verify" && /^[0-9a-f-]{36}$/.test(id ?? "")) {
      verifyDurability(db, context, id); console.log(JSON.stringify({ durability: "PASS" }));
    } else if (command === "backup") {
      if (process.env.COMMERCE_V2_BACKUP_PATH !== "/var/lib/flexperiment-v2-backups") throw new Error("FOUNDATION_BACKUP_PATH_REQUIRED");
      console.log(JSON.stringify(await backupFoundation(db, context, process.env.COMMERCE_V2_BACKUP_PATH, process.env.COMMERCE_V2_BACKUP_AGE_RECIPIENT ?? "")));
    } else throw new Error("FOUNDATION_STORAGE_COMMAND_INVALID");
  } finally { db.close(); }
}
main().catch(() => { console.error("FOUNDATION_STORAGE_REFUSED"); process.exitCode = 1; });
