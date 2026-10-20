import { resolvePlaybackAccess } from "../src/playback-access";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { qualifyTestFiscalPolicy, withTestStorefrontSwitch } from "./fixtures/sales";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { configureProduct } from "../src/catalog-control";
import { buyerEmailSha256 } from "../src/closed-paid-test";
import { confirmCheckout, MockPaymentRail, prepareCheckout } from "../src/checkout";
import { draftFiscalPolicy } from "../src/fiscal-policy";
import { activateLegalRelease, legalManifestHash } from "../src/legal-control";
import { authenticatedConsentStatus, recordAuthenticatedConsents } from "../src/authenticated-consents";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { createRefrefReadinessProbe } from "../src/readiness";
import { stageBLegalManifest, stageBLegalManifestJson } from "./fixtures/legal";
import { createCommerceV2App } from "../src/app";
import { issueCheckoutHandoffState } from "../src/checkout-handoff";
import { revokeEntitlementForOrderLine } from "../src/entitlements";

const email = "synthetic-buyer@example.test";
const env = {
  DEPLOY_ENV: "staging", PAYMENT_MODE: "refref", KINESCOPE_DELIVERY_MODE: "protected", MARKETING_BROADCASTS_ENABLED: "false",
  COMMERCE_V2_ENVIRONMENT: "canary", ERASURE_SCOPE: "canary", ERASURE_FENCING_ENABLED: "true",
  CLOSED_PAID_TEST_PROFILE: "art39-test-course-rub1-v1", CLOSED_PAID_TEST_BUYER_SHA256: buyerEmailSha256(email),
  CLOSED_PAID_TEST_REFREF_SOURCE: "b".repeat(40), CLOSED_PAID_TEST_LEGAL_VERSION: "synthetic-paid-v1",
  CLOSED_PAID_TEST_LEGAL_SHA256: legalManifestHash(stageBLegalManifest),
  PLATFORM_ORIGIN: "https://canary-platform.flexperiment.ru", LAB_ORIGIN: "https://canary-lab.flexperiment.ru",
  ADMIN_ORIGIN: "https://canary-admin.flexperiment.ru", API_ORIGIN: "https://canary-api.flexperiment.ru",
  REFREF_API_BASE_URL: "https://api.refref.ru/v1-rc", REFREF_CHECKOUT_ORIGIN: "https://checkout.refref.ru",
  REFREF_READINESS_URL: "https://ops.refref.ru/readyz", REFREF_API_KEY: "synthetic-key", REFREF_MERCHANT_SLUG: "flexperiment",
  REFREF_MERCHANT_ID: "00000000-0000-4000-8000-000000000001", REFREF_HANDOFF_STATE_SECRET: "synthetic-handoff-secret",
};
const config = withTestStorefrontSwitch(loadCommerceRuntimeConfig(env));
let db: Database.Database;
let rail: MockPaymentRail;
const input = { customerId: "buyer", customerEmail: email, offerRef: "course:test-course", previewIdempotencyKey: "review" };
const preview = () => prepareCheckout(db, rail, config, input);
const confirm = async (accepted: unknown, key = "pay") => {
  const review = await preview();
  if (review.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected review");
  return confirmCheckout(db, rail, config, { ...input, quoteId: review.quoteId, idempotencyKey: key,
    legalAcceptance: accepted as Parameters<typeof confirmCheckout>[3]["legalAcceptance"] });
};
const accept = { accepted: true, releaseVersion: env.CLOSED_PAID_TEST_LEGAL_VERSION, manifestSha256: env.CLOSED_PAID_TEST_LEGAL_SHA256, receiptEmail: email };
const accountConsent = (customerId = "buyer", storefront: "COURSES" | "LAB" = "COURSES") => {
  const current = authenticatedConsentStatus(db, customerId, storefront);
  return recordAuthenticatedConsents(db, customerId, { storefront, releaseVersion: current.releaseVersion!, manifestSha256: current.manifestSha256!,
    actionKey: "synthetic-account-choice", personalDataConsent: true, accountTermsAccepted: true, marketingConsent: false });
};
beforeEach(() => {
  db = new Database(":memory:"); migrateV2(db); rail = new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('buyer',?),('other','other@example.test')").run(email);
  db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (\'buyer-user\',\'Synthetic\',?,1),(\'other-user\',\'Other\',\'other@example.test\',1)').run(email);
  db.exec("UPDATE customers SET auth_user_id=id || '-user'");
  db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','COURSES',?,?,'2026-10-16',1)")
    .run(env.CLOSED_PAID_TEST_LEGAL_VERSION, stageBLegalManifestJson);
  configureProduct(db, config, { productRef: "course:test-course", offerRef: "course:test-course", courseRef: "test-course",
    kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "ACCEPTANCE_ONLY", priceKopecks: 100, acceptanceAllowlist: [email],
    paymentPurpose: "Synthetic test purchase", actor: "fixture", expectedVersion: 0 });
  applyCourseManifest(db, withManifestHash({ courseRef: "test-course", version: 1, visibility: "LISTED",
    sections: [{ sectionRef: "section", visibility: "LISTED" }],
    lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false }], operations: [] }));
  db.prepare("INSERT INTO video_upload_sessions(id,lesson_ref,video_id,status,uploader_endpoint) VALUES ('upload','lesson','synthetic-ready-video','READY','https://example.test/upload')").run();
  db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,duration_seconds,bound_at,updated_at) VALUES ('lesson','synthetic-ready-video',150,?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const policy = draftFiscalPolicy(db, { offerRef: "course:test-course", kind: "ONLINE_COURSE", itemName: "Доступ к курсу «Test Course»",
    taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PAYMENT", paymentObject: "SERVICE", actor: "fixture" });
  qualifyTestFiscalPolicy(db, policy.policyId, "fixture", new Date().toISOString());
});
afterEach(() => db.close());

describe("closed paid test admission", () => {
  beforeEach(() => { accountConsent(); accountConsent("other"); });
  it("preserves disabled defaults; a bare canary env flip cannot enable Refref", () => {
    expect(loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", MERCHANT_PROMOTION_PREFIX: "FX-" }).paymentMode).toBe("disabled");
    expect(() => loadCommerceRuntimeConfig({ ...env, CLOSED_PAID_TEST_PROFILE: undefined })).toThrow("CLOSED_PAID_TEST_PROFILE_REQUIRED");
    for (const change of [{ DEPLOY_ENV: "production" }, { CLOSED_PAID_TEST_BUYER_SHA256: "" }, { MARKETING_BROADCASTS_ENABLED: "true" },
      { REFREF_API_BASE_URL: "https://canary-api.refref.ru/v1-rc" }, { REFREF_READINESS_URL: "https://canary-ops.refref.ru/readyz" },
      { ERASURE_FENCING_ENABLED: "false" }, { KINESCOPE_DELIVERY_MODE: "open" }, { CLOSED_PAID_TEST_LEGAL_SHA256: "" }]) {
      expect(() => loadCommerceRuntimeConfig({ ...env, ...change })).toThrow();
    }
  });
  it("rejects another customer before any upstream resolution", async () => {
    const resolve = vi.spyOn(rail, "resolve");
    await expect(prepareCheckout(db, rail, config, { ...input, customerId: "other", customerEmail: "other@example.test" })).rejects.toThrow("CLOSED_PAID_TEST_SCOPE_REFUSED");
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each(["other-price", "PUBLIC", "extra-buyer"])("rechecks live scope %s even on preview replay", async change => {
    await preview(); const resolve = vi.spyOn(rail, "resolve");
    if (change === "other-price") db.prepare("UPDATE offers SET price_kopecks=101").run();
    if (change === "PUBLIC") db.prepare("UPDATE offers SET sale_mode='PUBLIC'").run();
    if (change === "extra-buyer") db.prepare("UPDATE offers SET acceptance_allowlist_json=?").run(JSON.stringify([email,"other@example.test"]));
    await expect(preview()).rejects.toThrow(); expect(resolve).not.toHaveBeenCalled();
  });
  it("refuses another open paid product at the catalog writer", () => {
    expect(() => configureProduct(db, config, { productRef: "course:other", offerRef: "course:other", courseRef: "other", kind: "ONLINE_COURSE",
      accessModel: "PAID", priceKopecks: 100, saleMode: "ACCEPTANCE_ONLY", acceptanceAllowlist: [email], paymentPurpose: "Synthetic", actor: "fixture", expectedVersion: 0 }))
      .toThrow("CLOSED_PAID_TEST_SCOPE_REFUSED");
  });
  it("rejects promo input and upstream discounts without creating a quote/order", async () => {
    await expect(prepareCheckout(db, rail, config, { ...input, checkoutCode: "CODE" })).rejects.toThrow("CLOSED_PAID_TEST_PRICE_REFUSED");
    const original = rail.resolve.bind(rail);
    vi.spyOn(rail, "resolve").mockImplementation(async request => {
      const result = await original(request); if (result.state === "PRICE_REVIEW_REQUIRED") result.quote = { ...result.quote, discountKopecks: 1, finalAmountKopecks: 99 };
      return result;
    });
    await expect(preview()).rejects.toThrow("CLOSED_PAID_TEST_PRICE_REFUSED");
    // The intent was durable before the call; the refused quote never becomes payable.
    expect(db.prepare("SELECT state,failure_code,rail_quote_json FROM checkout_quotes").all())
      .toEqual([{ state: "REFUSED", failure_code: "CLOSED_PAID_TEST_PRICE_REFUSED", rail_quote_json: null }]);
    await expect(preview()).rejects.toThrow("CLOSED_PAID_TEST_PRICE_REFUSED");
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 0 });
  });
  it("returns exact paid release/contact for review; review itself records no acceptance", async () => {
    expect(await preview()).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 100,
      legalAcceptance: { receiptEmail: email, manifestSha256: env.CLOSED_PAID_TEST_LEGAL_SHA256, documents: stageBLegalManifest.documents } });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='PAID_CHECKOUT_TERMS_ACCEPTED'").get()).toEqual({ n: 0 });
  });
  it.each([undefined, { ...accept, accepted: false }, { ...accept, receiptEmail: "other@example.test" },
    { ...accept, manifestSha256: "f".repeat(64) }, { ...accept, releaseVersion: "stale" }])("refuses absent/false/stale acceptance before creating upstream payment", async acceptance => {
    const create = vi.spyOn(rail, "create"); await expect(confirm(acceptance)).rejects.toThrow("PAID_CHECKOUT_TERMS_ACCEPTANCE_REQUIRED");
    expect(create).not.toHaveBeenCalled(); expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 0 });
  });
  it("refuses an active release that differs from the reviewed profile", async () => {
    db.prepare("UPDATE legal_releases SET version='unreviewed'").run();
    await expect(preview()).rejects.toThrow("CLOSED_PAID_TEST_LEGAL_RELEASE_REFUSED");
  });
  it("rejects a differently qualified fiscal item before resolving upstream", async () => {
    const policy = draftFiscalPolicy(db, { offerRef: input.offerRef, kind: "ONLINE_COURSE", itemName: "Other item",
      taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE", actor: "fixture" });
    qualifyTestFiscalPolicy(db, policy.policyId, "fixture", new Date().toISOString());
    const resolve = vi.spyOn(rail, "resolve"); await expect(preview()).rejects.toThrow("CLOSED_PAID_TEST_FISCAL_POLICY_REFUSED");
    expect(resolve).not.toHaveBeenCalled();
  });
  it("HTTP confirm requires acceptance and derives the buyer from the authenticated session", async () => {
    const app = createCommerceV2App({ db, config, serviceToken: "synthetic", sourceCommit: "a".repeat(40), paymentRail: rail,
      authenticateCustomer: async () => "buyer" });
    const state = issueCheckoutHandoffState(env.REFREF_HANDOFF_STATE_SECRET,
      { customerId: "buyer", returnPath: "/courses/test-course", storefront: "COURSES" }).token;
    const review = await app.request("/v1/checkout/preview", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "http-review" },
      body: JSON.stringify({ offerRef: input.offerRef, state }) });
    expect(review.status).toBe(200); const quote = await review.json() as { quoteId: string };
    const create = vi.spyOn(rail, "create");
    const request = (acceptance: unknown, key: string) => app.request("/v1/checkout", { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ quoteId: quote.quoteId, state, customerId: "other", customerEmail: "other@example.test", legalAcceptance: acceptance }) });
    expect((await request(undefined, "http-missing")).status).toBe(503); expect(create).not.toHaveBeenCalled();
    expect((await request(accept, "http-accepted")).status).toBe(201);
    expect(db.prepare("SELECT customer_id,total_kopecks FROM orders").get()).toEqual({ customer_id: "buyer", total_kopecks: 100 });
  });
  it("returns 409 when a valid signed handoff names a different storefront from the forwarding host", async () => {
    const app = createCommerceV2App({ db, config, serviceToken: "synthetic", sourceCommit: "a".repeat(40), paymentRail: rail,
      authenticateCustomer: async () => "buyer" });
    // The offer belongs to COURSES, matching the host. Only the signed handoff is for LAB.
    const state = issueCheckoutHandoffState(env.REFREF_HANDOFF_STATE_SECRET,
      { customerId: "buyer", returnPath: "/courses/test-course", storefront: "LAB" }).token;
    const resolve = vi.spyOn(rail, "resolve");
    const response = await app.request("/v1/checkout/preview", { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "mismatched-handoff",
        "x-forwarded-host": "localhost:3001" },
      body: JSON.stringify({ offerRef: input.offerRef, state }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "CHECKOUT_STOREFRONT_MISMATCH" });
    expect(resolve).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM checkout_quotes").get()).toEqual({ n: 0 });
  });
  it("records deliberate acceptance once with the first order, retries that order, refuses a second charge", async () => {
    const result = await confirm(accept); expect(result.orderPublicId).toBeTruthy();
    const event = db.prepare("SELECT evidence_json FROM audit_log WHERE action='PAID_CHECKOUT_TERMS_ACCEPTED'").get() as { evidence_json: string };
    expect(JSON.parse(event.evidence_json)).toMatchObject({ legalManifestSha256: env.CLOSED_PAID_TEST_LEGAL_SHA256, receiptEmailSha256: buyerEmailSha256(email) });
    expect(event.evidence_json).not.toContain(email);
    const quote = db.prepare("SELECT id FROM checkout_quotes").get() as { id: string };
    await confirmCheckout(db, rail, config, { ...input, quoteId: quote.id, idempotencyKey: "pay" });
    // A second confirmation of the same quote (another tab, a new key) only reads the first order back.
    await expect(confirmCheckout(db, rail, config, { ...input, quoteId: quote.id, idempotencyKey: "second", legalAcceptance: accept }))
      .resolves.toMatchObject({ orderPublicId: result.orderPublicId });
    // Even when access has ended, the same bounded experiment cannot create a second charge.
    const line = db.prepare("SELECT id FROM order_lines").get() as { id: string };
    revokeEntitlementForOrderLine(db, line.id, "synthetic access ended");
    await expect(prepareCheckout(db, rail, config, { ...input, previewIdempotencyKey: "second" })).rejects.toThrow("CLOSED_PAID_TEST_ALREADY_ATTEMPTED");
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='PAID_CHECKOUT_TERMS_ACCEPTED'").get()).toEqual({ n: 1 });
  });
  it("checks the real production dependency source and refuses canary or changed source", async () => {
    const response = (sourceCommit: string) => new Response(JSON.stringify({ service: "refref-runtime", status: "READY", sourceCommit, checks: { database: true } }));
    expect(await createRefrefReadinessProbe(env, vi.fn<typeof fetch>().mockResolvedValue(response(env.CLOSED_PAID_TEST_REFREF_SOURCE)))()).toBe("ready");
    expect(await createRefrefReadinessProbe(env, vi.fn<typeof fetch>().mockResolvedValue(response("c".repeat(40))))()).toBe("unavailable");
    expect(() => createRefrefReadinessProbe({ ...env, REFREF_READINESS_URL: "https://canary-ops.refref.ru/readyz" })).toThrow();
  });
  it("keeps the host backup observer bound to the same narrow profile", () => {
    const code = `import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('fast_cut','scripts/v2/fast-cut.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
env=json.load(sys.stdin)
p={'schema':'flexperiment.closed-paid-test/1','profile':env['CLOSED_PAID_TEST_PROFILE'],'courseRef':'test-course','offerRef':'course:test-course','amountKopecks':100,'buyerEmailSha256':env['CLOSED_PAID_TEST_BUYER_SHA256'],'refrefSourceCommit':env['CLOSED_PAID_TEST_REFREF_SOURCE'],'legalVersion':env['CLOSED_PAID_TEST_LEGAL_VERSION'],'legalManifestSha256':env['CLOSED_PAID_TEST_LEGAL_SHA256']}
m.validate_paid_test(p);m.assert_payment_environment(env,'commerce',p)
for patch in [{'amountKopecks':101},{'courseRef':'other'},{'unknown':'x'}]:
 try:m.validate_paid_test({**p,**patch});raise RuntimeError('admitted drift')
 except ValueError:pass
try:m.assert_payment_environment(env,'commerce',None);raise RuntimeError('bare flip admitted')
except ValueError:pass
print('PASS')`;
    expect(execFileSync("python3", ["-c", code], { input: JSON.stringify({ ...env, REFUND_ENVELOPE_KEYS: "synthetic", REFUND_ENVELOPE_CURRENT_KEY: "key" }), encoding: "utf8" }).trim()).toBe("PASS");
  });
});

describe("closed paid account consent gate", () => {
  it("refuses missing choices without resolving upstream, and never manufactures consent", async () => {
    const resolve = vi.spyOn(rail, "resolve");
    await expect(preview()).rejects.toThrow("CONSENT_REQUIRED");
    expect(resolve).not.toHaveBeenCalled();
    for (const table of ["checkout_quotes", "orders", "checkout_attempts", "authenticated_consent_actions"]) {
      expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    accountConsent();
    expect(await preview()).toMatchObject({ finalAmountKopecks: 100 });
    expect(authenticatedConsentStatus(db, "buyer", "COURSES").choices.marketing_consent).toBe(false);
  });
  it.each(["foreign-customer", "foreign-storefront", "previous-release"])("rejects %s evidence", async condition => {
    let currentConfig = config;
    if (condition === "foreign-customer") accountConsent("other");
    if (condition === "foreign-storefront") {
      activateLegalRelease(db, { storefront: "LAB", version: "synthetic-lab", manifest: stageBLegalManifest, actor: "fixture" });
      accountConsent("buyer", "LAB");
    }
    if (condition === "previous-release") {
      accountConsent();
      activateLegalRelease(db, { storefront: "COURSES", version: "synthetic-final-v2", manifest: stageBLegalManifest, actor: "fixture" });
      currentConfig = { ...config, closedPaidTest: { ...config.closedPaidTest!, legalVersion: "synthetic-final-v2" } };
    }
    const resolve = vi.spyOn(rail, "resolve");
    await expect(prepareCheckout(db, rail, currentConfig, input)).rejects.toThrow("CONSENT_REQUIRED"); expect(resolve).not.toHaveBeenCalled();
  });
  it.each(["preview-replay", "confirm", "confirm-replay"])("rechecks account verification at %s", async phase => {
    accountConsent(); const quote = await preview();
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected review");
    if (phase === "confirm-replay") await confirm(accept);
    db.exec('UPDATE "user" SET email_verified=0 WHERE id=\'buyer-user\'');
    const resolve = vi.spyOn(rail, "resolve"), create = vi.spyOn(rail, "create"), reconcile = vi.spyOn(rail, "reconcile");
    await expect(phase === "preview-replay" ? preview() : confirmCheckout(db, rail, config, {
      ...input, quoteId: quote.quoteId, idempotencyKey: "pay", legalAcceptance: accept,
    })).rejects.toThrow("CONSENT_REQUIRED");
    expect(resolve).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: phase === "confirm-replay" ? 1 : 0 });
  });
  it("rejects legal drift even after consenting to the changed release", async () => {
    activateLegalRelease(db, { storefront: "COURSES", version: "changed-final", manifest: stageBLegalManifest, actor: "fixture" });
    accountConsent(); const resolve = vi.spyOn(rail, "resolve");
    await expect(preview()).rejects.toThrow("CLOSED_PAID_TEST_LEGAL_RELEASE_REFUSED"); expect(resolve).not.toHaveBeenCalled();
  });
  it("requires fresh consent when final document bytes change, even if the release version is reused", async () => {
    accountConsent();
    const changed = { ...stageBLegalManifest, documents: stageBLegalManifest.documents.map(document => document.kind === "personal_data"
      ? { ...document, sha256: "d".repeat(64) } : document) };
    db.prepare("UPDATE legal_releases SET manifest_json=? WHERE active=1").run(JSON.stringify(changed));
    const currentConfig = { ...config, closedPaidTest: { ...config.closedPaidTest!, legalManifestSha256: legalManifestHash(changed) } };
    const resolve = vi.spyOn(rail, "resolve");
    await expect(prepareCheckout(db, rail, currentConfig, input)).rejects.toThrow("CONSENT_REQUIRED");
    expect(resolve).not.toHaveBeenCalled();
  });
  it("rechecks choices after an asynchronous quote resolution", async () => {
    accountConsent(); const original = rail.resolve.bind(rail);
    vi.spyOn(rail, "resolve").mockImplementation(async request => {
      const result = await original(request); db.exec('UPDATE "user" SET email_verified=0'); return result;
    });
    await expect(preview()).rejects.toThrow("CONSENT_REQUIRED");
    // The quote may stand, but nothing is payable without the choices: confirmation checks them again.
    expect(db.prepare("SELECT consumed_at FROM checkout_quotes").all()).toEqual([{ consumed_at: null }]);
    const quote = db.prepare("SELECT id FROM checkout_quotes").get() as { id: string };
    await expect(confirmCheckout(db, rail, config, { ...input, quoteId: quote.id, idempotencyKey: "pay", legalAcceptance: accept }))
      .rejects.toThrow("CONSENT_REQUIRED");
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 0 });
  });
  it("returns 403/no-store at handoff, preview and confirm using session identity, ignoring forged choices", async () => {
    accountConsent("other");
    const app = createCommerceV2App({ db, config, serviceToken: "synthetic", sourceCommit: "a".repeat(40), paymentRail: rail,
      authenticateCustomer: async () => "buyer" });
    const state = issueCheckoutHandoffState(env.REFREF_HANDOFF_STATE_SECRET,
      { customerId: "buyer", returnPath: "/courses/test-course", storefront: "COURSES" }).token;
    const resolve = vi.spyOn(rail, "resolve"), create = vi.spyOn(rail, "create");
    for (const path of ["/v1/checkout/handoff", "/v1/checkout/preview", "/v1/checkout"]) {
      const result = await app.request(path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "synthetic-request" },
        body: JSON.stringify({ storefront: "COURSES", returnPath: "/courses/test-course", offerRef: input.offerRef, quoteId: "synthetic-quote", state,
          customerId: "other", personalDataConsent: true, accountTermsAccepted: true, legalAcceptance: accept }) });
      expect(result.status).toBe(403); expect(result.headers.get("cache-control")).toBe("no-store");
      expect(await result.json()).toEqual({ code: "CONSENT_REQUIRED" });
    }
    expect(resolve).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(db.prepare("SELECT customer_id FROM authenticated_consent_actions").all()).toEqual([{ customer_id: "other" }]);
  });
});


describe("FULL_PAYMENT ready recorded access", () => {
  it.each(["missing-course", "unpublished", "missing-video", "processing", "empty-video"])("refuses %s before creating a quote/payment", async reason => {
    accountConsent();
    if (reason === "missing-course") db.exec("DELETE FROM catalog_course_projection");
    if (reason === "unpublished") db.exec("UPDATE catalog_lesson_projection SET ever_published=0");
    if (reason === "missing-video") db.exec("DELETE FROM lesson_video_bindings");
    if (reason === "processing") db.exec("UPDATE video_upload_sessions SET status='PROCESSING'");
    if (reason === "empty-video") db.exec("UPDATE lesson_video_bindings SET duration_seconds=0");
    const resolve = vi.spyOn(rail, "resolve"), create = vi.spyOn(rail, "create");
    await expect(preview()).rejects.toThrow("IMMEDIATE_COURSE_ACCESS_NOT_READY");
    expect(resolve).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 0 });
  });
  it("permits ready content updates between preview and purchase, recording the actual initial course state", async () => {
    accountConsent(); const q = await preview();
    if (q.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected review");
    db.exec("UPDATE lesson_video_bindings SET duration_seconds=151");
    await expect(confirmCheckout(db, rail, config, { ...input, quoteId: q.quoteId, idempotencyKey: "pay", legalAcceptance: accept }))
      .resolves.toMatchObject({ state: "PAID" });
    const row = db.prepare("SELECT immediate_access_json FROM order_lines").get() as { immediate_access_json: string };
    expect(JSON.parse(row.immediate_access_json).materials[0].durationSeconds).toBe(151);
  });
  it("includes later course additions under the same entitlement without changing historical initial evidence", async () => {
    accountConsent(); await confirm(accept);
    const evidence = db.prepare("SELECT immediate_access_json FROM order_lines").get();
    applyCourseManifest(db, withManifestHash({ courseRef: "test-course", version: 2, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }], lessons: [
        { lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false },
        { lessonRef: "added", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false },
      ], operations: [] }));
    db.exec("INSERT INTO video_upload_sessions(id,lesson_ref,video_id,status,uploader_endpoint) VALUES ('added-upload','added','added-ready-video','READY','https://example.test/upload')");
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,duration_seconds,bound_at,updated_at) VALUES ('added','added-ready-video',200,?,?)")
      .run(new Date().toISOString(),new Date().toISOString());
    expect(resolvePlaybackAccess(db, { customerId: "buyer", lessonRef: "added", now: new Date(), leaseMs: 60_000 }))
      .toMatchObject({ decision: "ALLOW", paidEntitled: true, binding: { videoId: "added-ready-video" } });
    expect(db.prepare("SELECT count(*) n FROM course_entitlements").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT immediate_access_json FROM order_lines").get()).toEqual(evidence);
  });
  it("rolls back payment acceptance and activation audit if the grant transaction fails", async () => {
    accountConsent();
    db.exec("CREATE TRIGGER synthetic_grant_failure BEFORE INSERT ON course_entitlements BEGIN SELECT RAISE(ABORT,'SYNTHETIC_GRANT_FAILURE'); END");
    await expect(confirm(accept)).rejects.toThrow("SYNTHETIC_GRANT_FAILURE");
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "PAYMENT_PENDING" });
    expect(db.prepare("SELECT count(*) n FROM course_entitlements").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='IMMEDIATE_ACCESS_ACTIVATED'").get()).toEqual({ n: 0 });
  });
  it("freezes the provided materials and atomically records access with accepted payment, once on replay", async () => {
    accountConsent();
    const result = await confirm(accept);
    expect(result.state).toBe("PAID");
    const line = db.prepare("SELECT immediate_access_json FROM order_lines").get() as { immediate_access_json: string };
    const frozen = JSON.parse(line.immediate_access_json);
    expect(frozen).toMatchObject({ courseRef: "test-course", materials: [{ lessonRef: "lesson", videoId: "synthetic-ready-video", durationSeconds: 150 }] });
    const event = db.prepare("SELECT evidence_json FROM audit_log WHERE action='IMMEDIATE_ACCESS_ACTIVATED'").get() as { evidence_json: string };
    expect(JSON.parse(event.evidence_json)).toMatchObject({ paymentState: "PAID", paymentAmountKopecks: 100, materialSet: frozen });
    expect(db.prepare("SELECT count(*) n FROM course_entitlements WHERE revoked_at IS NULL").get()).toEqual({ n: 1 });
    // A reload replays the preview: it reads the paid order back instead of offering the quote again.
    expect(await preview()).toMatchObject({ orderPublicId: result.orderPublicId, state: "PAID" });
    const quote = db.prepare("SELECT id FROM checkout_quotes").get() as { id: string };
    await confirmCheckout(db, rail, config, { ...input, quoteId: quote.id, idempotencyKey: "pay", legalAcceptance: accept });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='IMMEDIATE_ACCESS_ACTIVATED'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) n FROM orders").get()).toEqual({ n: 1 });
  });
});
