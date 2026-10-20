import type Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readV2Migrations, migrationSha256 } from "../../src/migration-integrity";

export function writeMigrationBundle(directory: string, entries: Record<string, string>) {
  for (const [version, sql] of Object.entries(entries)) writeFileSync(join(directory, version), sql);
  writeFileSync(join(directory, "migration.lock"), JSON.stringify({
    version: 1, lineage: "flexperiment-v2",
    migrations: Object.fromEntries(Object.entries(entries).map(([version, sql]) => [version, migrationSha256(sql)])),
  }, null, 2) + "\n");
}

/** Original pre-ART-316 runner, for real legacy upgrade and old-backup fixtures. */
export function applyLegacyV2Migrations(db: Database.Database, count: number) {
  db.transaction(() => {
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const migration of readV2Migrations().slice(0, count)) {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(migration.version);
    }
  }).immediate();
}
