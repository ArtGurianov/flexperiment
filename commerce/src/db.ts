import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertSupportedSchemaLineage, classifySchemaLineage, SchemaLineageError, type SchemaIdentitySnapshot } from "./release/schema-identity";

const defaultPath = join(process.cwd(), "commerce-data", "commerce.sqlite");
const defaultMigrationsDir = () => join(process.cwd(), "commerce", "migrations");

/**
 * Test-only final-schema snapshots remove repeated migration work from the
 * ordinary product-suite fixtures. The flag is set only by the test command;
 * production always opens the requested database and runs the migration ledger
 * unchanged. The global test setup builds the image from the current
 * checkout's migrations before workers start.
 */
const testSchemaSnapshotsEnabled = () => process.env.COMMERCE_TEST_DB_SNAPSHOT === "1";
const testSchemaSnapshot = () => {
  const path = process.env.COMMERCE_TEST_DB_SNAPSHOT_PATH;
  return path && existsSync(path) ? readFileSync(path) : undefined;
};

const configureDatabase = (sqlite: Database.Database) => {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
};

export function openDatabase(
  filename = process.env.COMMERCE_DATABASE_PATH ?? defaultPath,
  options: { readonly testSchemaSnapshot?: boolean } = {},
) {
  mkdirSync(dirname(filename), { recursive: true });
  const snapshot = options.testSchemaSnapshot !== false && testSchemaSnapshotsEnabled()
    ? testSchemaSnapshot()
    : undefined;
  if (snapshot && filename !== ":memory:" && !existsSync(filename)) writeFileSync(filename, snapshot, { mode: 0o600 });
  return configureDatabase(new Database(filename === ":memory:" ? snapshot ?? filename : filename));
}

export function openReadOnlyDatabase(filename = process.env.COMMERCE_DATABASE_PATH ?? defaultPath) {
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

const LEDGER_DDL = "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)";

const tableExists = (sqlite: Database.Database, name: string): boolean =>
  Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * What the lineage decision is made from. Read straight off the database,
 * because the question is what this file actually is - not what a caller
 * believes it opened.
 */
export const readSchemaIdentity = (sqlite: Database.Database): SchemaIdentitySnapshot => {
  const tableNames = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((row) => row.name);
  const schemaIdentity = tableNames.includes("schema_identity")
    ? (sqlite.prepare("SELECT lineage FROM schema_identity WHERE singleton = 1").get() as { lineage: string } | undefined) ?? null
    : null;
  const appliedVersionCount = tableNames.includes("schema_migrations")
    ? Number((sqlite.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n)
    : 0;
  return { tableNames, schemaIdentity, appliedVersionCount };
};

/** Every entry point that opens a database without migrating it owes this call. */
export const assertSupportedDatabase = (sqlite: Database.Database): void =>
  assertSupportedSchemaLineage(readSchemaIdentity(sqlite));

const alreadyApplied = (sqlite: Database.Database, version: string): boolean =>
  Boolean(sqlite.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));

const recordApplied = (sqlite: Database.Database, version: string) =>
  sqlite.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);

/**
 * `BEGIN IMMEDIATE` acquires the write lock before this connection decides
 * anything, then the ledger is re-checked from inside that lock - never from a
 * set built before acquiring it - so a second concurrent runner that raced to
 * the same version becomes a no-op instead of a double apply or a
 * UNIQUE-constraint crash on `schema_migrations`.
 *
 * The ledger table is created inside that same transaction. Creating it first
 * and separately would leave a crashed bootstrap holding a database whose only
 * table is `schema_migrations` - which classifies as LEGACY, and would refuse
 * to start forever. Either the baseline and its ledger row are both there, or
 * the database is still empty.
 */
export const applyMigration = (sqlite: Database.Database, version: string, sql: string) => {
  const run = sqlite.transaction(() => {
    sqlite.exec(LEDGER_DDL);
    if (alreadyApplied(sqlite, version)) return;
    sqlite.exec(sql);
    recordApplied(sqlite, version);
  });
  run.immediate();
};

/**
 * Classification happens BEFORE anything is applied, and that ordering is the
 * whole point: a pre-launch database must be refused, never brought forward.
 * The launch baseline is not a step the old ledger can take - it is a
 * different lineage - so incompatibility is a property this runtime enforces
 * rather than something a cutover procedure is trusted to arrange.
 *
 *   empty              -> bootstrap the launch baseline
 *   launch lineage     -> apply whatever 0002+ is pending
 *   pre-launch ledger  -> refuse
 *   anything else      -> refuse
 */
export function migrate(sqlite: Database.Database, migrationsDir = defaultMigrationsDir()) {
  if (!existsSync(migrationsDir)) throw new Error("Commerce migrations directory is missing.");
  const lineage = classifySchemaLineage(readSchemaIdentity(sqlite));
  if (lineage === "LEGACY") throw new SchemaLineageError("LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED");
  if (lineage === "UNKNOWN") throw new SchemaLineageError("UNKNOWN_SCHEMA_LINEAGE");

  for (const version of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    // Fast unlocked skip for the common case; the authoritative recheck that
    // matters under concurrency happens again inside the IMMEDIATE transaction.
    // Any failure propagates and stops every further migration in this call.
    if (tableExists(sqlite, "schema_migrations") && alreadyApplied(sqlite, version)) continue;
    applyMigration(sqlite, version, readFileSync(join(migrationsDir, version), "utf8"));
  }

  // A database that came out of this still has to be one this runtime trusts.
  assertSupportedDatabase(sqlite);
}

export type Sqlite = Database.Database;
