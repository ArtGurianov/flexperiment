import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { authenticatedConsentStatus, authenticatedMarketingChoice, recordAuthenticatedConsents,
  recordAuthenticatedMarketingChoice } from "../src/authenticated-consents";
import { confirmCampaign, createCampaign, unsubscribeCustomer, unsubscribeToken } from "../src/campaigns";
import { migrateV2 } from "../src/db";
import { activateLegalRelease, legalManifestHash, type LegalReleaseManifest } from "../src/legal-control";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";

// G-18 (FLEX-128 G-05): the account marketing switch records only the marketing choice actually made.
let db: Database.Database;
const manifest: LegalReleaseManifest = { stage: "A", documents: ["privacy", "personal_data", "account_terms", "marketing_consent"].map(kind => ({
  kind, version: "synthetic-v1", sha256: "a".repeat(64), url: `https://test.invalid/legal/${kind}`,
})) };
const release = { storefront: "COURSES" as const, releaseVersion: "synthetic-release", manifestSha256: legalManifestHash(manifest) };
const at = "2026-11-21T10:00:00.000Z";
const confirmRequired = () => recordAuthenticatedConsents(db, "customer", { ...release, actionKey: "synthetic-required-0001",
  personalDataConsent: true, accountTermsAccepted: true, marketingConsent: true }, at);
const marketing = (marketingConsent: boolean, actionKey: string, expectedActionSequence: number) =>
  recordAuthenticatedMarketingChoice(db, "customer", { ...release, actionKey, marketingConsent, expectedActionSequence }, at);
const events = () => db.prepare(`SELECT a.action_key,e.kind,e.granted FROM authenticated_consent_events e
  JOIN authenticated_consent_actions a ON a.id=e.action_id ORDER BY e.sequence`).all();

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  db.exec(`INSERT INTO "user"(id,name,email,email_verified) VALUES ('user','Synthetic','owner@example.test',1);
    INSERT INTO customers(id,email_normalized,auth_user_id) VALUES ('customer','owner@example.test','user');`);
  activateLegalRelease(db, { storefront: "COURSES", version: release.releaseVersion, manifest, actor: "isolated-test" });
});
afterEach(() => db.close());

describe("marketing-only authenticated action", () => {
  it("writes exactly one marketing event and keeps the earlier required choices in force", () => {
    confirmRequired();
    const result = marketing(false, "synthetic-marketing-0001", 3);
    expect(result).toMatchObject({ replayed: false, status: { requiredChoicesConfirmed: true, actionSequence: 4,
      choices: { personal_data: true, account_terms: true, marketing_consent: false } } });
    expect(events()).toEqual([
      { action_key: "synthetic-required-0001", kind: "personal_data", granted: 1 },
      { action_key: "synthetic-required-0001", kind: "account_terms", granted: 1 },
      { action_key: "synthetic-required-0001", kind: "marketing_consent", granted: 1 },
      { action_key: "synthetic-marketing-0001", kind: "marketing_consent", granted: 0 },
    ]);
    expect(authenticatedMarketingChoice(db, "customer")).toBe(false);
    marketing(true, "synthetic-marketing-0002", 4);
    expect(authenticatedMarketingChoice(db, "customer")).toBe(true);
    expect(authenticatedConsentStatus(db, "customer", "COURSES").requiredChoicesConfirmed).toBe(true);
  });

  it("is idempotent per key, refuses key reuse for another choice or shape and a stale sequence", () => {
    confirmRequired();
    marketing(false, "synthetic-marketing-0001", 3);
    expect(marketing(false, "synthetic-marketing-0001", 3).replayed).toBe(true);
    expect(() => marketing(true, "synthetic-marketing-0001", 4)).toThrow("CONSENT_ACTION_KEY_CONFLICT");
    // The full-form key cannot be replayed as a marketing-only action.
    expect(() => marketing(true, "synthetic-required-0001", 4)).toThrow("CONSENT_ACTION_KEY_CONFLICT");
    expect(() => marketing(true, "synthetic-marketing-0002", 3)).toThrow("CONSENT_STATE_STALE");
    expect(events()).toHaveLength(4);
  });

  it("refuses accounts without their own required choices, unverified identity and stale releases", () => {
    expect(() => marketing(true, "synthetic-marketing-0001", 0)).toThrow("REQUIRED_CHOICES_UNCONFIRMED");
    confirmRequired();
    expect(() => recordAuthenticatedMarketingChoice(db, "customer", { ...release, manifestSha256: "b".repeat(64),
      actionKey: "synthetic-marketing-0002", marketingConsent: true, expectedActionSequence: 3 }, at)).toThrow("LEGAL_RELEASE_STALE");
    db.exec(`UPDATE "user" SET email_verified=0`);
    expect(() => marketing(true, "synthetic-marketing-0003", 3)).toThrow("VERIFIED_ACCOUNT_REQUIRED");
    for (const bad of [{ marketingConsent: "true" }, { actionKey: "x" }, { expectedActionSequence: -1 }, { storefront: "PARTNER" }]) {
      expect(() => recordAuthenticatedMarketingChoice(db, "customer", { ...release, actionKey: "synthetic-marketing-0004",
        marketingConsent: true, expectedActionSequence: 3, ...bad } as never, at)).toThrow("AUTHENTICATED_CONSENT_INPUT_INVALID");
    }
    expect(events()).toHaveLength(3);
  });

  it("does not resume campaigns after a one-click unsubscribe", () => {
    db.exec(`INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('synthetic-product','course:synthetic','ONLINE_COURSE','PAID','course-one');
      INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id)
      SELECT 'synthetic-order','synthetic-public','customer','FULFILLED',100,'{}','${"a".repeat(64)}',id FROM legal_releases WHERE active=1;
      INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
      VALUES ('synthetic-line','synthetic-order','synthetic-product','synthetic-offer','Synthetic',100,'synthetic-v1');
      INSERT INTO course_entitlements(id,customer_id,scope,course_ref,source_order_line_id,granted_at)
      VALUES ('synthetic-grant','customer','COURSE','course-one','synthetic-line','now');`);
    confirmRequired();
    unsubscribeCustomer(db, unsubscribeToken("customer", "synthetic-secret"), "synthetic-secret");
    marketing(false, "synthetic-marketing-0001", 3);
    marketing(true, "synthetic-marketing-0002", 4);
    const campaign = createCampaign(db, { courseRef: "course-one", idempotencyKey: "synthetic-campaign",
      payload: { subject: "Synthetic", message: "Synthetic", course: { title: "Synthetic", slug: "synthetic", contentVersion: "v1" },
        lessons: [{ lessonRef: "lesson-one", title: "Synthetic", slug: "synthetic" }] } });
    expect(confirmCampaign(db, campaign.id, "synthetic-author").recipients).toBe(0);
    expect(db.prepare("SELECT removed_at FROM email_suppressions").get()).toEqual({ removed_at: null });
  });

  it("is reachable only for the session's own account from the storefront origin", async () => {
    confirmRequired();
    const app = (signedIn = true) => createCommerceV2App({ db, config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" }),
      sourceCommit: "a".repeat(40), serviceToken: "synthetic-service-secret", authenticateCustomer: async () => signedIn ? "customer" : null,
      origins: { platform: "https://platform.test", lab: "https://lab.test", api: "https://api.test", admin: "https://admin.test" } });
    const post = (body: unknown, origin = "https://platform.test", signedIn = true) => app(signedIn).request("/v1/me/consents/marketing", {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
    const body = { ...release, actionKey: "synthetic-marketing-0001", marketingConsent: false, expectedActionSequence: 3, customerId: "forged" };
    expect((await post(body, "https://platform.test", false)).status).toBe(401);
    expect((await post(body, "https://evil.test")).status).toBe(403);
    expect(await (await post({ ...body, expectedActionSequence: undefined })).json()).toEqual({ code: "CONSENT_PRECONDITION_REQUIRED" });
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ replayed: false, status: { requiredChoicesConfirmed: true, choices: { marketing_consent: false } } });
    expect(await (await post({ ...body, actionKey: "synthetic-marketing-0002" })).json()).toEqual({ code: "CONSENT_STATE_STALE" });
    expect(events()).toHaveLength(4);
  });
});
