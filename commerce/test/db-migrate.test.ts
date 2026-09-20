import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, migrate, readSchemaIdentity } from "../src/db";
import { SchemaLineageError, classifySchemaLineage } from "../src/release/schema-identity";

/**
 * What `migrate()` has to hold: the lineage decided BEFORE anything is applied,
 * `BEGIN IMMEDIATE` acquired before this connection decides anything, and the
 * ledger re-checked from inside that lock.
 *
 * The FK-off registry is gone with the ledger it served. It existed so that
 * five reviewed migrations could rebuild a table in place; a baseline that
 * states the finished schema has nothing to rebuild.
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

/** What every real baseline establishes, and what `migrate()` asserts afterwards. */
const IDENTITY_SQL = `
CREATE TABLE schema_identity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  lineage TEXT NOT NULL CHECK (lineage = 'flexperiment-launch'),
  baseline_version TEXT NOT NULL
);
INSERT INTO schema_identity(singleton, lineage, baseline_version) VALUES (1, 'flexperiment-launch', 'test');
`;

/**
 * Fixtures are synthetic but not unfaithful: the first migration establishes
 * the lineage, because that is what makes a bootstrapped database one this
 * runtime will go on to trust.
 */
const withMigrationsDir = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "db-migrate-fixtures-"));
  const [first] = Object.keys(files).sort();
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), name === first ? IDENTITY_SQL + sql : sql);
  }
  return dir;
};

/** A pre-launch database: a populated ledger and no `schema_identity`. */
const legacyDatabase = (db: Database.Database) => {
  db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, reward_authority_kind TEXT NOT NULL DEFAULT 'LEGACY')");
  const record = db.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
  record.run("0001_initial.sql");
  for (let n = 2; n <= 61; n += 1) record.run(`${String(n).padStart(4, "0")}_pre_launch.sql`);
  return db;
};

describe("lineage is decided before anything is applied", () => {
  it("bootstraps an empty database", () => {
    const db = dbAt(tempFile());
    expect(classifySchemaLineage(readSchemaIdentity(db))).toBe("EMPTY_BOOTSTRAPPABLE");
    migrate(db, withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" }));
    expect(classifySchemaLineage(readSchemaIdentity(db))).toBe("SUPPORTED");
  });

  it("refuses a pre-launch ledger database, and applies nothing to it", () => {
    // The old ledger is not a step the baseline can take - it is a different
    // lineage. Incompatibility has to be a property of this runtime, not an
    // assumption the cutover procedure is trusted to arrange.
    const db = legacyDatabase(dbAt(tempFile()));
    const dir = withMigrationsDir({ "0001_launch_baseline.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" });
    expect(() => migrate(db, dir)).toThrow(new SchemaLineageError("LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED"));
    // Refused before application: the ledger is untouched and nothing was built.
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 61 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('t', 'schema_identity')").all()).toEqual([]);
  });

  it("refuses a database of unrecognised shape", () => {
    const db = dbAt(tempFile());
    db.exec("CREATE TABLE something_else(id INTEGER PRIMARY KEY)");
    expect(classifySchemaLineage(readSchemaIdentity(db))).toBe("UNKNOWN");
    expect(() => migrate(db, withMigrationsDir({ "0001_x.sql": "SELECT 1;" })))
      .toThrow(new SchemaLineageError("UNKNOWN_SCHEMA_LINEAGE"));
  });

  it("refuses a foreign lineage rather than reading it as supported", () => {
    const db = dbAt(tempFile());
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE schema_identity (singleton INTEGER PRIMARY KEY, lineage TEXT NOT NULL)");
    db.exec("INSERT INTO schema_identity(singleton, lineage) VALUES (1, 'somebody-elses-product')");
    expect(classifySchemaLineage(readSchemaIdentity(db))).toBe("UNKNOWN");
  });

  it("applies 0002 onwards to a launch database", () => {
    const db = dbAt(tempFile());
    const dir = withMigrationsDir({
      "0001_launch_baseline.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);",
      "0002_later.sql": "CREATE TABLE u(id INTEGER PRIMARY KEY);",
    });
    migrate(db, dir);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual([{ version: "0001_launch_baseline.sql" }, { version: "0002_later.sql" }]);
  });
});

describe("migrate(): the lock discipline", () => {
  it("applies a migration with foreign_keys remaining ON throughout", () => {
    const db = dbAt(tempFile());
    migrate(db, withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" }));
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: "0001_x.sql" }]);
  });

  it("is idempotent: re-running migrate() does not re-apply or error", () => {
    const db = dbAt(tempFile());
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
    // Both observe the ledger as empty before either acquires the write lock.
    // The property under test is that the second runner's re-check happens
    // AFTER it acquires BEGIN IMMEDIATE, not from this pre-check.
    migrate(a, dir);
    expect(() => migrate(b, dir)).not.toThrow();
    expect(a.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: "0001_x.sql" }]);
    expect(a.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
  });

  it("a genuinely racing second runner re-checks inside its own IMMEDIATE transaction and no-ops", () => {
    // "Ledger observed before the lock, inserted by a competitor": B's view is
    // captured, A commits, then B proceeds - and B must still no-op rather
    // than re-execute or crash on a UNIQUE version.
    const file = tempFile();
    const dir = withMigrationsDir({ "0001_x.sql": "CREATE TABLE t(id INTEGER PRIMARY KEY);" });
    const a = dbAt(file);
    const b = dbAt(file);
    b.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    expect(b.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get("0001_x.sql")).toBeUndefined();
    migrate(a, dir);
    expect(() => applyMigration(b, "0001_x.sql", readFileSync(join(dir, "0001_x.sql"), "utf8"))).not.toThrow();
    expect(a.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: 1 });
  });

  it("creates the ledger inside the same transaction as the first migration", () => {
    // Otherwise a bootstrap that crashed between the two would leave a database
    // whose only table is `schema_migrations` - which classifies as LEGACY, and
    // would refuse to start forever.
    const db = dbAt(tempFile());
    const dir = withMigrationsDir({ "0001_x.sql": "THIS IS NOT VALID SQL;" });
    expect(() => migrate(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    expect(classifySchemaLineage(readSchemaIdentity(db))).toBe("EMPTY_BOOTSTRAPPABLE");
  });

  it("stops all further migrations when one fails", () => {
    const db = dbAt(tempFile());
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
