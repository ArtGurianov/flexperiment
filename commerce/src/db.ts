import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createHash } from "node:crypto";
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

/**
 * Migrations permitted to run with `foreign_keys` temporarily OFF, keyed by
 * the exact `(filename, sha256)` pair reviewed for that procedure - never by
 * filename alone, so touching a migration's bytes without a matching reviewed
 * registry update can never silently keep it privileged. `PRAGMA foreign_keys`
 * is a no-op once a transaction is open, so this table exists specifically to
 * admit the disable-then-BEGIN ordering in applyFkOffMigration() below for a
 * migration that genuinely needs it (an in-place CHECK-constraint rebuild that
 * SQLite cannot do without recreating the table), and nothing else.
 *
 * Deliberately empty in PR1: the first entry (0042) cannot exist before the
 * migration file does. PR2 adds the migration and its registry entry in the
 * same reviewed commit, so both enter the release together.
 *
 * `commerce/src/db.ts` is runtime-reachable from server.ts and is in no
 * boundary list of its own (see docs/release/DEPLOYMENT_INVARIANTS.md and
 * finding A4-3 in the Agent Referrals plan). The registry is therefore
 * inlined here rather than imported from a separate module, so adding an
 * entry never gives this file a new local import edge that would need its
 * own boundary classification.
 */
export const FK_OFF_MIGRATIONS: ReadonlyArray<{ readonly filename: string; readonly sha256: string }> = [];

export const isFkOffMigration = (filename: string, sha256Hex: string): boolean =>
  FK_OFF_MIGRATIONS.some((entry) => entry.filename === filename && entry.sha256 === sha256Hex);

/**
 * A post-commit `foreign_key_check` failure cannot be undone by rollback -
 * the transaction already committed - so it is surfaced as this distinct,
 * unrecoverable class rather than an ordinary thrown Error. A caller must
 * never report the runtime ready after catching one of these.
 */
export class MigrationFatalError extends Error {
  constructor(readonly code: string) { super(code); }
}

const alreadyApplied = (sqlite: Database.Database, version: string): boolean =>
  Boolean(sqlite.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));

const recordApplied = (sqlite: Database.Database, version: string) =>
  sqlite.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(version);

const foreignKeyViolations = (sqlite: Database.Database): unknown[] => {
  const result = sqlite.pragma("foreign_key_check");
  return Array.isArray(result) ? result : [];
};

/**
 * Ordinary path: `BEGIN IMMEDIATE` acquires the write lock before this
 * connection decides anything, then the ledger is re-checked from inside that
 * lock - never from a set built before acquiring it - so a second concurrent
 * runner that raced to the same version becomes a no-op instead of a double
 * apply or a UNIQUE-constraint crash on `schema_migrations`.
 */
export const applyOrdinaryMigration = (sqlite: Database.Database, version: string, sql: string) => {
  const run = sqlite.transaction(() => {
    if (alreadyApplied(sqlite, version)) return;
    sqlite.exec(sql);
    recordApplied(sqlite, version);
  });
  run.immediate();
};

/**
 * The one procedure allowed to run with `foreign_keys` OFF, and only for a
 * migration whose exact bytes are pinned in FK_OFF_MIGRATIONS.
 *
 * Ordering: assert not already in a transaction and foreign_keys is ON ->
 * disable FK -> BEGIN IMMEDIATE -> re-check ledger, execute, insert ledger ->
 * foreign_key_check -> commit -> re-enable FK -> foreign_key_check again.
 *
 * A pre-commit failure (the exec itself, or a violation found before commit)
 * rolls back exactly like the ordinary path; foreign_keys is restored in the
 * finally below regardless of how the transaction ended. A violation found
 * only after commit is the unrecoverable case and raises MigrationFatalError.
 */
export const applyFkOffMigration = (sqlite: Database.Database, version: string, sql: string) => {
  if (sqlite.inTransaction) throw new MigrationFatalError("MIGRATION_FK_OFF_ALREADY_IN_TRANSACTION");
  if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) throw new MigrationFatalError("MIGRATION_FK_OFF_REQUIRES_FOREIGN_KEYS_ON");
  sqlite.pragma("foreign_keys = OFF");
  try {
    const run = sqlite.transaction(() => {
      if (alreadyApplied(sqlite, version)) return;
      sqlite.exec(sql);
      recordApplied(sqlite, version);
      if (foreignKeyViolations(sqlite).length) throw new MigrationFatalError("MIGRATION_FK_OFF_PRE_COMMIT_FOREIGN_KEY_CHECK_FAILED");
    });
    run.immediate();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
  if (foreignKeyViolations(sqlite).length) throw new MigrationFatalError("MIGRATION_FK_OFF_POST_COMMIT_FOREIGN_KEY_CHECK_FAILED");
};

export function migrate(sqlite: Database.Database, migrationsDir = join(process.cwd(), "commerce", "migrations")) {
  if (!existsSync(migrationsDir)) throw new Error("Commerce migrations directory is missing.");
  sqlite.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const version of readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort()) {
    // Fast unlocked skip for the common case (already applied); the
    // authoritative recheck that actually matters under concurrency happens
    // again inside the acquired IMMEDIATE transaction below. Any failure here
    // - SQL error, pre-commit or post-commit foreign_key_check violation -
    // propagates out of migrate() and stops every further migration in this
    // call; there is no catch-and-continue.
    if (alreadyApplied(sqlite, version)) continue;
    const sql = readFileSync(join(migrationsDir, version), "utf8");
    if (isFkOffMigration(version, createHash("sha256").update(sql).digest("hex"))) applyFkOffMigration(sqlite, version, sql);
    else applyOrdinaryMigration(sqlite, version, sql);
  }
  return drizzle(sqlite);
}

export type Sqlite = Database.Database;
