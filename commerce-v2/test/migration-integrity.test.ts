import Database from "better-sqlite3";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyV2Migration, migrateV2 } from "../src/db";
import { readV2Migrations, v2MigrationsDirectory } from "../src/migration-integrity";
import { applyLegacyV2Migrations, writeMigrationBundle } from "./fixtures/migrations";

const opened: Database.Database[] = [];
const directories: string[] = [];
const database = (filename = ":memory:") => {
  const db = new Database(filename); db.pragma("foreign_keys=ON"); opened.push(db); return db;
};
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "v2-integrity-")); directories.push(dir); return dir; };
const copyBundle = () => { const dir = temporary(); cpSync(v2MigrationsDirectory(), dir, { recursive: true }); return dir; };
const journal = (db: Database.Database) => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const columns = (db: Database.Database) => db.pragma("table_info(schema_migrations)") as { name: string }[];
const first = readV2Migrations()[0];
afterEach(() => {
  opened.splice(0).forEach((db) => db.close());
  directories.splice(0).forEach((dir) => rmSync(dir, { force: true, recursive: true }));
});

describe("V2 immutable migration bundle and journal", () => {
  it("records exact digests, survives reopen, and is idempotent", () => {
    const path = join(temporary(), "db.sqlite");
    const db = database(path); migrateV2(db);
    expect(journal(db)).toEqual(readV2Migrations().map(({ version, sha256 }) => ({ version, sha256, applied_at: expect.any(String) })));
    const before = journal(db);
    const reopened = database(path); migrateV2(reopened);
    expect(journal(reopened)).toEqual(before);
    expect(reopened.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("refuses modified SQL and a mismatched direct apply before touching the database", () => {
    const db = database(); const dir = copyBundle();
    writeFileSync(join(dir, first.version), first.sql + "\n-- drift\n");
    expect(() => migrateV2(db, dir)).toThrow("V2_MIGRATION_SQL_DIGEST_MISMATCH");
    expect(() => applyV2Migration(db, first.version, first.sql + "\n")).toThrow("V2_MIGRATION_INPUT_MISMATCH");
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it("checks already-applied SQL even when SQL and lock change together", () => {
    const db = database(); migrateV2(db); const before = journal(db); const dir = copyBundle();
    const entries = Object.fromEntries(readV2Migrations(dir).map(({ version, sql }) => [version, sql]));
    entries[first.version] += "\n-- drift\n"; writeMigrationBundle(dir, entries);
    expect(() => migrateV2(db, dir)).toThrow("V2_MIGRATION_LEDGER_DIGEST_MISMATCH");
    expect(() => applyV2Migration(db, first.version, entries[first.version], dir)).toThrow("V2_MIGRATION_LEDGER_DIGEST_MISMATCH");
    expect(journal(db)).toEqual(before);
  });

  it.each(["digest", "unknown", "hole", "empty", "missing"])("refuses a tampered journal: %s", (kind) => {
    const db = database(); migrateV2(db);
    if (kind === "digest") db.prepare("UPDATE schema_migrations SET sha256=? WHERE version=?").run("a".repeat(64), first.version);
    if (kind === "unknown") db.prepare("UPDATE schema_migrations SET version='9999_unknown.sql' WHERE version=?").run(first.version);
    if (kind === "hole") db.prepare("DELETE FROM schema_migrations WHERE version=?").run(first.version);
    if (kind === "empty") db.exec("DELETE FROM schema_migrations");
    if (kind === "missing") db.exec("DROP TABLE schema_migrations");
    const before = db.serialize();
    expect(() => migrateV2(db)).toThrow(/V2_MIGRATION_LEDGER_/);
    expect(db.serialize()).toEqual(before);
  });

  it.each(["missing-lock", "extra-file", "missing-file", "reordered-lock", "unknown-entry", "bad-digest"])("refuses bundle/journal tampering: %s", (kind) => {
    const db = database(); const dir = copyBundle();
    const path = join(dir, "migration.lock"); const lock = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "missing-lock") unlinkSync(path);
    if (kind === "extra-file") writeFileSync(join(dir, "9999_unknown.sql"), "SELECT 1;");
    if (kind === "missing-file") unlinkSync(join(dir, first.version));
    if (kind === "reordered-lock") lock.migrations = Object.fromEntries(Object.entries(lock.migrations).reverse());
    if (kind === "unknown-entry") lock.migrations["0033_unknown.sql"] = "a".repeat(64);
    if (kind === "bad-digest") lock.migrations[first.version] = "invalid";
    if (!["missing-lock", "extra-file", "missing-file"].includes(kind)) writeFileSync(path, JSON.stringify(lock));
    expect(() => migrateV2(db, dir)).toThrow(/V2_MIGRATION_/);
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it("refuses out-of-order direct application and rolls back failed SQL with its ledger", () => {
    const db = database(); const next = readV2Migrations()[1];
    expect(() => applyV2Migration(db, next.version, next.sql)).toThrow("V2_MIGRATION_OUT_OF_ORDER");
    const dir = temporary();
    writeMigrationBundle(dir, { "0001_bad.sql": "CREATE TABLE partial(id TEXT); THIS IS INVALID SQL;" });
    expect(() => migrateV2(db, dir)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master").all()).toEqual([]);
  });

  it("forbids null and malformed digests at the storage boundary", () => {
    const db = database(); migrateV2(db);
    for (const digest of [null, "", "a".repeat(63), "Z".repeat(64)]) {
      expect(() => db.prepare("UPDATE schema_migrations SET sha256=? WHERE version=?").run(digest, first.version)).toThrow();
    }
  });
});

describe("one-time legacy journal upgrade", () => {
  it.each([1, 15, 25, 32])("upgrades the real %i-migration prefix without changing application rows or old timestamps", (count) => {
    const db = database(); applyLegacyV2Migrations(db, count);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('legacy','legacy@example.test')").run();
    db.exec("UPDATE schema_migrations SET applied_at='2026-10-01 01:02:03'");
    const before = journal(db); const customer = db.prepare("SELECT * FROM customers").get();
    migrateV2(db);
    expect(journal(db).slice(0, count)).toEqual(before.map((row) => ({ ...row as object,
      sha256: readV2Migrations().find(({ version }) => version === (row as { version: string }).version)!.sha256,
    })));
    expect(db.prepare("SELECT * FROM customers").get()).toEqual(customer);
    const after = journal(db); migrateV2(db); expect(journal(db)).toEqual(after);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses changed SQL and lock together instead of blessing the legacy ledger", () => {
    const db = database(); applyLegacyV2Migrations(db, 15); const before = db.serialize(); const dir = copyBundle();
    const entries = Object.fromEntries(readV2Migrations().map(({ version, sql }) => [version, sql]));
    entries[first.version] += "\n-- drift\n"; writeMigrationBundle(dir, entries);
    expect(() => migrateV2(db, dir)).toThrow("V2_LEGACY_MIGRATION_CHAIN_UNTRUSTED");
    expect(db.serialize()).toEqual(before);
  });

  it("rejects gaps, unknown versions and ledgers beyond the pre-digest chain", () => {
    for (const kind of ["gap", "unknown", "future"]) {
      const db = database(); applyLegacyV2Migrations(db, 32);
      let dir: string | undefined;
      if (kind === "gap") db.prepare("DELETE FROM schema_migrations WHERE version=?").run(first.version);
      if (kind === "unknown") db.prepare("UPDATE schema_migrations SET version='0000_unknown.sql' WHERE version=?").run(first.version);
      if (kind === "future") {
        dir = copyBundle();
        const entries = Object.fromEntries(readV2Migrations().map(({ version, sql }) => [version, sql]));
        entries["0033_future.sql"] = "SELECT 1;"; writeMigrationBundle(dir, entries);
        db.exec("INSERT INTO schema_migrations(version) VALUES ('0033_future.sql')");
      }
      const before = db.serialize();
      expect(() => migrateV2(db, dir)).toThrow(/V2_(MIGRATION_LEDGER_NOT_PREFIX|LEGACY_MIGRATION_CHAIN_UNTRUSTED)/);
      expect(db.serialize()).toEqual(before);
    }
  });

  it("rolls the legacy upgrade back when a pending migration fails", () => {
    const db = database(); applyLegacyV2Migrations(db, 32); const before = journal(db); const dir = copyBundle();
    const entries = Object.fromEntries(readV2Migrations().map(({ version, sql }) => [version, sql]));
    entries["0033_broken.sql"] = "CREATE TABLE partial(id); INVALID SQL;"; writeMigrationBundle(dir, entries);
    expect(() => migrateV2(db, dir)).toThrow();
    expect(journal(db)).toEqual(before);
    expect(columns(db).some(({ name }) => name === "sha256")).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('partial','schema_migrations_legacy')").all()).toEqual([]);
  });
});
