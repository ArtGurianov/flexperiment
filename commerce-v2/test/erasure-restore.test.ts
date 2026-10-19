import { labAccess, startLabGuest, prepareLabRecovery } from "../src/lab-tickets";
import { testOwnerLegalDecision } from "./fixtures/sales";
import { draftFiscalPolicy } from "../src/fiscal-policy";
import Database from "better-sqlite3";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { recordAuthenticatedConsents } from "../src/authenticated-consents";
import { currentLegalRelease, legalManifestHash } from "../src/legal-control";
import { ErasureLedgerStore, VerifiedErasureLedger, erasureSubject, issueErasureCheckpoint, type ErasureKeys } from "../src/erasure-ledger";
import { applyIsolatedRestoreErasure } from "../src/erasure-restore";
import { dispatchCampaign } from "../src/campaigns";
import { getEditorialPublished, publishEditorialDraft, saveEditorialDraft } from "../src/course-editorial";

const now = new Date("2026-10-11T15:00:00.000Z");
let root: string; let db: Database.Database; let ledger: ErasureLedgerStore;
let keys: ErasureKeys; let signer: { keyId: string; privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] };
const rowCount = (database: Database.Database, table: string) => (database.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flex-erasure-restore-"));
  mkdirSync(join(root, "merchant"), { mode: 0o700 }); mkdirSync(join(root, "ledger"), { mode: 0o700 });
  db = new Database(join(root, "merchant", "commerce.sqlite")); db.pragma("foreign_keys=ON"); db.pragma("journal_mode=WAL"); migrateV2(db);
  const signing = generateKeyPairSync("ed25519"); signer = { keyId: "signing-1", privateKey: signing.privateKey };
  keys = { signing: { "signing-1": signing.publicKey }, subject: { "subject-1": randomBytes(32) } };
  ledger = new ErasureLedgerStore({ directory: join(root, "ledger"), scope: "canary", keys, signer, forbiddenRoots: [join(root, "merchant")] });
  for (const id of ["deleted-customer", "other-customer"]) {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.test`);
    confirmSyntheticAccount(db, id);
    const user = `synthetic-user-${id}`;
    db.prepare('INSERT INTO "session"(id,expires_at,token,user_id) VALUES (?,?,?,?)').run(`session-${id}`, "2027-01-01", `token-${id}`, user);
    db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,access_token) VALUES (?,?, 'synthetic',?, 'secret')").run(`account-${id}`, id, user);
    db.prepare("INSERT INTO verification(id,identifier,value,expires_at) VALUES (?,?,?,?)")
      .run(`verification-${id}`, `hash-${id}`, JSON.stringify({ email: `${id}@example.test`, name: "Synthetic" }), "2027-01-01");
    db.prepare("INSERT INTO auth_email_outbox(id,recipient_normalized,kind,encrypted_payload,payload_sha256,state) VALUES (?,?,'MAGIC_LINK','synthetic-encrypted',?,'PENDING')")
      .run(`outbox-${id}`, `${id}@example.test`, "a".repeat(64));
    db.prepare("INSERT INTO playback_access_events(customer_id,event_type,reason,occurred_at) VALUES (?,'GRANT_ALLOWED','SYNTHETIC',?)").run(id, now.toISOString());
    db.prepare("INSERT INTO lesson_resume_positions(customer_id,lesson_ref,seconds,client_seq,client_ts) VALUES (?,'synthetic-lesson',10,1,?)").run(id, now.toISOString());
    db.prepare("INSERT INTO playback_grant_rate_limits(customer_id,window_start,request_count) VALUES (?,?,1)").run(id, now.toISOString());
  }
  db.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','synthetic-course','ONLINE_COURSE','FREE','synthetic-course');
    INSERT INTO free_course_enrollments(customer_id,product_id,product_version,enrolled_at) VALUES ('deleted-customer','product',1,'2026-10-11');
    INSERT INTO notification_campaigns(id,course_ref,payload_json,state) VALUES ('campaign','synthetic-course','{}','DRAFT');
    INSERT INTO notification_campaign_recipients(id,campaign_id,customer_id,state) VALUES ('recipient','campaign','deleted-customer','PENDING');`);
});
afterEach(() => { db.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); });
const tombstone = (kind: "ERASURE" | "MARKETING_SUPPRESSION" = "ERASURE") => ledger.append({ requestId: randomUUID(), kind,
  subject: erasureSubject(keys, "subject-1", "canary", { email: "deleted-customer@example.test", customerId: "deleted-customer", userId: "synthetic-user-deleted-customer" }) }, now);
const verified = () => { const bundle = ledger.export(); return VerifiedErasureLedger.read({ scope: "canary", bundle, keys,
  readCurrentCheckpoint: async nonce => issueErasureCheckpoint(ledger.export(), nonce, signer, keys, now), now: () => now }); };

describe("real isolated old SQLite backup + independent latest erasure journal", () => {
  it("cannot resurrect the deleted identity, sessions, consents, enrollment, progress or queued magic link", async () => {
    saveEditorialDraft(db, { expectedRevision: 0, actor: "synthetic-editor", document: {
      courseRef: "synthetic-course", title: "Synthetic course", slug: "synthetic-course", summary: "Recovery fixture",
      visibility: "LISTED", sections: [{ sectionRef: "synthetic-section", title: "Section", position: 0, visibility: "LISTED" }],
      lessons: [{ lessonRef: "synthetic-lesson", sectionRef: "synthetic-section", title: "Lesson", slug: "lesson",
        position: 0, visibility: "LISTED", freePreview: false }],
    } }, now.toISOString());
    publishEditorialDraft(db, { courseRef: "synthetic-course", expectedRevision: 1, expectedPublishedVersion: 0,
      idempotencyKey: "synthetic-publish", actor: "synthetic-editor" }, now.toISOString());
    db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES (?,?,?,?)`)
      .run("synthetic-lesson", "synthetic-video", now.toISOString(), now.toISOString());
    const published = getEditorialPublished(db, "synthetic-course");
    const archive = join(root, "before-erasure.sqlite"); await db.backup(archive); // Genuine SQLite online backup with WAL.
    tombstone(); const proof = await verified();
    const restored = new Database(archive); restored.pragma("foreign_keys=ON");
    try {
      const result = applyIsolatedRestoreErasure(restored, proof, keys, "canary", now);
      expect(result).toMatchObject({ erasedAccounts: 1, sequence: 1, runtimeAdmission: "PENDING", processorDeletion: "PENDING" });
      expect(restored.prepare("SELECT id FROM customers ORDER BY id").all()).toEqual([{ id: "other-customer" }]);
      expect(rowCount(restored, '"user"')).toBe(1);
      for (const table of ['"session"', "verification", "free_course_enrollments", "notification_campaign_recipients"]) expect(rowCount(restored, table)).toBe(0);
      expect(restored.prepare("SELECT customer_id FROM authenticated_consent_actions").all()).toEqual([{ customer_id: "other-customer" }]);
      expect(rowCount(restored, "authenticated_consent_events")).toBe(3);
      for (const table of ["lesson_resume_positions", "playback_grant_rate_limits", "playback_access_events"]) {
        expect(restored.prepare(`SELECT customer_id FROM ${table}`).all()).toEqual([{ customer_id: "other-customer" }]);
      }
      expect(restored.prepare("SELECT recipient_normalized FROM auth_email_outbox").all()).toEqual([{ recipient_normalized: "other-customer@example.test" }]);
      expect(restored.prepare("SELECT reason,removed_at FROM email_suppressions").get()).toEqual({ reason: "INDEPENDENT_ERASURE_LEDGER", removed_at: null });
      expect(getEditorialPublished(restored, "synthetic-course")).toEqual(published);
      expect(restored.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='synthetic-lesson'").get())
        .toEqual({ active_video_id: "synthetic-video" });
      const version = restored.prepare("SELECT document_json,content_hash FROM course_editorial_versions WHERE course_ref='synthetic-course'")
        .get() as { document_json: string; content_hash: string };
      expect(createHash("sha256").update(version.document_json).digest("hex")).toBe(version.content_hash);
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok"); expect(restored.pragma("foreign_key_check")).toEqual([]);
      const count = rowCount(restored, "schema_migrations"); expect(count).toBe(32);
      expect(applyIsolatedRestoreErasure(restored, await verified(), keys, "canary", now).erasedAccounts).toBe(0);
      // Original source has not been erased by the isolated proof.
      expect(rowCount(db, "customers")).toBe(2); expect(rowCount(db, '"session"')).toBe(2);
    } finally { restored.close(); }
  });
  it("erases unpurchased guest credentials and revokes unrelated guest/recovery links on isolated restore", async () => {
    const deletedToken = randomBytes(32).toString("base64url"), otherToken = randomBytes(32).toString("base64url");
    startLabGuest(db, { email: "deleted-customer@example.test", accessToken: deletedToken }, now.toISOString());
    const other = startLabGuest(db, { email: "other-customer@example.test", accessToken: otherToken }, now.toISOString());
    prepareLabRecovery(db, "other-customer@example.test", other.orderPublicId, "https://lab.example.test", now.toISOString());
    tombstone();
    applyIsolatedRestoreErasure(db, await verified(), keys, "canary", now);
    expect(() => labAccess(db, deletedToken)).toThrow("LAB_ACCESS_INVALID");
    expect(() => labAccess(db, otherToken)).toThrow("LAB_ACCESS_INVALID");
    expect(rowCount(db, "lab_guest_access")).toBe(1);
    expect(rowCount(db, "lab_ticket_recoveries")).toBe(0);
  });
  it("keeps a genuinely new same-email identity, but cannot revive old marketing authority", async () => {
    tombstone(); db.exec(`DELETE FROM free_course_enrollments;
      DELETE FROM authenticated_consent_actions WHERE customer_id='deleted-customer';
      DELETE FROM notification_campaign_recipients; DELETE FROM lesson_resume_positions WHERE customer_id='deleted-customer';
      DELETE FROM playback_grant_rate_limits WHERE customer_id='deleted-customer';
      DELETE FROM customers WHERE id='deleted-customer'; DELETE FROM "user" WHERE id='synthetic-user-deleted-customer';`);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('new-customer',?)").run("deleted-customer@example.test");
    confirmSyntheticAccount(db, "new-customer");
    applyIsolatedRestoreErasure(db, await verified(), keys, "canary", now);
    expect(db.prepare("SELECT id FROM customers WHERE id='new-customer'").get()).toEqual({ id: "new-customer" });
    expect(db.prepare("SELECT removed_at FROM email_suppressions WHERE email_normalized=?").get("deleted-customer@example.test")).toEqual({ removed_at: null });
  });
  it("reconstructs a later unsubscribe over an older positive authenticated consent and prevents dispatch", async () => {
    const release = currentLegalRelease(db, "COURSES")!;
    recordAuthenticatedConsents(db, "deleted-customer", { storefront: "COURSES", releaseVersion: release.version,
      manifestSha256: legalManifestHash(release.manifest), actionKey: "synthetic-positive-action", personalDataConsent: true, accountTermsAccepted: true, marketingConsent: true });
    db.prepare("UPDATE notification_campaigns SET state='CONFIRMED',confirmed_at=?,confirmed_by='isolated-test' WHERE id='campaign'").run(now.toISOString());
    const archive = join(root, "before-unsubscribe.sqlite"); await db.backup(archive); tombstone("MARKETING_SUPPRESSION");
    const restored = new Database(archive); restored.pragma("foreign_keys=ON");
    try {
      applyIsolatedRestoreErasure(restored, await verified(), keys, "canary", now);
      expect(rowCount(restored, "customers")).toBe(2);
      expect(restored.prepare("SELECT state FROM notification_campaign_recipients").get()).toEqual({ state: "SKIPPED_SUPPRESSED" });
      let calls = 0;
      await dispatchCampaign(restored, "campaign", { secret: "synthetic-unsubscribe", publicOrigin: "https://test.invalid",
        send: async () => { calls++; } }, now.toISOString());
      expect(calls).toBe(0);
    } finally { restored.close(); }
  });
  it.each(["financial", "audit", "owner-evidence", "binding", "fk", "unclassified", "column", "trigger", "keys", "scope", "expired"])("keeps the entire restore CLOSED/unchanged on %s uncertainty", async reason => {
    tombstone(); const proof = await verified();
    if (reason === "financial") db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      VALUES ('order','public','deleted-customer','FULFILLED',100,'{}',?,(SELECT id FROM legal_releases WHERE active=1 LIMIT 1))`).run("a".repeat(64));
    if (reason === "audit") db.exec(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json)
      VALUES ('audit','operator','SYNTHETIC','CUSTOMER','deleted-customer','{}')`);
    if (reason === "owner-evidence") {
      db.exec("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('evidence-offer','course:one','product',100,'CLOSED')");
      const { policyId } = draftFiscalPolicy(db, { actor: "owner", offerRef: "course:one", kind: "ONLINE_COURSE", itemName: "Synthetic",
        taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE" }, now.toISOString());
      testOwnerLegalDecision(db, policyId, "deleted-customer@example.test", now.toISOString());
      // Remove generic audit rows so the refusal specifically proves the retained legal evidence check.
      db.prepare("DELETE FROM audit_log WHERE subject_type IN ('FISCAL_POLICY','OWNER_LEGAL_DECISION')").run();
    }
    if (reason === "binding") db.exec("UPDATE customers SET email_normalized='changed@example.test' WHERE id='deleted-customer'");
    if (reason === "fk") db.exec(`CREATE TABLE unexpected_data(customer_id TEXT REFERENCES customers(id)); INSERT INTO unexpected_data VALUES ('deleted-customer')`);
    if (reason === "unclassified") db.exec(`CREATE TABLE shadow_profiles(email TEXT); INSERT INTO shadow_profiles VALUES ('deleted-customer@example.test')`);
    if (reason === "column") db.exec("ALTER TABLE cities ADD COLUMN customer_profile TEXT");
    if (reason === "trigger") db.exec(`CREATE TRIGGER shadow_copy BEFORE DELETE ON customers BEGIN
      INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json) VALUES ('copy','shadow','COPY','CUSTOMER',OLD.id,'{}'); END`);
    const before = db.serialize();
    expect(() => applyIsolatedRestoreErasure(db, proof, reason === "keys" ? { ...keys, subject: { "subject-1": randomBytes(32) } } : keys,
      reason === "scope" ? "production" : "canary", reason === "expired" ? new Date(now.getTime() + 60_001) : now)).toThrow(/ERASURE_/);
    expect(db.serialize()).toEqual(before);
    expect(rowCount(db, '"session"')).toBe(2); expect(rowCount(db, "customers")).toBe(2);
  });
  it("does no erasure when independent current checkpoint is unavailable", async () => {
    tombstone(); const before = db.serialize();
    await expect(VerifiedErasureLedger.read({ scope: "canary", bundle: ledger.export(), keys,
      readCurrentCheckpoint: async () => { throw new Error("unavailable"); } })).rejects.toThrow("ERASURE_CHECKPOINT_UNAVAILABLE");
    expect(db.serialize()).toEqual(before);
  });
});
