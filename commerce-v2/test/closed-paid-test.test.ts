import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateV2 } from "../src/db";
import { configureProduct } from "../src/catalog-control";
import { buyerEmailSha256 } from "../src/closed-paid-test";
import { confirmCheckout, MockPaymentRail, prepareCheckout } from "../src/checkout";
import { draftFiscalPolicy, qualifyFiscalPolicy } from "../src/fiscal-policy";
import { legalManifestHash } from "../src/legal-control";
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
const config = loadCommerceRuntimeConfig(env);
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
beforeEach(() => {
  db = new Database(":memory:"); migrateV2(db); rail = new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('buyer',?),('other','other@example.test')").run(email);
  db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','COURSES',?,?,'2026-10-16',1)")
    .run(env.CLOSED_PAID_TEST_LEGAL_VERSION, stageBLegalManifestJson);
  configureProduct(db, config, { productRef: "course:test-course", offerRef: "course:test-course", courseRef: "test-course",
    kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "ACCEPTANCE_ONLY", priceKopecks: 100, acceptanceAllowlist: [email],
    paymentPurpose: "Synthetic test purchase", actor: "fixture", expectedVersion: 0 });
  const policy = draftFiscalPolicy(db, { offerRef: "course:test-course", kind: "ONLINE_COURSE", itemName: "Доступ к видеоматериалу «Test Course»",
    taxSystem: "USN_INCOME", vatCode: "NONE", paymentMethod: "FULL_PAYMENT", paymentObject: "SERVICE", actor: "fixture" });
  qualifyFiscalPolicy(db, { ...policy, actor: "fixture", legalBasis: { offerTermsRef: "fixture:terms", counselRef: "fixture:counsel", evidenceSha256: "c".repeat(64) } });
});
afterEach(() => db.close());

describe("closed paid test admission", () => {
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
    expect(db.prepare("SELECT count(*) n FROM checkout_quotes").get()).toEqual({ n: 0 });
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
    qualifyFiscalPolicy(db, { ...policy, actor: "fixture", legalBasis: { offerTermsRef: "fixture:other", counselRef: "fixture:counsel", evidenceSha256: "d".repeat(64) } });
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
  it("records deliberate acceptance once with the first order, retries that order, refuses a second charge", async () => {
    const result = await confirm(accept); expect(result.orderPublicId).toBeTruthy();
    const event = db.prepare("SELECT evidence_json FROM audit_log WHERE action='PAID_CHECKOUT_TERMS_ACCEPTED'").get() as { evidence_json: string };
    expect(JSON.parse(event.evidence_json)).toMatchObject({ legalManifestSha256: env.CLOSED_PAID_TEST_LEGAL_SHA256, receiptEmailSha256: buyerEmailSha256(email) });
    expect(event.evidence_json).not.toContain(email);
    const quote = db.prepare("SELECT id FROM checkout_quotes").get() as { id: string };
    await confirmCheckout(db, rail, config, { ...input, quoteId: quote.id, idempotencyKey: "pay" });
    await expect(confirmCheckout(db, rail, config, { ...input, quoteId: quote.id, idempotencyKey: "second", legalAcceptance: accept })).rejects.toThrow();
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
