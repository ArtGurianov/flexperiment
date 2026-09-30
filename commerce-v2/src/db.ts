import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const V2_SCHEMA_LINEAGE = "flexperiment-v2";

export class V2SchemaLineageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const migrationsDirectory = () => join(process.cwd(), "commerce-v2", "migrations");
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

export function applyV2Migration(db: Database.Database, version: string, sql: string) {
  const apply = db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
    if (applied) return;
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
  });
  apply.immediate();
}

export function migrateV2(db: Database.Database, directory = migrationsDirectory()) {
  if (!existsSync(directory)) throw new Error("V2_MIGRATIONS_DIRECTORY_MISSING");
  const before = classifyV2Database(db);
  if (before === "V1") throw new V2SchemaLineageError("V1_DATABASE_REFUSED");
  if (before === "UNKNOWN") throw new V2SchemaLineageError("UNKNOWN_DATABASE_REFUSED");

  const migrations = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  for (const version of migrations) {
    if (ledgerExists(db) && db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)) continue;
    applyV2Migration(db, version, readFileSync(join(directory, version), "utf8"));
  }
  assertSupported(db);
}
