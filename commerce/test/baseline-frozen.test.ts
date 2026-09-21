import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db";
import { LAUNCH_SCHEMA_LINEAGE } from "../src/release/schema-identity";

/**
 * The launch baseline is closed. `0002` and onward are not.
 *
 * The reset window shut at the first real external evidence - a payment, a
 * partner's acceptance, a legal consent, a submission to the advertising
 * register, a real subscriber. Before that the database was disposable and the
 * ledger could be replaced wholesale. After it, a database is brought forward
 * by migration or not at all, and `0001` is the thing every such database was
 * built from. Editing it does not change those databases; it only makes this
 * repository disagree with them.
 *
 * So this file pins the bytes. It is deliberately not a test of the schema's
 * meaning - `baseline-schema.test.ts` does that, and would keep passing through
 * an edit that left the behaviour intact. What is unsafe is the edit itself.
 *
 * **Changing the digest below is not how a schema change is made.** A schema
 * change is `0002`, and the last case here proves that adding one leaves every
 * other assertion true.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const BASELINE = "0001_launch_baseline.sql";

/** The exact bytes of the baseline as it shipped. */
const FROZEN_SHA256 = "d85a2c6f9556c52b0e0bce973f9bcf509029dfd4adddf987fcd8ce1b8f23fd71";
const FROZEN_BYTES = 175169;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const migrationNames = (dir = MIGRATIONS) => readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();

describe("the launch baseline is frozen", () => {
  it("is byte-for-byte what it shipped as", () => {
    const bytes = readFileSync(join(MIGRATIONS, BASELINE));
    expect(bytes.length).toBe(FROZEN_BYTES);
    expect(sha256(bytes)).toBe(FROZEN_SHA256);
  });

  it("is still there, under that name", () => {
    // Renaming it would leave a database built from `0001_launch_baseline.sql`
    // facing a ledger that has never heard of it, and the migrator would apply
    // the whole baseline again.
    expect(migrationNames()).toContain(BASELINE);
  });

  it("is the only migration whose number is 0001", () => {
    expect(migrationNames().filter((name) => name.startsWith("0001"))).toEqual([BASELINE]);
  });

  it("admits 0002 and onward, and nothing below", () => {
    // The ledger is append-only again. A file that sorts before the baseline
    // would be applied to a fresh database first and to an existing one never.
    for (const name of migrationNames()) {
      expect(name >= BASELINE, `${name} sorts before the baseline`).toBe(true);
      expect(name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it("establishes the launch lineage, and says so in the database it builds", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    expect(db.prepare("SELECT lineage FROM schema_identity WHERE singleton = 1").get())
      .toEqual({ lineage: LAUNCH_SCHEMA_LINEAGE });
    // The ledger is whatever the directory holds, applied in order, with the
    // baseline first. Asserted as that rule rather than as a literal list,
    // because the list was what broke when a legitimate 0002 arrived - and a
    // legitimate 0002 is the thing this freeze is designed to allow.
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual(migrationNames().map((version) => ({ version })));
    expect(migrationNames()[0]).toBe(BASELINE);
    db.close();
  });

  it("stays frozen when a legitimate 0002 is added", () => {
    // The point of the freeze is that it forbids editing `0001`, not that it
    // forbids the schema changing. This is the case that keeps the two apart:
    // an ordinary next migration, applied to a real launch database, leaving
    // every assertion above still true.
    const dir = mkdtempSync(join(tmpdir(), "baseline-frozen-"));
    cpSync(MIGRATIONS, dir, { recursive: true });
    writeFileSync(join(dir, "0002_example_next_migration.sql"),
      "CREATE TABLE a_later_table (id TEXT PRIMARY KEY);\n");

    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db, dir);

    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
      .toEqual([...migrationNames(), "0002_example_next_migration.sql"].sort().map((version) => ({ version })));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'a_later_table'").get())
      .toEqual({ name: "a_later_table" });
    // The baseline itself was not touched by any of that.
    expect(sha256(readFileSync(join(dir, BASELINE)))).toBe(FROZEN_SHA256);
    expect(migrationNames(dir).every((name) => name >= BASELINE)).toBe(true);
    db.close();
  });
});
