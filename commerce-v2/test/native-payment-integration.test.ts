import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { controlRoomIntegrationSummary } from "../src/control-room";
import { confirmCheckout, prepareCheckout } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { draftFiscalPolicy } from "../src/fiscal-policy";
import { nativeConfirm, reconcilePendingNativePayments, type NativeLedgerContext } from "../src/native-payment-ledger";
import { NativeQuoteRail } from "../src/native-payment-rail";
import { nativePaymentsFromConfig } from "../src/native-payment-runtime";
import { CommerceConfigurationError, loadCommerceRuntimeConfig } from "../src/payment-mode";
import { stageALegalManifestJson } from "./fixtures/legal";
import { FakeNativeBank } from "./fixtures/native-fake-provider";
import { openTestStorefront, qualifyTestFiscalPolicy, setTestStorefronts, withTestStorefrontSwitch } from "./fixtures/sales";

const nativeEnv = { DEPLOY_ENV: "test", PAYMENT_MODE: "native", NATIVE_PROVIDER: "fake", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-" };
const keyring = { currentKeyId: "k", keys: { k: Buffer.alloc(32, 7) } };

describe("PAYMENT_MODE=native configuration (FLEX-119)", () => {
  it("starts without any REFREF_* variable in local/test", () => {
    expect(loadCommerceRuntimeConfig(nativeEnv)).toMatchObject({ paymentMode: "native", native: { provider: "fake", fiscalizationMode: "MERCHANT" } });
    expect(loadCommerceRuntimeConfig({ ...nativeEnv, NATIVE_FISCALIZATION_MODE: "PROVIDER" }).native?.fiscalizationMode).toBe("PROVIDER");
  });

  it.each([
    [{ DEPLOY_ENV: "production" }, "NATIVE_FAKE_PROVIDER_FORBIDDEN"],
    [{ DEPLOY_ENV: "staging" }, "NATIVE_FAKE_PROVIDER_FORBIDDEN"],
    [{ NATIVE_PROVIDER: "" }, "NATIVE_PROVIDER_INVALID"],
    [{ NATIVE_PROVIDER: "tochka" }, "NATIVE_PROVIDER_INVALID"],
    [{ KINESCOPE_DELIVERY_MODE: "open" }, "NATIVE_REQUIRES_PROTECTED_KINESCOPE"],
    [{ NATIVE_FISCALIZATION_MODE: "BANK" }, "NATIVE_FISCALIZATION_MODE_INVALID"],
  ])("refuses to start with %o", (override, code) => {
    expect(() => loadCommerceRuntimeConfig({ ...nativeEnv, ...override })).toThrow(new CommerceConfigurationError(code));
  });

  it("the Control Room integration summary reports the native mode as it is", () => {
    const db = new Database(":memory:");
    migrateV2(db);
    expect(controlRoomIntegrationSummary(db, loadCommerceRuntimeConfig(nativeEnv)).paymentMode).toBe("native");
  });

  it("the runtime composition refuses a production config and a missing keyring", () => {
    const db = new Database(":memory:");
    const config = loadCommerceRuntimeConfig(nativeEnv);
    expect(() => nativePaymentsFromConfig(db, { ...config, deployEnvironment: "production" }, keyring)).toThrow("NATIVE_FAKE_PROVIDER_FORBIDDEN");
    expect(() => nativePaymentsFromConfig(db, config, undefined)).toThrow("REFUND_ENVELOPE_KEYS_REQUIRED");
    expect(nativePaymentsFromConfig(db, { ...config, paymentMode: "mock" }, keyring)).toBeUndefined();
  });
});

describe("native checkout confirm and callback route (FLEX-119)", () => {
  let db: Database.Database;
  let bank: FakeNativeBank;
  let ledger: NativeLedgerContext;
  const config = withTestStorefrontSwitch(loadCommerceRuntimeConfig(nativeEnv));
  const rail = new NativeQuoteRail({ merchantId: "flexperiment-native", fiscalizationMode: "MERCHANT" });

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateV2(db);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')").run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,payment_purpose)
      VALUES ('offer','course:one','product',10000,'PUBLIC','Synthetic merchant offer purpose')`).run();
    openTestStorefront(db);
    // FULL_PAYMENT sells only initial access to ready recorded materials (FLEX-76): one READY lesson.
    applyCourseManifest(db, withManifestHash({ courseRef: "course-one", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false }], operations: [] }));
    db.prepare("INSERT INTO video_upload_sessions(id,lesson_ref,video_id,status,uploader_endpoint) VALUES ('upload','lesson','ready-video','READY','https://example.test/upload')").run();
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,duration_seconds,bound_at,updated_at) VALUES ('lesson','ready-video',150,?,?)")
      .run("2026-09-29T00:00:00Z", "2026-09-29T00:00:00Z");
    bank = new FakeNativeBank();
    ledger = { provider: bank, keyring, fiscalizationMode: "MERCHANT", mayInitiate: () => true };
  });

  const qualify = (paymentMethod: "FULL_PAYMENT" | "FULL_PREPAYMENT") => {
    const { policyId } = draftFiscalPolicy(db, { offerRef: "course:one", kind: "ONLINE_COURSE", itemName: "Курс", taxSystem: "USN_INCOME",
      vatCode: "NONE", paymentMethod, paymentObject: "SERVICE", actor: "owner" }, "2026-09-29T00:00:00Z");
    qualifyTestFiscalPolicy(db, policyId, "owner", "2026-09-29T00:00:00Z");
  };
  const quote = async (key: string) => {
    const prepared = await prepareCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      offerRef: "course:one", previewIdempotencyKey: `preview-${key}`, checkoutCode: "PARTNER10" }, "2026-09-30T10:00:00Z");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
    return prepared;
  };
  const confirm = (quoteId: string, key = "confirm-1") => confirmCheckout(db, rail, config, { customerId: "customer",
    customerEmail: "student@example.com", quoteId, idempotencyKey: key, native: nativeConfirm(db, ledger) }, "2026-09-30T10:01:00Z");

  it("quotes the frozen merchant price with no referral discount, then hands the order to the native ledger", async () => {
    qualify("FULL_PAYMENT");
    const prepared = await quote("one");
    expect(prepared).toMatchObject({ baseAmountKopecks: 10000, discountKopecks: 0, finalAmountKopecks: 10000 });
    const confirmed = await confirm(prepared.quoteId);
    expect(confirmed).toMatchObject({ state: "PENDING", paymentUrl: expect.stringContaining("fake-bank") });
    expect(db.prepare("SELECT COUNT(*) n FROM checkout_attempts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM checkout_quotes").get()).toEqual({ state: "PENDING" });
    // A repeated confirm reads the native state back; it never starts a second payment.
    expect(await confirm(prepared.quoteId, "confirm-2")).toMatchObject({ state: "PENDING" });
    expect(bank.calls.create).toHaveLength(1);
    bank.buyerPays(confirmed.orderPublicId);
    await reconcilePendingNativePayments(db, ledger);
    expect(db.prepare("SELECT state FROM checkout_quotes").get()).toEqual({ state: "PAID" });
    expect(db.prepare("SELECT COUNT(*) n FROM course_entitlements").get()).toEqual({ n: 1 });
  });

  it("refuses an unqualified fiscal combination before any order exists", async () => {
    qualify("FULL_PREPAYMENT");
    const prepared = await quote("two");
    await expect(confirm(prepared.quoteId)).rejects.toThrow("FISCAL_POLICY_COURSE_REQUIRES_FULL_PAYMENT");
    expect(db.prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });
    expect(bank.calls.create).toHaveLength(0);
  });

  it("a stop after the order commit ends the order with nothing sent", async () => {
    qualify("FULL_PAYMENT");
    const prepared = await quote("three");
    ledger = { ...ledger };
    // The storefront closes between the confirm transaction and the provider call: confirm's own re-read refuses.
    const stopAfterCommit = { ...nativeConfirm(db, ledger) };
    const original = db.prepare.bind(db);
    let armed = true;
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (armed && sql.startsWith("UPDATE checkout_quotes SET state='PAYMENT_CREATING'")) { armed = false; setTestStorefronts(db, { COURSES: "CLOSED" }); }
      return original(sql);
    }) as typeof db.prepare;
    await expect(confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com", quoteId: prepared.quoteId,
      idempotencyKey: "confirm-3", native: stopAfterCommit }, "2026-09-30T10:01:00Z")).rejects.toThrow("SALES_STOPPED");
    (db as unknown as { prepare: typeof db.prepare }).prepare = original;
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "CANCELLED" });
    expect(db.prepare("SELECT state FROM checkout_quotes").get()).toEqual({ state: "DECLINED" });
    expect(bank.calls.create).toHaveLength(0);
  });

  const app = (paymentMode: "native" | "disabled") => createCommerceV2App({
    db, config: paymentMode === "native" ? config
      : withTestStorefrontSwitch(loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled", MERCHANT_PROMOTION_PREFIX: "FX-" })),
    sourceCommit: "a".repeat(40), serviceToken: "synthetic", refundEnvelopeKeys: keyring,
    ...(paymentMode === "native" ? { paymentRail: rail, nativePayments: ledger } : {}),
  });

  it("registers the callback route only on the native contour", async () => {
    const outside = await app("disabled").request("/v1/native-payments/callback", { method: "POST", body: "{}" });
    expect(outside.status).toBe(404);
    const forged = await app("native").request("/v1/native-payments/callback", { method: "POST", body: "{}", headers: { "x-fake-signature": "00" } });
    expect(forged.status).toBe(401);
    const signed = bank.signedCallback({ providerEventId: "evt-1", subjectKind: "PAYMENT", providerSubjectId: "unknown-payment" });
    const accepted = await app("native").request("/v1/native-payments/callback", { method: "POST", body: signed.body, headers: signed.headers });
    expect([accepted.status, await accepted.json()]).toEqual([200, { accepted: true, duplicate: false }]);
    expect(db.prepare("SELECT COUNT(*) n FROM native_callback_inbox").get()).toEqual({ n: 2 });
  });
});
