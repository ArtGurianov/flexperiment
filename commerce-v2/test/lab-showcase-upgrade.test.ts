import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { assertReviewedRestoreSchema } from "../src/erasure-restore";

it("upgrades the exact showcase migration prefix and preserves interest and notice history", () => {
  const directory = mkdtempSync(join(tmpdir(), "lab-showcase-prefix-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  const source = join(process.cwd(), "commerce-v2/migrations");
  const lock = JSON.parse(readFileSync(join(source, "migration.lock"), "utf8"));
  try {
    lock.migrations = Object.fromEntries(Object.entries(lock.migrations).filter(([name]) => Number(name.slice(0, 4)) <= 37));
    expect(lock.migrations["0037_lab_interest.sql"]).toBe("0caaf48d0e111610f0109e145ec469db82be76e78acc78d341199b396a1e025b");
    for (const name of Object.keys(lock.migrations)) copyFileSync(join(source, name), join(directory, name));
    writeFileSync(join(directory, "migration.lock"), JSON.stringify(lock));

    migrateV2(db, directory);
    db.exec(`INSERT INTO cities (id, slug, title) VALUES ('city', 'fixture', 'Fixture');
      INSERT INTO lab_interest_signups (id, email_normalized, city_id, state, purpose, consent_text_version, consent_text_sha256, created_at, confirmed_at)
      VALUES ('${"a".repeat(32)}','buyer@example.test','city','CONFIRMED','LAB_SALES_NOTICE','test','${"b".repeat(64)}','2026-11-22','2026-11-22');
      INSERT INTO lab_interest_suppressions (email_normalized, created_at) VALUES ('withdrawn@example.test','2026-11-23');
      INSERT INTO lab_interest_notices (signup_id, notice_key, state, attempted_at) VALUES ('${"a".repeat(32)}','launch','ATTEMPTED','2026-11-23');`);
    const tables = ["lab_interest_signups", "lab_interest_suppressions", "lab_interest_notices"];
    const interestRows = () => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const before = interestRows();
    const journal = () => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    const prefix = journal();

    migrateV2(db);
    expect(interestRows()).toEqual(before);
    expect(journal().slice(0, prefix.length)).toEqual(prefix);
    expect(assertReviewedRestoreSchema(db)).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
