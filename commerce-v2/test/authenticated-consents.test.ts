import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { activateLegalRelease, legalManifestHash, type LegalReleaseManifest } from "../src/legal-control";
import { authenticatedConsentStatus, recordAuthenticatedConsents, type AuthenticatedConsentInput } from "../src/authenticated-consents";
import { recordUnverifiedAccountIntent } from "../src/customers";
import { createCommerceV2App } from "../src/app";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { confirmCampaign, createCampaign, dispatchCampaign, unsubscribeCustomer, unsubscribeToken } from "../src/campaigns";

let db: Database.Database;
const manifest: LegalReleaseManifest = { stage: "A", documents: ["privacy", "personal_data", "account_terms", "marketing_consent"].map(kind => ({
  kind, version: "synthetic-v1", sha256: "a".repeat(64), url: `https://test.invalid/legal/${kind}`,
})) };
const input: AuthenticatedConsentInput = { storefront: "COURSES", releaseVersion: "synthetic-release", manifestSha256: legalManifestHash(manifest),
  actionKey: "synthetic-action-0001", personalDataConsent: true, accountTermsAccepted: true, marketingConsent: false };
const record = (changes = {}) => recordAuthenticatedConsents(db, "customer", { ...input, ...changes }, "2026-10-11T10:00:00Z");
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Synthetic','owner@example.test',1);
    INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('customer','owner@example.test','user');`);
  activateLegalRelease(db, { storefront: "COURSES", version: input.releaseVersion, manifest, actor: "isolated-test" });
});
afterEach(() => db.close());
describe("new authenticated consent evidence, separate from historical intents", () => {
  it("does not promote earlier intent, and appends explicit confirmed actions for the same version", () => {
    recordUnverifiedAccountIntent(db, "customer", { personalDataVersion: "synthetic-v1", personalDataSha256: "a".repeat(64),
      accountTermsVersion: "synthetic-v1", accountTermsSha256: "a".repeat(64), marketingConsent: true,
      marketingDocumentVersion: "synthetic-v1", marketingDocumentSha256: "a".repeat(64) });
    const old = db.prepare("SELECT * FROM account_consents ORDER BY id").all();
    expect(authenticatedConsentStatus(db, "customer", "COURSES").requiredChoicesConfirmed).toBe(false);
    expect(record().status).toMatchObject({ requiredChoicesConfirmed: true, choices: { marketing_consent: false } });
    expect(record({ actionKey: "synthetic-action-0002", marketingConsent: true }).status.choices.marketing_consent).toBe(true);
    expect(db.prepare("SELECT * FROM account_consents ORDER BY id").all()).toEqual(old);
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_actions").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_events").get()).toEqual({ n: 6 });
  });
  it("deduplicates one action and rejects reuse for a different choice", () => {
    const first = record(); expect(record()).toMatchObject({ actionId: first.actionId, replayed: true });
    expect(() => record({ marketingConsent: true })).toThrow("CONSENT_ACTION_KEY_CONFLICT");
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_events").get()).toEqual({ n: 3 });
  });
  it.each([{ personalDataConsent: false }, { accountTermsAccepted: false }, { marketingConsent: "true" }, { actionKey: "x" },
    { manifestSha256: "invalid" }, { storefront: "PARTNER" }])("refuses malformed/missing independent choices %j", change => {
    expect(() => record(change)).toThrow("AUTHENTICATED_CONSENT_INPUT_INVALID");
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_actions").get()).toEqual({ n: 0 });
  });
  it.each(["unverified", "mismatched", "unbound"])("refuses %s account identity", condition => {
    if (condition === "unverified") db.exec('UPDATE "user" SET email_verified=0');
    if (condition === "mismatched") db.prepare('UPDATE "user" SET email=?').run("other@example.test");
    if (condition === "unbound") db.exec('UPDATE customers SET auth_user_id=NULL');
    expect(() => record()).toThrow("VERIFIED_ACCOUNT_REQUIRED");
    expect(authenticatedConsentStatus(db, "customer", "COURSES").requiredChoicesConfirmed).toBe(false);
  });
  it("rejects stale release/hash and requires new actions after active release replacement", () => {
    record(); expect(() => record({ manifestSha256: "b".repeat(64) })).toThrow("LEGAL_RELEASE_STALE");
    activateLegalRelease(db, { storefront: "COURSES", version: "synthetic-release-2", manifest, actor: "isolated-test" });
    expect(() => record()).toThrow("LEGAL_RELEASE_STALE");
    expect(authenticatedConsentStatus(db, "customer", "COURSES").requiredChoicesConfirmed).toBe(false);
  });
  it("keeps storefronts separate and creates no financial or marketing-suppression mutations", () => {
    record({ marketingConsent: true });
    expect(authenticatedConsentStatus(db, "customer", "LAB")).toMatchObject({ releaseVersion: null, requiredChoicesConfirmed: false });
    for (const table of ["orders", "checkout_attempts", "email_suppressions", "marketing_consents"]) {
      expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
  });
  it("rejects SQL proof forgery and updates; rolls back a partial batch on event failure", () => {
    record();
    expect(() => db.exec("UPDATE authenticated_consent_events SET granted=0")).toThrow("AUTHENTICATED_CONSENT_EVENT_IMMUTABLE");
    expect(() => db.exec("UPDATE authenticated_consent_actions SET recorded_at='now'")).toThrow("AUTHENTICATED_CONSENT_ACTION_IMMUTABLE");
    expect(() => db.prepare(`INSERT INTO authenticated_consent_events(action_id,kind,granted,document_version,document_sha256)
      VALUES ((SELECT id FROM authenticated_consent_actions LIMIT 1),'account_terms',1,'forged',?)`).run("b".repeat(64)))
      .toThrow("AUTHENTICATED_CONSENT_DOCUMENT_INVALID");
    db.exec(`CREATE TRIGGER synthetic_fail_batch BEFORE INSERT ON authenticated_consent_events WHEN NEW.kind='marketing_consent'
      BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAILURE'); END;`);
    expect(() => record({ actionKey: "synthetic-action-0003" })).toThrow("SYNTHETIC_FAILURE");
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_actions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_events").get()).toEqual({ n: 3 });
  });
  it("does not inherit another user's events after binding or verification changes", () => {
    record(); db.exec('UPDATE "user" SET email_verified=0');
    expect(authenticatedConsentStatus(db, "customer", "COURSES").requiredChoicesConfirmed).toBe(false);
  });
});

describe("latest authenticated marketing action at campaign boundaries", () => {
  const campaign = () => createCampaign(db, { courseRef: "course-one", idempotencyKey: "synthetic-campaign",
    payload: { subject: "Synthetic", message: "Synthetic", course: { title: "Synthetic", slug: "synthetic", contentVersion: "v1" },
      lessons: [{ lessonRef: "lesson-one", title: "Synthetic", slug: "synthetic" }] } });
  beforeEach(() => {
    db.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('synthetic-product','course:synthetic','ONLINE_COURSE','PAID','course-one');
      INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      SELECT 'synthetic-order','synthetic-public','customer','FULFILLED',100,'{}','${"a".repeat(64)}',id FROM legal_releases WHERE active=1;
      INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
      VALUES ('synthetic-line','synthetic-order','synthetic-product','synthetic-offer','Synthetic',100,'synthetic-v1');
      INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
      VALUES ('synthetic-grant','customer','COURSE','course-one','synthetic-line','now');`);
    db.prepare(`INSERT INTO marketing_consents(id,customer_id,granted,document_version,document_sha256,recorded_at,source,
      evidence_status,confirmed_auth_user_id,confirmed_at) VALUES ('legacy','customer',1,'synthetic-v1',?,'now',
      'AUTHENTICATED_ACCOUNT_ACTION','AUTHENTICATED_ACTION','user','now')`).run("a".repeat(64));
  });
  it("an explicit negative action overrides a prior qualified legacy grant", () => {
    record(); expect(confirmCampaign(db, campaign().id, "synthetic-author").recipients).toBe(0);
  });
  it("allows a new grant but never removes one-click suppression", () => {
    record({ marketingConsent: true });
    unsubscribeCustomer(db, unsubscribeToken("customer", "synthetic-secret"), "synthetic-secret");
    record({ actionKey: "synthetic-action-0002", marketingConsent: true });
    expect(confirmCampaign(db, campaign().id, "synthetic-author").recipients).toBe(0);
    expect(db.prepare("SELECT removed_at FROM email_suppressions").get()).toEqual({ removed_at: null });
  });
  it("rechecks a later decline immediately before dispatch", async () => {
    record({ marketingConsent: true }); const queued = campaign();
    expect(confirmCampaign(db, queued.id, "synthetic-author").recipients).toBe(1);
    record({ actionKey: "synthetic-action-0002" }); let sent = 0;
    await dispatchCampaign(db, queued.id, { secret: "synthetic-secret", publicOrigin: "https://test.invalid", send: async () => { sent++; } });
    expect(sent).toBe(0);
    expect(db.prepare("SELECT state FROM notification_campaign_recipients").get()).toEqual({ state: "SKIPPED_NO_CONSENT" });
  });
  it("does not fall back to the old grant after new evidence becomes stale", () => {
    record({ marketingConsent: true });
    activateLegalRelease(db, { storefront: "COURSES", version: "synthetic-release-2", manifest, actor: "isolated-test" });
    expect(confirmCampaign(db, campaign().id, "synthetic-author").recipients).toBe(0);
  });
});

describe("session-authenticated consent API boundary", () => {
  const server = (authenticated = true) => createCommerceV2App({ db, config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" }),
    sourceCommit: "a".repeat(40), serviceToken: "synthetic-service-secret", authenticateCustomer: async () => authenticated ? "customer" : null,
    origins: { platform: "https://platform.test", lab: "https://lab.test", api: "https://api.test", admin: "https://admin.test" } });
  const post = (body: unknown, origin?: string, authenticated = true) => server(authenticated).request("/v1/me/consents", { method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  it("refuses guests, absent/foreign origin, stale release and unverified account", async () => {
    expect((await post(input, "https://platform.test", false)).status).toBe(401);
    expect((await post(input)).status).toBe(403);
    expect((await post(input, "https://foreign.test")).status).toBe(403);
    expect((await post({ ...input, releaseVersion: "stale" }, "https://platform.test")).status).toBe(409);
    db.exec('UPDATE "user" SET email_verified=0');
    expect(await (await post(input, "https://platform.test")).json()).toEqual({ code: "VERIFIED_ACCOUNT_REQUIRED" });
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_actions").get()).toEqual({ n: 0 });
  });
  it("derives identity from the session, ignores forged actor/customer and provides no-store read-back", async () => {
    const response = await post({ ...input, customerId: "foreign", authUserId: "foreign", actor: "forged" }, "https://platform.test");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(db.prepare("SELECT customer_id,auth_user_id FROM authenticated_consent_actions").get()).toEqual({ customer_id: "customer", auth_user_id: "user" });
    const read = await server().request("/v1/me/consents?storefront=COURSES");
    expect(await read.json()).toMatchObject({ requiredChoicesConfirmed: true, choices: { marketing_consent: false } });
    expect((await server().request("/v1/me/consents?storefront=PARTNER")).status).toBe(422);
  });
  it("does not open registration or admit writes when no legal release exists", async () => {
    db.exec("UPDATE legal_releases SET active=0");
    expect(await (await post(input, "https://platform.test")).json()).toEqual({ code: "LEGAL_RELEASE_NOT_FOUND" });
  });
  it("bounds untrusted input and never records malformed bodies", async () => {
    expect((await post({ ...input, reflected: "x".repeat(8192) }, "https://platform.test")).status).toBe(413);
    expect((await post(null, "https://platform.test")).status).toBe(422);
    const malformed = await server().request("/v1/me/consents", { method: "POST", headers: { origin: "https://platform.test" }, body: "{" });
    expect(malformed.status).toBe(409);
    expect(await malformed.json()).toEqual({ code: "CONSENT_WRITE_UNCONFIRMED" });
    expect(db.prepare("SELECT COUNT(*) n FROM authenticated_consent_actions").get()).toEqual({ n: 0 });
  });
});
