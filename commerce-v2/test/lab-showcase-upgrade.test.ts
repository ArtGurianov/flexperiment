import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyV2Migration, migrateV2 } from "../src/db";
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
    const previousLock = JSON.parse(readFileSync(join(source, "migration.lock"), "utf8"));
    for (const [name, hash] of Object.entries(previousLock.migrations as Record<string, string>)) {
      if (Number(name.slice(0, 4)) > 42) continue;
      copyFileSync(join(source, name), join(directory, name));
      lock.migrations[name] = hash;
    }
    writeFileSync(join(directory, "migration.lock"), JSON.stringify(lock));
    migrateV2(db, directory);
    db.exec(`INSERT INTO customers (id,email_normalized) VALUES ('legacy-buyer','legacy@example.test');
      INSERT INTO legal_releases (id,storefront,version,manifest_json,effective_at) VALUES ('legacy-legal','COURSES','synthetic','{}','2026-11-22');
      INSERT INTO orders (id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
      VALUES ('legacy-order','legacy-order','legacy-buyer','PAYMENT_PENDING',100,'{}','${"a".repeat(64)}','legacy-legal','2026-11-22','2026-11-22');
      INSERT INTO native_payments (id,order_id,payment_ref,idempotency_key,amount_kopecks,snapshot_hash,state,created_at,updated_at)
      VALUES ('legacy-payment','legacy-order','legacy-payment','legacy-key',100,'${"a".repeat(64)}','CREATING','2026-11-22','2026-11-22');`);

    const handoff = "0043_native_payment_dispatch_boundary.sql";
    applyV2Migration(db, handoff, readFileSync(join(source, handoff), "utf8"));
    const through43 = journal();
    expect(through43).toHaveLength(43);

    db.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES
      ('legacy-test','course:legacy-test','ONLINE_COURSE','PAID','legacy-test'),
      ('legacy-open','course:legacy-open','ONLINE_COURSE','PAID','legacy-open');
      INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,acceptance_allowlist_json) VALUES
      ('legacy-test','course:legacy-test','legacy-test',100,'ACCEPTANCE_ONLY','["tester@example.test"]'),
      ('legacy-open','course:legacy-open','legacy-open',100,'PUBLIC','["tester@example.test"]');`);

    migrateV2(db);
    expect(journal().slice(0, through43.length)).toEqual(through43);
    expect(journal().slice(43)).toMatchObject([
      { version: "0044_reviewed_erasure_receipts.sql", sha256: "57a6c94824b814d7e21f1eabd5dc352dd5e65bc9a5870b595c16602791b0daa5" },
      { version: "0045_native_payment_executor.sql", sha256: "11547f21822275eb5c0f958f06288ba6265f41304084d9c83d8f88e3c5a92979" },
      { version: "0046_lesson_completions.sql", sha256: "acc12483c24f3f553d832ae0d9035b287d89c6d2ba3846c18769228f3638d6a6" },
      { version: "0047_course_playback_state.sql", sha256: "412469e6c24c79bd0c88ed1a4ce9cd4200c64591f057cae257a5384d5a306b51" },
      { version: "0048_acceptance_test_deadline.sql", sha256: "db85f1f5528e9404de30535e3e579d2e933f66359c364115898303d8a3e1bc73" },
    ]);
    expect(db.prepare(`SELECT o.sale_mode,o.acceptance_allowlist_json,o.acceptance_expires_at,p.version
      FROM offers o JOIN products p ON p.id=o.product_id ORDER BY sale_mode`).all()).toEqual([
      { sale_mode: "CLOSED", acceptance_allowlist_json: "[]", acceptance_expires_at: null, version: 2 },
      { sale_mode: "PUBLIC", acceptance_allowlist_json: "[]", acceptance_expires_at: null, version: 2 },
    ]);
    expect(db.prepare("SELECT state, dispatch_started FROM native_payments WHERE id='legacy-payment'").get())
      .toEqual({ state: "CREATING", dispatch_started: 1 });
    expect(() => db.prepare("UPDATE native_payments SET dispatch_started=0 WHERE id='legacy-payment'").run())
      .toThrow("NATIVE_PAYMENT_DISPATCH_ALREADY_STARTED");
    expect(interestRows()).toEqual(before);
    expect(journal().slice(0, prefix.length)).toEqual(prefix);
    const through48 = journal();
    migrateV2(db);
    expect(journal()).toEqual(through48);
    expect(assertReviewedRestoreSchema(db)).toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
