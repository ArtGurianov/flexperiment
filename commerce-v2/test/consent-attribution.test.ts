import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyV2Migration, migrateV2 } from "../src/db";

let db: Database.Database;
beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys=ON"); });
afterEach(() => db.close());
const owner = () => {
  db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run("user", "Student", "student@example.test");
  db.prepare("INSERT INTO customers(id,email_normalized,auth_user_id) VALUES (?,?,?)").run("customer", "student@example.test", "user");
};
const legacy = () => db.prepare(`INSERT INTO marketing_consents
  (id,customer_id,granted,document_version,document_sha256,recorded_at,source)
  VALUES ('legacy','customer',1,'v1',?,'2026-10-11T10:00:00Z','MAGIC_LINK_INITIATION')`).run("a".repeat(64));

describe("consent attribution SQL boundary", () => {
  it("preserves the exact historical evidence when upgrading schema22, without assigning ownership", () => {
    const directory = join(process.cwd(), "commerce-v2/migrations");
    for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0023").sort()) {
      applyV2Migration(db, file, readFileSync(join(directory, file), "utf8"));
    }
    owner(); legacy();
    const before = db.prepare("SELECT * FROM marketing_consents").get();
    migrateV2(db);
    expect(db.prepare("SELECT * FROM marketing_consents").get()).toEqual({ ...before as object,
      evidence_status: "LEGACY_UNQUALIFIED", confirmed_auth_user_id: null, confirmed_at: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM marketing_consents").get()).toEqual({ n: 1 });
  });

  it.each(["account_consents", "marketing_consents"])("rejects forged authenticated proof on %s", (table) => {
    migrateV2(db); owner();
    const kind = table === "account_consents" ? "kind" : "granted";
    const value = table === "account_consents" ? "PERSONAL_DATA" : 1;
    const insert = db.prepare(`INSERT INTO ${table}
      (id,customer_id,${kind},document_version,document_sha256,recorded_at,source,evidence_status,confirmed_auth_user_id,confirmed_at)
      VALUES ('proof','customer',?,'v1',?,'2026-10-11T10:00:00Z',?,'AUTHENTICATED_ACTION',?,?)`);
    const error = table === "account_consents" ? "ACCOUNT_CONSENT_ATTRIBUTION_INVALID" : "MARKETING_CONSENT_ATTRIBUTION_INVALID";
    for (const [source, user, at] of [
      ["MAGIC_LINK_INITIATION", "user", "2026-10-11T10:00:00Z"],
      ["AUTHENTICATED_ACCOUNT_ACTION", null, "2026-10-11T10:00:00Z"],
      ["AUTHENTICATED_ACCOUNT_ACTION", "user", "not-a-time"],
    ]) expect(() => insert.run(value, "a".repeat(64), source, user, at)).toThrow(error);
    db.prepare('UPDATE "user" SET email_verified=0').run();
    expect(() => insert.run(value, "a".repeat(64), "AUTHENTICATED_ACCOUNT_ACTION", "user", "2026-10-11T10:00:00Z")).toThrow(error);
    db.prepare('UPDATE "user" SET email_verified=1,email=?').run("foreign@example.test");
    expect(() => insert.run(value, "a".repeat(64), "AUTHENTICATED_ACCOUNT_ACTION", "user", "2026-10-11T10:00:00Z")).toThrow(error);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
  });

  it("never retroactively promotes an earlier intent after email verification", () => {
    migrateV2(db); owner(); legacy();
    expect(() => db.prepare(`UPDATE marketing_consents SET evidence_status='AUTHENTICATED_ACTION',
      confirmed_auth_user_id='user',confirmed_at='2026-10-11T10:00:00Z',source='AUTHENTICATED_ACCOUNT_ACTION'`).run())
      .toThrow("MARKETING_CONSENT_HISTORY_IMMUTABLE");
    expect(db.prepare("SELECT evidence_status FROM marketing_consents").get()).toEqual({ evidence_status: "LEGACY_UNQUALIFIED" });
  });

  it("does not qualify a historical grant merely because its current customer is verified", async () => {
    migrateV2(db); owner(); legacy();
    const { createCampaign, confirmCampaign } = await import("../src/campaigns");
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','p','ONLINE_COURSE','FREE','course')").run();
    const campaign = createCampaign(db, { courseRef: "course", idempotencyKey: "legacy:intent-control", payload: {
      subject: "Test", message: "Test", course: { title: "Test", slug: "test", contentVersion: "v1" },
      lessons: [{ lessonRef: "lesson", title: "Test", slug: "test" }],
    } });
    expect(confirmCampaign(db, campaign.id, "isolated-test")).toMatchObject({ recipients: 0 });
  });
});
