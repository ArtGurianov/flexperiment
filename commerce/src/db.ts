import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const defaultPath = join(process.cwd(), "commerce-data", "commerce.sqlite");

export function openDatabase(filename = process.env.COMMERCE_DATABASE_PATH ?? defaultPath) {
  mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

export function openReadOnlyDatabase(filename = process.env.COMMERCE_DATABASE_PATH ?? defaultPath) {
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return sqlite;
}

export function migrate(sqlite: Database.Database, migrationsDir = join(process.cwd(), "commerce", "migrations")) {
  if (!existsSync(migrationsDir)) throw new Error("Commerce migrations directory is missing.");
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const applied = new Set(sqlite.prepare("SELECT version FROM schema_migrations").all().map((row) => (row as { version: string }).version));
  for (const version of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    if (applied.has(version)) continue;
    const run = sqlite.transaction(() => {
      sqlite.exec(readFileSync(join(migrationsDir, version), "utf8"));
      sqlite.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);
    });
    run();
  }
  return drizzle(sqlite);
}

export type Sqlite = Database.Database;
