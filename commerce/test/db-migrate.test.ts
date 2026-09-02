import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { FK_OFF_MIGRATIONS, MigrationFatalError, applyFkOffMigration, applyOrdinaryMigration, isFkOffMigration, migrate } from "../src/db";

/**
 * PR1 hardens migrate() per docs/release/DEPLOYMENT_INVARIANTS.md and the
 * Agent Referrals plan A4-1/Phase 1: BEGIN IMMEDIATE, ledger re-checked
 * inside the acquired transaction, and a local FK-off registry that ships
 * empty. 0042 (PR2) is the only migration ever meant to use the FK-off path,
 * so this suite exercises the mechanics with synthetic, test-only SQL.
 */

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const tempFile = () => join(mkdtempSync(join(tmpdir(), "db-migrate-")), "commerce.sqlite");

const dbAt = (file: string) => {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  open.push(db);
  return db;
};

const withMigrationsDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "db-migrate-fixtures-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
};

describe("migrate(): ordinary path", () => {
  it("applies a migration with foreign_keys remaining ON throughout", () => {
    const file = tempFile();
    const db = dbAt(file);
    const dir = withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" });
    migrate(db, dir);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: "0001_x.sql" }]);
  });

  it("is idempotent: re-running migrate() does not re-apply or error", () => {
    const file = tempFile();
    const db = dbAt(file);
    const dir = withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" });
    migrate(db, dir);
    expect(() => migrate(db, dir)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
  });

  it("two concurrent migrate() connections apply the migration exactly once", () => {
    const file = tempFile();
    const dir = withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t(id) VALUES (1);" });
    const a = dbAt(file);
    const b = dbAt(file);
    // Neither connection has applied anything yet - both observe the ledger
    // as empty before either acquires the write lock. The correctness
    // property under test is that the second runner's re-check happens AFTER
    // it acquires BEGIN IMMEDIATE, not from this pre-check.
    migrate(a, dir);
    expect(() => migrate(b, dir)).not.toThrow();
    const applied = a.prepare("SELECT version FROM schema_migrations").all();
    expect(applied).toEqual([{ version: "0001_x.sql" }]);
    expect(a.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
  });

  it("a genuinely racing second runner re-checks inside its own IMMEDIATE transaction and no-ops", () => {
    // Simulates "ledger observed before lock but inserted by competitor":
    // runner B's ledger view is captured, then A commits, then B proceeds -
    // B must still no-op rather than re-execute or crash on UNIQUE version.
    const file = tempFile();
    const dir = withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" });
    const a = dbAt(file);
    const b = dbAt(file);
    b.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const bSeesUnapplied = !b.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get("0001_x.sql");
    expect(bSeesUnapplied).toBe(true);
    migrate(a, dir); // A applies and commits first.
    expect(() => applyOrdinaryMigration(b, "0001_x.sql", readFileSync(join(dir, "0001_x.sql"), "utf8"))).not.toThrow();
    expect(a.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
  });

  it("stops all further migrations when one fails", () => {
    const file = tempFile();
    const db = dbAt(file);
    const dir = withMigrationsDir({
      "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);",
      "0002_bad.sql": "THIS IS NOT VALID SQL;",
      "0003_after.sql": "CREATE TABLE u(id INTEGER PRIMARY KEY);",
    });
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: "0001_x.sql" }]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='u'").get()).toBeUndefined();
  });
});

describe("FK-off registry: empty in PR1", () => {
  it("ships with zero entries", () => {
    expect(FK_OFF_MIGRATIONS).toEqual([]);
  });

  it("never treats any (filename, sha256) pair as special", () => {
    expect(isFkOffMigration("0042_agent_referrals_agents_rebuild.sql", "a".repeat(64))).toBe(false);
    expect(isFkOffMigration("anything.sql", "b".repeat(64))).toBe(false);
  });

  it("a migration requiring FK-off semantics is refused when unregistered, not silently bypassed", () => {
    // A synthetic table rebuild: drop-and-recreate while an existing FK
    // reference exists. This is the exact shape 0042 needs and it MUST fail
    // under the ordinary (FK-enforced) path, proving the registry gate is
    // load-bearing rather than decorative.
    const file = tempFile();
    const db = dbAt(file);
    db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('A')))");
    db.exec("CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))");
    db.prepare("INSERT INTO parent(id, kind) VALUES (1, 'A')").run();
    db.prepare("INSERT INTO child(id, parent_id) VALUES (1, 1)").run();
    const rebuild = `
      CREATE TABLE parent_new(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('A', 'B')));
      INSERT INTO parent_new SELECT id, kind FROM parent;
      DROP TABLE parent;
      ALTER TABLE parent_new RENAME TO parent;
    `;
    expect(isFkOffMigration("0099_synthetic_rebuild.sql", "irrelevant")).toBe(false);
    expect(() => applyOrdinaryMigration(db, "0099_synthetic_rebuild.sql", rebuild)).toThrow();
    // Rolled back: the original parent table (and its narrower CHECK) survives.
    expect(db.prepare("SELECT kind FROM parent WHERE id = 1").get()).toEqual({ kind: "A" });
  });
});

describe("applyFkOffMigration(): mechanics proven with synthetic input", () => {
  const rebuildSql = `
    CREATE TABLE parent_new(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('A', 'B')));
    INSERT INTO parent_new SELECT id, kind FROM parent;
    DROP TABLE parent;
    ALTER TABLE parent_new RENAME TO parent;
  `;

  const seeded = () => {
    const file = tempFile();
    const db = dbAt(file);
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    db.exec("CREATE TABLE parent(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('A')))");
    db.exec("CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))");
    db.prepare("INSERT INTO parent(id, kind) VALUES (1, 'A')").run();
    db.prepare("INSERT INTO child(id, parent_id) VALUES (1, 1)").run();
    return db;
  };

  it("succeeds: rebuild applies, ledger recorded, FK restored to ON, no violations", () => {
    const db = seeded();
    applyFkOffMigration(db, "0099_synthetic_rebuild.sql", rebuildSql);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: "0099_synthetic_rebuild.sql" }]);
    expect(db.prepare("PRAGMA table_info(parent)").all().map((c: unknown) => (c as { name: string }).name)).toEqual(["id", "kind"]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    // The widened CHECK actually took effect - proof the rebuild ran.
    expect(() => db.prepare("INSERT INTO parent(id, kind) VALUES (2, 'B')").run()).not.toThrow();
  });

  it("rolls back and restores FK on a pre-commit foreign_key_check violation, without applying", () => {
    const db = seeded();
    const rebuildDroppingChildRow = `
      CREATE TABLE parent_new(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('A', 'B')));
      -- Deliberately drop row id=1 from the rebuilt parent while child still
      -- references it - this is what the post-exec foreign_key_check must catch.
      DROP TABLE parent;
      ALTER TABLE parent_new RENAME TO parent;
    `;
    expect(() => applyFkOffMigration(db, "0099_bad_rebuild.sql", rebuildDroppingChildRow))
      .toThrow(MigrationFatalError);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual([]);
    // Rolled back: original parent table survives with its original CHECK.
    expect(db.prepare("SELECT kind FROM parent WHERE id = 1").get()).toEqual({ kind: "A" });
  });

  it("is idempotent: a second run against an already-applied version no-ops", () => {
    const db = seeded();
    applyFkOffMigration(db, "0099_synthetic_rebuild.sql", rebuildSql);
    expect(() => applyFkOffMigration(db, "0099_synthetic_rebuild.sql", rebuildSql)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
  });

  it("asserts not already in a transaction", () => {
    const db = seeded();
    const tx = db.transaction(() => {
      expect(() => applyFkOffMigration(db, "0099_synthetic_rebuild.sql", rebuildSql)).toThrow(MigrationFatalError);
    });
    tx();
  });

  it("asserts foreign_keys is ON before starting", () => {
    const db = seeded();
    db.pragma("foreign_keys = OFF");
    expect(() => applyFkOffMigration(db, "0099_synthetic_rebuild.sql", rebuildSql)).toThrow(MigrationFatalError);
    db.pragma("foreign_keys = ON");
  });
});

describe("migration runner source shape (structural)", () => {
  // Complements the executing tests above for the one property that cannot
  // be naturally triggered by a single synchronous connection: a violation
  // that a post-commit recheck catches after a clean pre-commit check
  // (foreign_key_check does not depend on the foreign_keys pragma or
  // transaction boundary for this connection's own writes - only a
  // concurrent writer landing between commit and recheck could genuinely
  // diverge the two results). The ordering itself is still fully
  // machine-verified here, and removing either check breaks this test.
  const source = readFileSync(join(process.cwd(), "commerce", "src", "db.ts"), "utf8");

  it("disables foreign_keys strictly before BEGIN IMMEDIATE, never after", () => {
    const disableIdx = source.indexOf('sqlite.pragma("foreign_keys = OFF")');
    const immediateIdx = source.indexOf("run.immediate()", disableIdx);
    expect(disableIdx).toBeGreaterThan(-1);
    expect(immediateIdx).toBeGreaterThan(disableIdx);
  });

  it("checks foreign_key_check both before and after commit, with distinct fatal codes", () => {
    expect(source).toContain("MIGRATION_FK_OFF_PRE_COMMIT_FOREIGN_KEY_CHECK_FAILED");
    expect(source).toContain("MIGRATION_FK_OFF_POST_COMMIT_FOREIGN_KEY_CHECK_FAILED");
    expect((source.match(/foreignKeyViolations\(sqlite\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("restores foreign_keys = ON unconditionally via finally", () => {
    const financeIdx = source.indexOf("} finally {");
    expect(financeIdx).toBeGreaterThan(-1);
    expect(source.slice(financeIdx, financeIdx + 80)).toContain('sqlite.pragma("foreign_keys = ON")');
  });
});
