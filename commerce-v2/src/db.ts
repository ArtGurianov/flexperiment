import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertV2LegacyUpgradeChain, migrationSha256, readV2Migrations, V2MigrationIntegrityError,
  type V2Migration,
} from "./migration-integrity";

export const V2_SCHEMA_LINEAGE = "flexperiment-v2";

export class V2SchemaLineageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const defaultDatabasePath = () => join(process.cwd(), "commerce-v2-data", "commerce.sqlite");

export function openV2Database(filename = process.env.COMMERCE_V2_DATABASE_PATH ?? defaultDatabasePath()) {
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

type Identity = { readonly lineage: string };

const tableNames = (db: Database.Database): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
    .map(({ name }) => name);

export function classifyV2Database(db: Database.Database): "EMPTY" | "SUPPORTED" | "V1" | "UNKNOWN" {
  const tables = tableNames(db);
  if (tables.length === 0) return "EMPTY";
  if (!tables.includes("schema_identity")) return "UNKNOWN";
  const identity = db.prepare("SELECT lineage FROM schema_identity WHERE singleton = 1").get() as Identity | undefined;
  if (identity?.lineage === V2_SCHEMA_LINEAGE) return "SUPPORTED";
  if (identity?.lineage === "flexperiment-launch") return "V1";
  return "UNKNOWN";
}

function assertSupported(db: Database.Database) {
  const state = classifyV2Database(db);
  if (state === "SUPPORTED") return;
  if (state === "V1") throw new V2SchemaLineageError("V1_DATABASE_REFUSED");
  throw new V2SchemaLineageError("UNKNOWN_DATABASE_REFUSED");
}

const ledgerExists = (db: Database.Database) => tableNames(db).includes("schema_migrations");

const createLedgerSql = `CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*')
)`;

type MigrationRow = { version: string; applied_at: string; sha256?: string };

/** Must run under BEGIN IMMEDIATE, including the legacy upgrade. */
function verifyLedger(db: Database.Database, migrations: V2Migration[]): number {
  const before = classifyV2Database(db);
  if (before === "V1") throw new V2SchemaLineageError("V1_DATABASE_REFUSED");
  if (before === "UNKNOWN") throw new V2SchemaLineageError("UNKNOWN_DATABASE_REFUSED");
  if (before === "EMPTY") { db.exec(createLedgerSql); return 0; }
  if (!ledgerExists(db)) throw new V2MigrationIntegrityError("V2_MIGRATION_LEDGER_MISSING");

  const columns = db.pragma("table_info(schema_migrations)") as Array<{ name: string }>;
  const legacy = !columns.some(({ name }) => name === "sha256");
  if (JSON.stringify(columns.map(({ name }) => name).sort()) !== JSON.stringify(
    (legacy ? ["applied_at", "version"] : ["applied_at", "sha256", "version"]))) {
    throw new V2MigrationIntegrityError("V2_MIGRATION_LEDGER_INVALID");
  }
  const rows = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all() as MigrationRow[];
  if (!rows.length) throw new V2MigrationIntegrityError("V2_MIGRATION_LEDGER_EMPTY");
  for (const [index, row] of rows.entries()) {
    if (row.version !== migrations[index]?.version || typeof row.applied_at !== "string" || !row.applied_at) {
      throw new V2MigrationIntegrityError("V2_MIGRATION_LEDGER_NOT_PREFIX", row.version);
    }
    if (!legacy && row.sha256 !== migrations[index].sha256) {
      throw new V2MigrationIntegrityError("V2_MIGRATION_LEDGER_DIGEST_MISMATCH", row.version);
    }
  }
  if (legacy) {
    assertV2LegacyUpgradeChain(migrations, rows.length);
    // Rebuild only the bookkeeping table, atomically, preserving every timestamp
    // and all application data. A nullable hash column would allow partial upgrades.
    db.exec("ALTER TABLE schema_migrations RENAME TO schema_migrations_legacy");
    db.exec(createLedgerSql);
    const insert = db.prepare("INSERT INTO schema_migrations(version, applied_at, sha256) VALUES (?, ?, ?)");
    rows.forEach((row, index) => insert.run(row.version, row.applied_at, migrations[index].sha256));
    db.exec("DROP TABLE schema_migrations_legacy");
  }
  return rows.length;
}

function applyVerifiedMigration(db: Database.Database, migration: V2Migration) {
  db.exec(migration.sql);
  db.prepare("INSERT INTO schema_migrations(version, sha256) VALUES (?, ?)").run(migration.version, migration.sha256);
}

export function applyV2Migration(db: Database.Database, version: string, sql: string, directory?: string) {
  const migrations = readV2Migrations(directory);
  const index = migrations.findIndex((migration) => migration.version === version);
  if (index < 0 || migrationSha256(sql) !== migrations[index].sha256) {
    throw new V2MigrationIntegrityError("V2_MIGRATION_INPUT_MISMATCH", version);
  }
  db.transaction(() => {
    const count = verifyLedger(db, migrations);
    if (index < count) return;
    if (index !== count) throw new V2MigrationIntegrityError("V2_MIGRATION_OUT_OF_ORDER", version);
    applyVerifiedMigration(db, migrations[index]);
    assertSupported(db);
  }).immediate();
}

export function migrateV2(db: Database.Database, directory?: string) {
  const migrations = readV2Migrations(directory);
  db.transaction(() => {
    const count = verifyLedger(db, migrations);
    for (const migration of migrations.slice(count)) applyVerifiedMigration(db, migration);
    assertSupported(db);
  }).immediate();
}
