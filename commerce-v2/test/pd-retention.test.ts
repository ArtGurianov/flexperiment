import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { migrateV2 } from "../src/db";
import { getOrCreateCustomer, recordUnverifiedAccountIntent } from "../src/customers";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { cleanupOfflinePersonalData, expiredBackupCandidates, type RetentionPolicy, type RetentionHold } from "../src/pd-retention";

const now = new Date("2026-10-11T15:00:00.000Z");
// Explicit isolated test policy ONLY, not an owner-approved/live/legal duration.
const policy: RetentionPolicy = { version: 1, referenceSha256: "a".repeat(64), expiredCredentialsGraceSeconds: 600,
  authOutboxMaxAgeSeconds: 3600, playbackTelemetryMaxAgeSeconds: 7200, unboundIntentsMaxAgeSeconds: 86400, backupArchiveMaxAgeSeconds: 86400 };
const old = "2026-10-01T12:00:00.000Z";
const recent = "2026-10-11T14:59:00.000Z";
const input = (holds: RetentionHold[] = []) => ({ mode: "STOPPED_OFFLINE" as const, policy, holds });
const hold = (category: RetentionHold["category"], kind: RetentionHold["subject"]["kind"], value: string): RetentionHold => ({
  category, subject: { kind, value }, justification: "SECURITY_INVESTIGATION", evidenceSha256: "b".repeat(64), reviewedBy: "synthetic-reviewer",
  reviewedAt: old, until: "2026-10-12T00:00:00.000Z",
});
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec("INSERT INTO customers(id,email_normalized) VALUES ('verified','verified@example.test')");
  confirmSyntheticAccount(db, "verified");
});
afterEach(() => db.close());
const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
const outbox = (id = "outbox", createdAt = old, updatedAt = old, email = "verified@example.test") =>
  db.prepare(`INSERT INTO auth_email_outbox(id,recipient_normalized,kind,encrypted_payload,payload_sha256,state,created_at,updated_at)
    VALUES (?,?,'MAGIC_LINK','synthetic-encrypted',?,'PENDING',?,?)`).run(id, email, "c".repeat(64), createdAt, updatedAt);
const verification = (id = "verification", expiry: string | number = old, email = "verified@example.test") =>
  db.prepare("INSERT INTO verification(id,identifier,value,expires_at) VALUES (?,?,?,?)").run(id, `hash-${id}`, JSON.stringify({ email }), expiry);
const session = (id = "session", expiry: string | number = old) =>
  db.prepare('INSERT INTO "session"(id,expires_at,token,user_id) VALUES (?,?,?,?)').run(id, expiry, `token-${id}`, "synthetic-user-verified");
const telemetry = (id = "verified", at = old) =>
  db.prepare("INSERT INTO playback_access_events(customer_id,event_type,reason,occurred_at) VALUES (?,'GRANT_ALLOWED','SYNTHETIC',?)").run(id, at);
const intent = (time = old) => {
  const customer = getOrCreateCustomer(db, "pending@example.test");
  db.prepare("UPDATE customers SET created_at=?,updated_at=? WHERE id=?").run(old, old, customer.id);
  recordUnverifiedAccountIntent(db, customer.id, { personalDataVersion: "synthetic-v1", accountTermsVersion: "synthetic-v1",
    personalDataSha256: "a".repeat(64), accountTermsSha256: "a".repeat(64), marketingConsent: false,
    marketingDocumentVersion: "synthetic-v1", marketingDocumentSha256: "a".repeat(64) }, time);
  return customer.id;
};

describe("explicit category retention in offline SQLite, no runtime/default policy", () => {
  it("cleans old expired credentials/outbox/telemetry while preserving active account, current credentials and consent history", () => {
    session(); session("current", "2026-10-12T00:00:00Z"); verification(); verification("current-verification", "2026-10-12T00:00:00Z");
    outbox(); outbox("recent-outbox", recent, recent); telemetry(); telemetry("verified", recent);
    const events = db.prepare("SELECT * FROM authenticated_consent_events").all();
    expect(cleanupOfflinePersonalData(db, input(), now)).toMatchObject({ expiredCredentials: 2, authOutbox: 1, playbackTelemetry: 1, unboundIntents: 0, runtimeInstallation: "PENDING" });
    expect(count('"user"')).toBe(1); expect(count("customers")).toBe(1); expect(count('"session"')).toBe(1); expect(count("verification")).toBe(1);
    expect(db.prepare("SELECT * FROM authenticated_consent_events").all()).toEqual(events);
    expect(count("orders")).toBe(0); expect(db.pragma("foreign_key_check")).toEqual([]);
  });
  it("supports actual Better Auth epoch-millisecond expiry and refuses grace-boundary deletion", () => {
    session("epoch-old", Date.parse(old)); verification("epoch-old", Date.parse(old));
    session("boundary", now.getTime() - 600_000); verification("boundary", now.getTime() - 600_000);
    expect(cleanupOfflinePersonalData(db, input(), now).expiredCredentials).toBe(2);
    expect(db.prepare('SELECT id FROM "session"').all()).toEqual([{ id: "boundary" }]);
  });
  it.each(["CUSTOMER", "USER", "EMAIL"] as const)("respects independently justified holds addressed by %s", kind => {
    session(); verification(); outbox(); telemetry();
    const ref = kind === "CUSTOMER" ? "verified" : kind === "USER" ? "synthetic-user-verified" : " Verified@Example.test ";
    const holds = [hold("EXPIRED_CREDENTIALS", kind, ref), hold("AUTH_OUTBOX", kind, ref), hold("PLAYBACK_TELEMETRY", kind, ref)];
    expect(cleanupOfflinePersonalData(db, input(holds), now)).toMatchObject({ expiredCredentials: 0, authOutbox: 0, playbackTelemetry: 0 });
  });
  it("purges only proven old unbound intents, never active/verified account or suppression", () => {
    const pending = intent(); db.exec("INSERT INTO email_suppressions(email_normalized,reason) VALUES ('pending@example.test','ONE_CLICK')");
    expect(cleanupOfflinePersonalData(db, input(), now).unboundIntents).toBe(1);
    expect(db.prepare("SELECT 1 FROM customers WHERE id=?").get(pending)).toBeUndefined();
    expect(db.prepare("SELECT id FROM customers").all()).toEqual([{ id: "verified" }]);
    expect(count("email_suppressions")).toBe(1); expect(count("authenticated_consent_events")).toBe(3);
  });
  it.each(["recent-intent", "user", "link", "outbox", "hold", "history", "audit", "progress"])("preserves an unbound profile with %s authority or fresh evidence", reason => {
    const pending = intent(reason === "recent-intent" ? recent : old);
    if (reason === "user") db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,\'Synthetic\',?,0)').run("unbound-user", "pending@example.test");
    if (reason === "link") verification("pending-link", "2026-10-12T00:00:00Z", "pending@example.test");
    if (reason === "outbox") outbox("pending-outbox", recent, recent, "pending@example.test");
    if (reason === "history") {
      // Build an isolated historical fixture; do NOT rewrite immutable intents.
      db.prepare("INSERT INTO account_consents(id,customer_id,kind,document_version,document_sha256,recorded_at,source,evidence_status) VALUES ('legacy',?,'PERSONAL_DATA','synthetic-legacy',?,?,'LEGACY','LEGACY_UNQUALIFIED')").run(pending, "a".repeat(64), old);
    }
    if (reason === "audit") db.prepare(`INSERT INTO audit_log(id,actor,action,subject_type,subject_ref,evidence_json) VALUES ('audit','synthetic','TEST','CUSTOMER',?,'{}')`).run(pending);
    if (reason === "progress") db.prepare("INSERT INTO lesson_resume_positions(customer_id,lesson_ref,seconds,client_seq,client_ts) VALUES (?,'lesson',0,0,?)").run(pending, old);
    const holds = reason === "hold" ? [hold("UNBOUND_INTENTS", "CUSTOMER", pending)] : [];
    expect(cleanupOfflinePersonalData(db, input(holds), now).unboundIntents).toBe(0);
    expect(db.prepare("SELECT id FROM customers WHERE id=?").get(pending)).toEqual({ id: pending });
  });
  it("rolls back all cleanup on an unknown verification shape or future policy/expired hold", () => {
    session(); verification(); db.prepare("UPDATE verification SET value='raw-token-unknown-shape'").run();
    const before = db.serialize(); expect(() => cleanupOfflinePersonalData(db, input(), now)).toThrow("RETENTION_VERIFICATION_CLASSIFICATION_REQUIRED");
    expect(db.serialize()).toEqual(before);
    const expired = { ...hold("EXPIRED_CREDENTIALS", "EMAIL", "verified@example.test"), until: "2026-10-10T00:00:00Z" };
    expect(() => cleanupOfflinePersonalData(db, input([expired]), now)).toThrow("RETENTION_HOLD_REVIEW_REQUIRED");
    expect(() => cleanupOfflinePersonalData(db, { ...input(), policy: { ...policy, authOutboxMaxAgeSeconds: 0 } }, now)).toThrow("RETENTION_POLICY_OR_HOLD_INVALID");
    expect(db.serialize()).toEqual(before);
  });
  it("refuses malformed timestamps with sanitized errors and no partial deletion", () => {
    session(); outbox(); db.exec("UPDATE auth_email_outbox SET updated_at='RAW_SECRET_REFLECTED'");
    const before = db.serialize(); expect(() => cleanupOfflinePersonalData(db, input(), now)).toThrow("RETENTION_TIMESTAMP_INVALID"); expect(db.serialize()).toEqual(before);
  });
  it("never deletes outbox for a recently issued or recently updated link, even with a shorter category policy", () => {
    outbox("new-link", recent, old); outbox("recent-update", old, recent);
    expect(cleanupOfflinePersonalData(db, input(), now).authOutbox).toBe(0); expect(count("auth_email_outbox")).toBe(2);
  });
  it("respects USER holds even before the customer is bound to the auth user", () => {
    db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,\'Synthetic\',?,0)').run("unbound-user", "pending@example.test");
    verification("unbound", old, "pending@example.test"); outbox("unbound", old, old, "pending@example.test");
    expect(cleanupOfflinePersonalData(db, input([hold("EXPIRED_CREDENTIALS", "USER", "unbound-user"), hold("AUTH_OUTBOX", "USER", "unbound-user")]), now))
      .toMatchObject({ expiredCredentials: 0, authOutbox: 0 });
  });
  it("binds exact policy bytes separately from the reviewed source reference", () => {
    const first = cleanupOfflinePersonalData(db, input(), now);
    const second = cleanupOfflinePersonalData(db, { ...input(), policy: { ...policy, authOutboxMaxAgeSeconds: 3601 } }, now);
    expect(first.policyReferenceSha256).toBe(second.policyReferenceSha256); expect(first.policySha256).not.toBe(second.policySha256);
  });
  it("refuses unbounded or wrong-category holds rather than silently ignoring them", () => {
    expect(() => cleanupOfflinePersonalData(db, input([{ ...hold("AUTH_OUTBOX", "EMAIL", "verified@example.test"), until: "2040-01-01T00:00:00Z" }]), now)).toThrow("RETENTION_HOLD_INVALID");
    expect(() => cleanupOfflinePersonalData(db, input([hold("AUTH_OUTBOX", "BACKUP_OBJECT", "object")]), now)).toThrow("RETENTION_HOLD_INVALID");
  });
  it.each(["table", "column", "trigger"])("refuses unknown %s semantics before any deletion", change => {
    session();
    if (change === "table") db.exec("CREATE TABLE unknown_pii(customer_id TEXT)");
    if (change === "column") db.exec("ALTER TABLE customers ADD COLUMN unknown_pii TEXT");
    if (change === "trigger") db.exec("CREATE TRIGGER unknown_purge AFTER DELETE ON customers BEGIN SELECT 1; END");
    const before = db.serialize(); expect(() => cleanupOfflinePersonalData(db, input(), now)).toThrow("RETENTION_SCHEMA_REVIEW_REQUIRED");
    expect(db.serialize()).toEqual(before);
  });
  it.each(["2026-02-30T00:00:00Z", "2026-10-01T24:00:00Z", "2026-10-01T12:00:00+99:99"])("refuses normalized or invalid calendar date %s", invalid => {
    session("invalid", invalid); const before = db.serialize();
    expect(() => cleanupOfflinePersonalData(db, input(), now)).toThrow("RETENTION_TIMESTAMP_INVALID"); expect(db.serialize()).toEqual(before);
  });
});

describe("archive age planning independent of count retention, no deletion", () => {
  const archiveInput = () => ({ policy, holds: [] as RetentionHold[], scope: "commerce-canary" as const, verifiedCurrentObject: "current",
    objects: [
      { objectRef: "current", scope: "commerce-canary", createdAt: old, sha256: "1".repeat(64) },
      { objectRef: "old-cloud", scope: "commerce-canary", createdAt: old, sha256: "2".repeat(64) },
      { objectRef: "old-mac", scope: "commerce-canary", createdAt: old, sha256: "3".repeat(64) },
      { objectRef: "production", scope: "commerce-production", createdAt: old, sha256: "4".repeat(64) },
      { objectRef: "recent", scope: "commerce-canary", createdAt: recent, sha256: "5".repeat(64) },
    ] });
  it("plans only exact old in-scope objects, retaining current/foreign/held copies", () => {
    const input = archiveInput(); input.holds.push(hold("BACKUP_ARCHIVES", "BACKUP_OBJECT", "old-mac"));
    expect(expiredBackupCandidates(input, now)).toMatchObject({ deletionAdmission: "PENDING", objects: [{ objectRef: "old-cloud", sha256: "2".repeat(64) }] });
  });
  it.each(["missing-current", "duplicate", "unknown-hash", "future", "expired-hold"])("refuses %s inventory ambiguity", reason => {
    const input = archiveInput();
    if (reason === "missing-current") input.verifiedCurrentObject = "missing";
    if (reason === "duplicate") input.objects.push(input.objects[0]);
    if (reason === "unknown-hash") input.objects[1].sha256 = "";
    if (reason === "future") input.objects[1].createdAt = "2027-01-01T00:00:00Z";
    if (reason === "expired-hold") input.holds.push({ ...hold("BACKUP_ARCHIVES", "BACKUP_OBJECT", "old-mac"), until: "2026-10-10T00:00:00Z" });
    expect(() => expiredBackupCandidates(input, now)).toThrow(/RETENTION_/);
  });
});
