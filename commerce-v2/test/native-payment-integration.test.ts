import { beginLabOccurrenceCancellation, completeLabOccurrenceCancellation } from "../src/lab-lifecycle";
import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileAutomaticNativeReceipts } from "../src/fiscal-port";
import { createCommerceV2App } from "../src/app";
import { controlRoomIntegrationSummary } from "../src/control-room";
import { confirmCheckout, prepareCheckout, type PaymentRail } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { loadCommerceOrigins } from "../src/origins";
import { recordAuthenticatedConsents } from "../src/authenticated-consents";
import { legalManifestHash } from "../src/legal-control";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { draftFiscalPolicy } from "../src/fiscal-policy";
import { nativeConfirm, nativeErasureAdmission, reconcilePendingNativePayments, startNativePayment, type NativeLedgerContext } from "../src/native-payment-ledger";
import { NativeQuoteRail } from "../src/native-payment-rail";
import { nativePaymentsFromConfig, reconcileNativeSweep } from "../src/native-payment-runtime";
import { CommerceConfigurationError, loadCommerceRuntimeConfig } from "../src/payment-mode";
import { executeApprovedNativeRefund, reconcilePendingNativeRefunds } from "../src/native-payment-refunds";
import { decideRefund, requestRefund } from "../src/refunds";
import { enrolledTotp, testTotpKey } from "./fixtures/control-room-totp";
import { stageALegalManifest, stageALegalManifestJson, stageBLegalManifest, stageBLegalManifestJson } from "./fixtures/legal";
import { confirmLabBuyer, labAcceptanceFor } from "./fixtures/lab-purchase";
import { encodeIntentId } from "../../lib/my-checkout-intent";
import { startTochkaHttpFixture } from "./fixtures/tochka-http";
import { FakeFiscalAdapter, FakeNativeBank } from "./fixtures/native-fake-provider";
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
    [{ NATIVE_PROVIDER: "tochka" }, "NATIVE_TOCHKA_FIXTURE_ORIGIN_REQUIRED"],
    [{ NATIVE_PROVIDER: "tochka", NATIVE_TOCHKA_FIXTURE_ORIGIN: "https://enter.tochka.com" }, "NATIVE_TOCHKA_FIXTURE_ORIGIN_REQUIRED"],
    [{ NATIVE_PROVIDER: "tochka", DEPLOY_ENV: "production" }, "NATIVE_TOCHKA_PROFILE_UNQUALIFIED"],
    [{ NATIVE_PROVIDER: "tochka", NATIVE_FISCALIZATION_MODE: "MERCHANT" }, "NATIVE_TOCHKA_REQUIRES_PROVIDER_RECEIPTS"],
    [{ KINESCOPE_DELIVERY_MODE: "open" }, "NATIVE_REQUIRES_PROTECTED_KINESCOPE"],
    [{ NATIVE_FISCALIZATION_MODE: "BANK" }, "NATIVE_FISCALIZATION_MODE_INVALID"],
  ])("refuses to start with %o", (override, code) => {
    expect(() => loadCommerceRuntimeConfig({ ...nativeEnv, ...override })).toThrow(new CommerceConfigurationError(code));
  });

  it("loads a separately configured historical executor without enabling Refref checkout", () => {
    const config = loadCommerceRuntimeConfig({ ...nativeEnv, REFREF_API_BASE_URL: "https://refref.example/v1",
      REFREF_API_KEY: "synthetic", REFREF_MERCHANT_ID: "7fbe2f20-42c3-4797-a63c-741355a9058b" });
    expect(config.historicalRefref).toMatchObject({ apiBaseUrl: "https://refref.example/v1" });
    expect(config.refref).toBeUndefined();
    expect(() => loadCommerceRuntimeConfig({ ...nativeEnv, REFREF_API_KEY: "synthetic" }))
      .toThrow(new CommerceConfigurationError("REFREF_CONFIG_MISSING:REFREF_API_BASE_URL"));
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

  it("requires the pinned MY purchase review and freezes the owned order's return target", async () => {
    db.prepare("UPDATE legal_releases SET version='native-synthetic-v1',manifest_json=? WHERE id='legal'").run(stageBLegalManifestJson);
    qualify("FULL_PAYMENT");
    confirmSyntheticAccount(db, "customer");
    const legal = { version: "native-synthetic-v1", sha256: legalManifestHash(stageBLegalManifest) };
    const my = "https://my.flexperiment.test";
    const origins = { ...loadCommerceOrigins({}), my };
    const app = createCommerceV2App({ db, config: { ...config, nativeCoursesLegal: legal }, origins, myIdentity: { mode: "on", origins },
      sourceCommit: "a".repeat(40), serviceToken: "synthetic", paymentRail: rail, nativePayments: ledger,
      authenticateCustomer: async () => "customer", now: () => new Date("2026-09-30T10:01:00Z") });
    const post = (path: string, body: unknown, key: string, origin = my, host = new URL(my).host) => app.request(path, { method: "POST",
      headers: { "x-forwarded-host": host, origin, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    const preview = await post("/v1/checkout/preview", { offerRef: "course:one" }, "my-preview");
    expect(preview.status, await preview.clone().text()).toBe(200);
    const prepared = await preview.json() as { quoteId: string; legalAcceptance: { releaseVersion: string; manifestSha256: string; receiptEmail: string } };
    expect(prepared).toMatchObject({ kind: "ONLINE_COURSE", offerRef: "course:one",
      legalAcceptance: { releaseVersion: legal.version, manifestSha256: legal.sha256 } });
    const go = (returnPath: string, origin = my, legalAcceptance?: unknown) =>
      post("/v1/checkout", { quoteId: prepared.quoteId, returnPath, legalAcceptance }, "my-confirm", origin);
    expect((await go("//elsewhere.test/checkout/opaquevaluehere")).status).toBe(400);
    expect((await go("/checkout/abcdefghijklmnop", "https://forged.test")).status).toBe(403);
    const missing = await go("/checkout/abcdefghijklmnop");
    expect([missing.status, await missing.json()]).toEqual([403, { code: "PAID_CHECKOUT_TERMS_ACCEPTANCE_REQUIRED" }]);
    expect((await post("/v1/checkout", { quoteId: prepared.quoteId }, "outside-my", origins.lab, new URL(origins.lab).host)).status).toBe(403);
    expect(bank.calls.create).toHaveLength(0);
    const acceptance = { accepted: true, releaseVersion: prepared.legalAcceptance.releaseVersion, manifestSha256: prepared.legalAcceptance.manifestSha256,
      receiptEmail: prepared.legalAcceptance.receiptEmail };
    const response = await go("/checkout/abcdefghijklmnop", my, acceptance);
    expect(response.status).toBe(201);
    const order = await response.json() as { orderPublicId: string; paymentUrl: string };
    expect(order.paymentUrl).toMatch(/^https:/);
    expect(bank.calls.create[0]?.successUrl).toBe(`${my}/checkout/abcdefghijklmnop?order=${order.orderPublicId}`);
    const status = await app.request(`/v1/checkout/${order.orderPublicId}`, { headers: { "x-forwarded-host": new URL(my).host } });
    expect(await status.json()).toMatchObject({ kind: "ONLINE_COURSE", contour: "NATIVE", paymentUrl: order.paymentUrl });
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='PAID_CHECKOUT_TERMS_ACCEPTED'").get()).toEqual({ n: 1 });
  });

  it("refuses an unqualified fiscal combination before any order exists", async () => {
    qualify("FULL_PREPAYMENT");
    const prepared = await quote("two");
    await expect(confirm(prepared.quoteId)).rejects.toThrow("FISCAL_POLICY_COURSE_REQUIRES_FULL_PAYMENT");
    expect(db.prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });
    expect(bank.calls.create).toHaveLength(0);
  });

  it("recovers a stopped process after the order commits and before the first send", async () => {
    qualify("FULL_PAYMENT");
    const prepared = await quote("crash");
    ledger = { ...ledger, now: () => "2026-09-30T10:01:00.000Z" };
    const hook = nativeConfirm(db, ledger);
    await expect(confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      quoteId: prepared.quoteId, idempotencyKey: "confirm-crash", native: { ...hook, dispatch: async () => { throw new Error("STOPPED"); } },
    }, "2026-09-30T10:01:00Z")).rejects.toThrow("STOPPED");
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "PAYMENT_PENDING" });
    expect(db.prepare("SELECT state FROM native_payments").get()).toEqual({ state: "CREATING" });
    expect(bank.calls.create).toHaveLength(0);
    const restarted = { ...ledger, now: () => "2026-09-30T10:10:00.000Z" };
    await reconcilePendingNativePayments(db, restarted);
    await reconcilePendingNativePayments(db, restarted);
    expect(bank.calls.create).toHaveLength(1);
    expect(db.prepare("SELECT state FROM native_payments").get()).toEqual({ state: "PENDING" });
  });

  it("does not send a payment of a closed generation if the storefront reopens", async () => {
    qualify("FULL_PAYMENT");
    const prepared = await quote("stop");
    const runtime = nativePaymentsFromConfig(db, config, keyring)!.ledger;
    ledger = { ...runtime, provider: bank, now: () => "2026-09-30T10:01:00.000Z" };
    const hook = nativeConfirm(db, ledger);
    const dispatch = (orderPublicId: string) => {
      setTestStorefronts(db, { COURSES: "CLOSED" });
      setTestStorefronts(db, { COURSES: "OPEN" });
      return hook.dispatch(orderPublicId);
    };
    expect(await confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      quoteId: prepared.quoteId, idempotencyKey: "confirm-stop", native: { ...hook, dispatch },
    }, "2026-09-30T10:01:00Z")).toMatchObject({ state: "EXPIRED" });
    await reconcilePendingNativePayments(db, { ...ledger, now: () => "2026-09-30T10:10:00.000Z" });
    expect(db.prepare("SELECT state,last_reason FROM native_payments").get()).toEqual({ state: "EXPIRED", last_reason: "PAYMENT_NOT_DISPATCHED" });
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
    expect(db.prepare("SELECT COUNT(*) n FROM native_callback_inbox").get()).toEqual({ n: 0 });
    const signed = bank.signedCallback({ providerEventId: "evt-1", subjectKind: "PAYMENT", providerSubjectId: "unknown-payment" });
    const accepted = await app("native").request("/v1/native-payments/callback", { method: "POST", body: signed.body, headers: signed.headers });
    expect([accepted.status, await accepted.json()]).toEqual([200, { accepted: true, duplicate: false }]);
    expect(db.prepare("SELECT COUNT(*) n FROM native_callback_inbox").get()).toEqual({ n: 1 });
  });
  describe("Tochka HTTP and the native Commerce boundary", () => {
    let fixture: Awaited<ReturnType<typeof startTochkaHttpFixture>>;
    let tochkaConfig: ReturnType<typeof loadCommerceRuntimeConfig>;
    let runtime: NonNullable<ReturnType<typeof nativePaymentsFromConfig>>;
    const at = "2026-09-30T10:01:00.000Z";

    beforeEach(async () => {
      fixture = await startTochkaHttpFixture();
      tochkaConfig = withTestStorefrontSwitch(loadCommerceRuntimeConfig({ ...nativeEnv,
        NATIVE_PROVIDER: "tochka", NATIVE_TOCHKA_FIXTURE_ORIGIN: fixture.origin }));
      runtime = nativePaymentsFromConfig(db, tochkaConfig, keyring)!;
    });
    afterEach(async () => { await fixture.close(); });

    async function checkout(interceptDispatch?: (send: () => ReturnType<ReturnType<typeof nativeConfirm>["dispatch"]>) =>
      ReturnType<ReturnType<typeof nativeConfirm>["dispatch"]>) {
      qualify("FULL_PAYMENT");
      const input = { customerId: "customer", customerEmail: "student@example.com" };
      const prepared = await prepareCheckout(db, runtime.quoteRail, tochkaConfig,
        { ...input, offerRef: "course:one", previewIdempotencyKey: "tochka-preview" }, at);
      if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
      const submit = () => {
        const hooks = nativeConfirm(db, runtime.ledger);
        return confirmCheckout(db, runtime.quoteRail, tochkaConfig, { ...input, quoteId: prepared.quoteId, idempotencyKey: "tochka-confirm",
          native: interceptDispatch ? { ...hooks, dispatch: id => interceptDispatch(() => hooks.dispatch(id)) } : hooks }, at);
      };
      return { result: await submit(), submit };
    }

    const commerce = () => createCommerceV2App({ db, config: tochkaConfig, sourceCommit: "a".repeat(40), serviceToken: "synthetic",
      refundEnvelopeKeys: keyring, paymentRail: runtime.quoteRail, nativePayments: runtime.ledger, authenticateCustomer: async () => "customer" });
    const entitlementCount = () => db.prepare("SELECT COUNT(*) n FROM course_entitlements WHERE revoked_at IS NULL").get();
    const fiscal = (kind: string) => db.prepare("SELECT event_ref,state,last_reason FROM fiscal_events WHERE kind=?")
      .get(kind) as { event_ref: string; state: string; last_reason: string | null };

    it("a confirmed MY buyer can purchase an open ready course with the pinned purchase documents", async () => {
      db.prepare("UPDATE legal_releases SET version='native-synthetic-v1',manifest_json=? WHERE id='legal'").run(stageBLegalManifestJson);
      qualify("FULL_PAYMENT");
      confirmSyntheticAccount(db, "customer");
      const legal = { version: "native-synthetic-v1", sha256: legalManifestHash(stageBLegalManifest) };
      const my = "https://my.flexperiment.test";
      const origins = { ...loadCommerceOrigins({}), my };
      const app = createCommerceV2App({ db, config: { ...tochkaConfig, nativeCoursesLegal: legal }, origins, myIdentity: { mode: "on", origins },
        sourceCommit: "a".repeat(40), serviceToken: "synthetic", paymentRail: runtime.quoteRail, nativePayments: runtime.ledger,
        authenticateCustomer: async () => "customer", now: () => new Date(at) });
      const headers = { "x-forwarded-host": new URL(my).host, origin: my, "content-type": "application/json" };
      const post = (path: string, key: string, body: unknown) => app.request(path, { method: "POST",
        headers: { ...headers, "idempotency-key": key }, body: JSON.stringify(body) });
      const preview = await post("/v1/checkout/preview", "my-tochka-preview", { offerRef: "course:one" });
      const review = await preview.json();
      expect(preview.status, review.code).toBe(200);
      const confirmed = await post("/v1/checkout", "my-tochka-confirm", { quoteId: review.quoteId,
        returnPath: `/checkout/${encodeIntentId("course:one")}`, legalAcceptance: { ...review.legalAcceptance, accepted: true } });
      expect(confirmed.status).toBe(201);
      const order = await confirmed.json();
      expect(order.paymentUrl).toMatch(/^https:\/\/bank\.example\.test/);
      fixture.pay([...fixture.payments.values()][0]);
      const status = await app.request(`/v1/checkout/${order.orderPublicId}`, { headers });
      expect(await status.json()).toMatchObject({ kind: "ONLINE_COURSE", contour: "NATIVE", payment: "ACCESS_GRANTED" });
      expect(fixture.calls).toMatchObject({ create: 1, debit: 1 });
    });

    it("lost create remains UNKNOWN, recovers in the sweep and grants once when the entitlement write succeeds", async () => {
      fixture.faults.loseCreate = true;
      fixture.faults.hideFromList = true;
      const { result, submit } = await checkout();
      expect(result.state).toBe("CREATE_UNKNOWN");
      expect((await submit()).state).toBe("CREATE_UNKNOWN");
      fixture.faults.hideFromList = false;
      const [payment] = fixture.payments.values();
      fixture.pay(payment);
      runtime = nativePaymentsFromConfig(db, tochkaConfig, keyring)!;
      const status = () => commerce().request(`/v1/checkout/${result.orderPublicId}`);
      // A temporary DB failure simulates a failure after the first bank confirmation, before the access commit.
      db.exec(`CREATE TRIGGER simulated_grant_failure BEFORE INSERT ON course_entitlements BEGIN SELECT RAISE(ABORT, 'TEST_STOP'); END;`);
      const listings = fixture.calls.list;
      await status();
      expect(fixture.calls.list).toBe(listings);
      expect((await reconcilePendingNativePayments(db, runtime.ledger)).failed).toBe(1);
      expect(entitlementCount()).toEqual({ n: 0 });
      db.exec("DROP TRIGGER simulated_grant_failure");
      await reconcilePendingNativePayments(db, runtime.ledger);
      const response = await status();
      expect(await response.json()).toMatchObject({ payment: "ACCESS_GRANTED" });
      expect(entitlementCount()).toEqual({ n: 1 });
      expect(fixture.calls).toMatchObject({ create: 1, debit: 1, receipt: 0 });
      expect(fiscal("PAYMENT_RECEIPT").state).toBe("PENDING");
      await reconcileAutomaticNativeReceipts(db, runtime.ledger);
      expect(fiscal("PAYMENT_RECEIPT")).toMatchObject({ state: "PENDING", last_reason: "RECEIPT_NOT_YET_VISIBLE" });
      fixture.receipt(payment, fiscal("PAYMENT_RECEIPT").event_ref, false);
      await reconcileAutomaticNativeReceipts(db, runtime.ledger);
      expect(fiscal("PAYMENT_RECEIPT").state).toBe("REGISTERED");
    });

    it("rate limits repeated buyer reads of a known pending operation", async () => {
      const { result } = await checkout();
      const get = () => commerce().request(`/v1/checkout/${result.orderPublicId}`);
      const reads = fixture.calls.info;
      await Promise.all(Array.from({ length: 5 }, get));
      expect(fixture.calls.info).toBe(reads + 1);
    });

    it("restores a pre-marker create with an OPEN storefront and reads even when the bank initially hides it", async () => {
      let frozen: Buffer | undefined;
      fixture.faults.loseCreate = true;
      fixture.faults.hideFromList = true;
      const { result } = await checkout(send => { frozen = db.serialize(); return send(); });
      expect(result.state).toBe("CREATE_UNKNOWN");
      const restored = new Database(frozen!);
      try {
        const old = nativePaymentsFromConfig(restored, tochkaConfig, keyring)!;
        const recovery = { ...old.ledger, now: () => new Date(Date.now() + 120_000).toISOString() };
        expect(db.prepare("SELECT dispatch_started FROM native_payments").get()).toEqual({ dispatch_started: 1 });
        expect(restored.prepare("SELECT dispatch_started FROM native_payments").get()).toEqual({ dispatch_started: 0 });
        expect(recovery.mayInitiate("ONLINE_COURSE", result.orderPublicId)).toBe(true);
        await nativeConfirm(restored, recovery).dispatch(result.orderPublicId);
        await reconcilePendingNativePayments(restored, recovery);
        expect(restored.prepare("SELECT state,last_reason FROM native_payments").get()).toEqual({
          state: "CREATE_UNKNOWN", last_reason: "NATIVE_CREATE_DISPATCH_UNCERTAIN",
        });
        expect(fixture.calls.create).toBe(1);
        fixture.faults.hideFromList = false;
        fixture.pay([...fixture.payments.values()][0]);
        await reconcilePendingNativePayments(restored, recovery);
        expect(restored.prepare("SELECT state FROM native_payments").get()).toEqual({ state: "PAID" });
        expect(restored.prepare("SELECT COUNT(*) n FROM course_entitlements").get()).toEqual({ n: 1 });
        expect(fixture.calls.create).toBe(1);
      } finally { restored.close(); }
    });

    it.each([
      [{ totalPages: 11 }, "TOCHKA_PAYMENT_LOOKUP_BUDGET_EXCEEDED"],
      [{ duplicateListing: true }, "TOCHKA_PAYMENT_DUPLICATE"],
    ])("escalates a bounded create lookup with %o", async (fault, reason) => {
      fixture.faults.loseCreate = true;
      Object.assign(fixture.faults, fault);
      await checkout();
      expect(fixture.lookupWindows[0]).toHaveLength(2);
      const [from, to] = fixture.lookupWindows[0];
      expect(Date.parse(to) - Date.parse(from)).toBe(3 * 86_400_000);
      expect(fixture.calls.list).toBeLessThanOrEqual(2);
      expect(db.prepare("SELECT state,last_reason FROM native_payments").get()).toEqual({ state: "REVIEW_REQUIRED", last_reason: reason });
      expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='NATIVE_PAYMENT_REVIEW_REQUIRED'").get()).toEqual({ n: 1 });
      expect(fixture.calls.create).toBe(1);
    });

    it.each([
      [{ invalidInfo: true }, "REVIEW_REQUIRED", "TOCHKA_RESPONSE_INVALID"],
      [{ overrideStatus: "UNRECOGNIZED" }, "REVIEW_REQUIRED", "TOCHKA_PAYMENT_STATUS_UNSUPPORTED"],
      [{ rejectInfo: true }, "PENDING", "READ_BACK_UNAVAILABLE"],
    ])("distinguishes malformed, unavailable and unsupported bank responses %o", async (fault, state, reason) => {
      await checkout();
      Object.assign(fixture.faults, fault);
      await reconcilePendingNativePayments(db, runtime.ledger);
      expect(db.prepare("SELECT state,last_reason FROM native_payments").get()).toEqual({ state, last_reason: reason });
      expect(entitlementCount()).toEqual({ n: 0 });
    });

    it("a signed callback schedules read-back, a forgery or foreign merchant is rejected, and a retry is deduplicated", async () => {
      const { result } = await checkout();
      expect(result.state).toBe("PENDING");
      const [payment] = fixture.payments.values();
      const app = commerce();
      const send = (body: string) => app.request("/v1/native-payments/callback", { method: "POST",
        headers: { "content-type": "text/plain" }, body });
      const initialReads = fixture.calls.info;
      expect((await send(fixture.callback(payment, true))).status).toBe(401);
      expect((await send(fixture.callback(payment, false, { merchantId: "000000000000002" }))).status).toBe(401);
      expect(fixture.calls.info).toBe(initialReads);
      // Bank still says CREATED even when the signed body claims APPROVED.
      const signal = fixture.callback(payment);
      expect((await send(signal)).status).toBe(200);
      expect(fixture.calls.info).toBe(initialReads + 1);
      expect(entitlementCount()).toEqual({ n: 0 });
      fixture.pay(payment);
      expect(await (await send(signal)).json()).toEqual({ accepted: true, duplicate: true });
      expect(fixture.calls.info).toBe(initialReads + 1);
      // A lost final callback is immaterial to the scheduled sweep.
      await reconcilePendingNativePayments(db, runtime.ledger);
      expect(entitlementCount()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) n FROM native_callback_inbox").get()).toEqual({ n: 1 });
      expect(fixture.calls.key).toBe(1);
    });

    it.each([
      ["wrong amount", { amount: 101 }, "PAYMENT_BINDING_MISMATCH"],
      ["wrong currency", { currency: "USD" }, "PAYMENT_BINDING_MISMATCH"],
      ["wrong operation id", { operationId: "0193d871-efcf-7897-8888-84ead1804311" }, "TOCHKA_PAYMENT_IDENTITY_CONFLICT"],
      ["wrong frozen order reference", { paymentLinkId: "different" }, "TOCHKA_PAYMENT_IDENTITY_CONFLICT"],
    ])("%s on bank read-back cannot grant", async (_label, fault, reason) => {
      const { result } = await checkout();
      expect(result.state).toBe("PENDING");
      fixture.pay([...fixture.payments.values()][0]);
      Object.assign(fixture.faults, fault);
      await reconcilePendingNativePayments(db, runtime.ledger);
      expect(db.prepare("SELECT state,last_reason FROM native_payments").get()).toEqual({ state: "REVIEW_REQUIRED", last_reason: reason });
      expect(entitlementCount()).toEqual({ n: 0 });
      expect(fixture.calls.create).toBe(1);
    });

    async function requestApprovedRefund() {
      const { result } = await checkout();
      const [payment] = fixture.payments.values();
      fixture.pay(payment);
      await reconcilePendingNativePayments(db, runtime.ledger);
      const request = requestRefund(db, { customerId: "customer", orderPublicId: result.orderPublicId,
        idempotencyKey: "refund-tochka", reasonCode: "CUSTOMER_REQUEST" }, at);
      decideRefund(db, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 10000,
        policyBasis: "full", rationale: "synthetic", actor: "operator" }, at);
      return { payment, refundId: request.requestPublicId };
    }

    it("restores a pre-marker refund, reads without POST and keeps an unbound existing refund for review", async () => {
      const { payment, refundId } = await requestApprovedRefund();
      let frozen: Buffer | undefined;
      fixture.faults.beforeInfo = () => { frozen = db.serialize(); fixture.faults.beforeInfo = undefined; };
      fixture.faults.loseRefund = true;
      fixture.faults.hideRefund = true;
      expect((await executeApprovedNativeRefund(db, runtime.ledger, refundId)).state).toBe("SUBMIT_UNKNOWN");
      const restored = new Database(frozen!);
      try {
        const old = nativePaymentsFromConfig(restored, tochkaConfig, keyring)!;
        const recovery = { ...old.ledger, now: () => new Date(Date.now() + 120_000).toISOString() };
        expect(db.prepare("SELECT dispatch_started FROM native_refunds").get()).toEqual({ dispatch_started: 1 });
        expect(restored.prepare("SELECT dispatch_started FROM native_refunds").get()).toEqual({ dispatch_started: 0 });
        const reads = fixture.calls.info;
        await executeApprovedNativeRefund(restored, recovery, refundId);
        await reconcilePendingNativeRefunds(restored, recovery);
        expect(fixture.calls.info).toBe(reads + 1);
        expect(restored.prepare("SELECT state,last_reason FROM native_refunds").get())
          .toEqual({ state: "SUBMIT_UNKNOWN", last_reason: "NATIVE_REFUND_DISPATCH_UNCERTAIN" });
        fixture.faults.hideRefund = false;
        fixture.completeRefund(payment);
        await reconcilePendingNativeRefunds(restored, recovery);
        expect(restored.prepare("SELECT state,last_reason,request_envelope IS NOT NULL AS retained FROM native_refunds").get())
          .toEqual({ state: "REVIEW_REQUIRED", last_reason: "TOCHKA_REFUND_ALREADY_EXISTS", retained: 1 });
        expect(restored.prepare("SELECT provider_refund_id FROM native_refunds").get()).toEqual({ provider_refund_id: null });
        expect(fixture.calls).toMatchObject({ refund: 1, returned: 1 });
      } finally { restored.close(); }
    });

    it.each([
      [{ currency: "USD" }, "REVIEW_REQUIRED", "TOCHKA_REFUND_IDENTITY_CONFLICT"],
      [{ overrideStatus: "REFUNDED" }, "REVIEW_REQUIRED", "TOCHKA_REFUND_ALREADY_EXISTS"],
      [{ overrideStatus: "CREATED" }, "REVIEW_REQUIRED", "TOCHKA_REFUND_STATUS_UNSUPPORTED"],
      [{ rejectInfo: true }, "SUBMIT_UNKNOWN", "NATIVE_REFUND_PREFLIGHT_UNAVAILABLE"],
    ])("keeps conflicting or unavailable preflight evidence %o", async (fault, state, reason) => {
      const { refundId } = await requestApprovedRefund();
      Object.assign(fixture.faults, fault);
      expect((await executeApprovedNativeRefund(db, runtime.ledger, refundId)).state).toBe(state);
      expect(db.prepare("SELECT last_reason,request_envelope IS NOT NULL AS retained FROM native_refunds").get())
        .toEqual({ last_reason: reason, retained: 1 });
      expect(fixture.calls.refund).toBe(0);
      expect(entitlementCount()).toEqual({ n: 1 });
    });

    it("lost refund ACK is independent of both receipts and converges without resend even with COURSES closed", async () => {
      const { payment, refundId } = await requestApprovedRefund();
      setTestStorefronts(db, { COURSES: "CLOSED" });
      fixture.faults.loseRefund = true;
      fixture.faults.hideRefund = true;
      const execute = () => executeApprovedNativeRefund(db, runtime.ledger, refundId);
      expect((await execute()).state).toBe("SUBMIT_UNKNOWN");
      expect((await execute()).state).toBe("SUBMIT_UNKNOWN");
      expect(entitlementCount()).toEqual({ n: 1 });
      fixture.faults.hideRefund = false;
      await reconcilePendingNativeRefunds(db, runtime.ledger);
      expect(db.prepare("SELECT state FROM native_refunds").get()).toEqual({ state: "PROCESSING" });
      fixture.completeRefund(payment);
      await reconcilePendingNativeRefunds(db, runtime.ledger);
      expect(db.prepare("SELECT state FROM native_refunds").get()).toEqual({ state: "SUCCEEDED" });
      expect(entitlementCount()).toEqual({ n: 0 });
      expect(fiscal("PAYMENT_RECEIPT").state).toBe("PENDING");
      expect(fiscal("REFUND_RECEIPT").state).toBe("PENDING");
      fixture.receipt(payment, fiscal("REFUND_RECEIPT").event_ref, true);
      fixture.receipt(payment, fiscal("PAYMENT_RECEIPT").event_ref, false, { amount: 1 });
      await reconcileAutomaticNativeReceipts(db, runtime.ledger);
      expect(fiscal("PAYMENT_RECEIPT")).toMatchObject({ state: "REVIEW_REQUIRED", last_reason: "FISCAL_BINDING_MISMATCH" });
      expect(fiscal("REFUND_RECEIPT").state).toBe("REGISTERED");
      await reconcileAutomaticNativeReceipts(db, runtime.ledger);
      expect(fixture.calls).toMatchObject({ create: 1, debit: 1, refund: 1, returned: 1 });
      expect(db.prepare("SELECT COUNT(*) n FROM fiscal_events WHERE mode='MERCHANT'").get()).toEqual({ n: 0 });
    });

    it("does not replay when a failed create never appeared at the bank", async () => {
      fixture.faults.lostBeforeCreate = true;
      const { result } = await checkout();
      expect(result.state).toBe("CREATE_UNKNOWN");
      await reconcilePendingNativePayments(db, runtime.ledger);
      expect(fixture.calls).toMatchObject({ create: 1, debit: 0 });
      expect(entitlementCount()).toEqual({ n: 0 });
    });

    it("does not replay when an ambiguous refund never appeared at the bank", async () => {
      const { refundId } = await requestApprovedRefund();
      fixture.faults.lostBeforeRefund = true;
      expect((await executeApprovedNativeRefund(db, runtime.ledger, refundId)).state).toBe("SUBMIT_UNKNOWN");
      await reconcilePendingNativeRefunds(db, runtime.ledger);
      expect(fixture.calls).toMatchObject({ refund: 1, returned: 0 });
      expect(entitlementCount()).toEqual({ n: 1 });
    });
  });

});

describe("native dispatch in the refund and order read routes; historical RC.2 preserved (FLEX-119)", () => {
  const T = new Date("2026-09-30T12:00:00.000Z");
  const salt = Buffer.alloc(16, 7);
  const password = "correct horse battery staple";
  const passwordScrypt = ["scrypt", "v1", "16384", "8", "1", salt.toString("base64url"),
    scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");
  let db: Database.Database;
  let bank: FakeNativeBank;
  let totp: () => string;
  const originalCalls: string[] = [];
  // The historical executor: only records that the original contour was used.
  const originalRail = new Proxy({} as PaymentRail, { get: (_target, method: string) => method === "checkoutSnapshotConfig"
    ? { merchantId: "historical", fiscalizationMode: "PROVIDER" }
    : async () => { originalCalls.push(method); throw new Error("ORIGINAL_CONTOUR_REACHED"); } });

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateV2(db);
    totp = enrolledTotp(db, T).next;
    originalCalls.length = 0;
    bank = new FakeNativeBank();
    db.exec(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lr','COURSES','v1','{}','2026-01-01T00:00:00Z',1);
      INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com');
      INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course-a','ONLINE_COURSE','PAID','course-a');`);
    for (const [publicId, contour] of [["NATIVE-1", "native"], ["RC2-1", "rc2"]] as const) {
      const snapshot = JSON.stringify({ schema: "flexperiment.test-native-order/1", paymentPurpose: `Оплата ${publicId}` });
      db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
        VALUES (?,?,'customer','PAYMENT_PENDING',10000,?,?,'lr',?,?)`).run(`o-${publicId}`, publicId, snapshot, "c".repeat(64), T.toISOString(), T.toISOString());
      db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,fiscal_item_json,created_at)
        VALUES (?,?,'p','course:a','Курс',10000,'v1',?,?)`).run(`l-${publicId}`, `o-${publicId}`, JSON.stringify({ name: "Курс", quantity: 1,
        amountKopecks: 10000, vatCode: "NONE", paymentMethod: "FULL_PAYMENT", paymentObject: "SERVICE" }), T.toISOString());
      if (contour === "rc2") {
        db.prepare(`INSERT INTO checkout_attempts(id,order_id,idempotency_key,request_payload_json,state,refref_attempt_id,created_at,updated_at)
          VALUES ('a','o-RC2-1','k','{}','PAID','rc2-historical',?,?)`).run(T.toISOString(), T.toISOString());
        db.prepare("UPDATE orders SET state='FULFILLED' WHERE public_id='RC2-1'").run();
      }
    }
  });

  const ledger = (): NativeLedgerContext => ({ provider: bank, keyring, fiscalizationMode: "MERCHANT", mayInitiate: () => true, now: () => T.toISOString() });
  const server = (native: boolean, historical = true) => createCommerceV2App({
    db, config: native ? withTestStorefrontSwitch(loadCommerceRuntimeConfig(nativeEnv))
      : withTestStorefrontSwitch(loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock", MERCHANT_PROMOTION_PREFIX: "FX-" })),
    sourceCommit: "a".repeat(40), serviceToken: "synthetic", refundEnvelopeKeys: keyring,
    paymentRail: native ? nativePaymentsFromConfig(db, loadCommerceRuntimeConfig(nativeEnv), keyring)!.quoteRail : originalRail,
    ...(native ? { nativePayments: ledger(), historicalPaymentRail: historical ? originalRail : undefined } : {}),
    authenticateCustomer: async (headers) => (headers.get("authorization") === "Session customer" ? "customer" : null),
    now: () => T,
    controlRoomAuth: { origin: "https://admin.flexperiment.ru", sessionSecret: "s", passwordScrypt, trustedProxyIps: ["127.0.0.1"], totpKey: testTotpKey },
    controlRoomPeerAddress: () => "127.0.0.1",
  });
  const admin = async (app: ReturnType<typeof server>) => {
    const login = await app.request("/v1/admin/login", { method: "POST",
      headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password, code: totp() }) });
    expect(login.status).toBe(200);
    return login.headers.get("set-cookie")!;
  };
  const post = (cookie: string) => ({ method: "POST", headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" }, body: "{}" });
  const approved = (publicId: string) => {
    const request = requestRefund(db, { customerId: "customer", orderPublicId: publicId, idempotencyKey: `r-${publicId}`, reasonCode: "CUSTOMER_REQUEST" }, T.toISOString());
    decideRefund(db, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 10000, policyBasis: "full", rationale: "t", actor: "op" }, T.toISOString());
    return request.requestPublicId;
  };

  it("refunds a NATIVE order through the native ledger and an RC.2 order through its original executor", async () => {
    await startNativePayment(db, ledger(), "NATIVE-1");
    bank.buyerPays("NATIVE-1");
    await reconcilePendingNativePayments(db, ledger());
    const app = server(true);
    const cookie = await admin(app);
    const native = await app.request(`/v1/admin/v2/refunds/${approved("NATIVE-1")}/execute`, post(cookie));
    expect([native.status, await native.json()]).toEqual([200, expect.objectContaining({ state: "PROCESSING" })]);
    expect(bank.calls.submitRefund).toHaveLength(1);
    const historical = await app.request(`/v1/admin/v2/refunds/${approved("RC2-1")}/execute`, post(cookie));
    expect(historical.status).toBe(409);
    expect(originalCalls).toContain("prepareRefund");
    expect(bank.calls.submitRefund).toHaveLength(1);
  });

  it("reads a NATIVE order from the ledger and an RC.2 order through its original executor", async () => {
    await startNativePayment(db, ledger(), "NATIVE-1");
    const app = server(true);
    const headers = { authorization: "Session customer" };
    const native = await app.request("/v1/checkout/NATIVE-1", { headers });
    expect([native.status, await native.json()]).toEqual([200, expect.objectContaining({ contour: "NATIVE", payment: "AWAITING_PAYMENT" })]);
    const historical = await app.request("/v1/checkout/RC2-1", { headers });
    expect(historical.status).toBe(409);
    expect(originalCalls).toContain("reconcile");
    expect(bank.calls.readPayment).toBe(1);
  });

  it("leaves historical requests unavailable when the original executor is absent", async () => {
    const app = server(true, false);
    const headers = { authorization: "Session customer" };
    const read = await app.request("/v1/checkout/RC2-1", { headers });
    expect([read.status, await read.json()]).toEqual([503, { code: "PAYMENT_RAIL_UNAVAILABLE" }]);
    const cookie = await admin(app);
    const refund = await app.request(`/v1/admin/v2/refunds/${approved("RC2-1")}/execute`, post(cookie));
    expect(refund.status).toBe(503);
    expect(originalCalls).toEqual([]);
    expect(bank.calls.submitRefund).toHaveLength(0);
  });

  it("outside PAYMENT_MODE=native every order keeps the original path", async () => {
    const app = server(false);
    const read = await app.request("/v1/checkout/RC2-1", { headers: { authorization: "Session customer" } });
    expect(read.status).toBe(409);
    expect(originalCalls).toEqual(["reconcile"]);
    expect(bank.calls.readPayment).toBe(0);
  });
});

describe("owner directive v4.8 item 4: COURSES=OPEN, LAB=CLOSED, PAYMENT_MODE=native leaves zero LAB payment side effects", () => {
  let db: Database.Database;
  let bank: FakeNativeBank;
  const config = withTestStorefrontSwitch(loadCommerceRuntimeConfig(nativeEnv));
  const rail = new NativeQuoteRail({ merchantId: "flexperiment-native", fiscalizationMode: "PROVIDER" });
  const sideEffects = () => ({
    quotes: (db.prepare("SELECT COUNT(*) n FROM checkout_quotes WHERE offer_id='offer-lab'").get() as { n: number }).n,
    orders: (db.prepare("SELECT COUNT(*) n FROM order_lines WHERE product_id='p-lab'").get() as { n: number }).n,
    nativePayments: (db.prepare("SELECT COUNT(*) n FROM native_payments").get() as { n: number }).n,
    fiscalEvents: (db.prepare("SELECT COUNT(*) n FROM fiscal_events").get() as { n: number }).n,
    tickets: (db.prepare("SELECT COUNT(*) n FROM lab_tickets").get() as { n: number }).n,
    providerCalls: bank.calls.create.length + bank.calls.readPayment + bank.calls.submitRefund.length + bank.calls.readRefund,
  });
  const none = { quotes: 0, orders: 0, nativePayments: 0, fiscalEvents: 0, tickets: 0, providerCalls: 0 };

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateV2(db);
    bank = new FakeNativeBank();
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    confirmLabBuyer(db, "customer");
    for (const storefront of ["COURSES", "LAB"]) db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES (?,?,'v1',?,'2026-09-30T00:00:00Z',1)`).run(`legal-${storefront}`, storefront, storefront === "LAB" ? stageBLegalManifestJson : stageALegalManifestJson);
    db.exec(`INSERT INTO cities(id,slug,title) VALUES ('city','msk','Москва');
      INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
        VALUES ('occ','occ-1','city','Мастер-класс','2026-12-05T15:00:00Z','2026-12-05T18:00:00Z','Europe/Moscow',10,'CONFIRMED','Студия','Москва, 1');
      INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('p-lab','lab-a','LAB','PAID','occ-1');
      INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,payment_purpose) VALUES ('offer-lab','lab:a','p-lab',350000,'PUBLIC','Мастер-класс');`);
    const { policyId } = draftFiscalPolicy(db, { offerRef: "lab:a", kind: "LAB", itemName: "Мастер-класс", taxSystem: "USN_INCOME",
      vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE", actor: "owner" }, "2026-09-29T00:00:00Z");
    qualifyTestFiscalPolicy(db, policyId, "owner", "2026-09-29T00:00:00Z");
    openTestStorefront(db, "LAB");
    setTestStorefronts(db, { COURSES: "OPEN", LAB: "CLOSED" });
  });

  const ledger = (): NativeLedgerContext => {
    const runtime = nativePaymentsFromConfig(db, config, keyring)!;
    return { ...runtime.ledger, provider: bank };
  };

  it("API: a LAB preview is refused and writes nothing", async () => {
    const app = createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "synthetic", refundEnvelopeKeys: keyring,
      paymentRail: rail, nativePayments: ledger(), authenticateCustomer: async () => "customer" });
    const response = await app.request("/v1/checkout/preview", { method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-host": "localhost:3000", "idempotency-key": "lab-preview-1" },
      body: JSON.stringify({ offerRef: "lab:a" }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toContain("SALES_STOPPED");
    expect(sideEffects()).toEqual(none);
  });

  it("checkout: a LAB quote issued while LAB was open cannot be confirmed after the close", async () => {
    setTestStorefronts(db, { COURSES: "OPEN", LAB: "OPEN" });
    const prepared = await prepareCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com", offerRef: "lab:a",
      previewIdempotencyKey: "lab-open", storefront: "LAB" }, "2026-09-30T10:00:00Z");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
    setTestStorefronts(db, { COURSES: "OPEN", LAB: "CLOSED" });
    const before = sideEffects();
    await expect(confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com", quoteId: prepared.quoteId,
      idempotencyKey: "lab-confirm", labAcceptance: labAcceptanceFor(db), native: nativeConfirm(db, ledger()) }, "2026-09-30T10:01:00Z")).rejects.toThrow("SALES_STOPPED");
    // The quote issued while LAB was open is the only row; the close lets nothing further through.
    expect(sideEffects()).toEqual({ ...none, quotes: 1 });
    expect(before).toEqual({ ...none, quotes: 1 });
    expect(db.prepare("SELECT consumed_at FROM checkout_quotes").get()).toEqual({ consumed_at: null });
  });

  it("requires the current MY account agreement throughout LAB checkout and keeps the purchase acceptance separate", async () => {
    setTestStorefronts(db, { LAB: "OPEN" });
    const my = "https://my.flexperiment.test";
    const origins = { ...loadCommerceOrigins({}), my };
    const app = createCommerceV2App({ db, config, origins, myIdentity: { mode: "on", origins },
      sourceCommit: "a".repeat(40), serviceToken: "synthetic", paymentRail: rail, nativePayments: ledger(),
      authenticateCustomer: async () => "customer", now: () => new Date("2026-09-30T10:01:00Z") });
    const post = (path: string, body: unknown, key: string) => app.request(path, { method: "POST",
      headers: { "x-forwarded-host": new URL(my).host, origin: my, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body) });
    const preview = (key: string) => post("/v1/checkout/preview", { offerRef: "lab:a" }, key);
    const missing = await preview("lab-no-consent");
    expect([missing.status, await missing.json()]).toEqual([403, { code: "CONSENT_REQUIRED" }]);
    expect(sideEffects()).toEqual(none);

    confirmSyntheticAccount(db, "customer");
    const accepted = await preview("lab-consented");
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const { quoteId } = await accepted.json() as { quoteId: string };
    const confirm = (key: string, includeLabAcceptance = true) => post("/v1/checkout", {
      quoteId, returnPath: `/checkout/${encodeIntentId("lab:a")}`,
      ...(includeLabAcceptance ? { labAcceptance: labAcceptanceFor(db) } : {}),
    }, key);
    db.prepare("UPDATE legal_releases SET active=0 WHERE id='legal-COURSES'").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal-courses-v2','COURSES','v2',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);

    const stale = await confirm("lab-stale-consent");
    expect([stale.status, await stale.json()]).toEqual([403, { code: "CONSENT_REQUIRED" }]);
    expect((await preview("lab-stale-preview")).status).toBe(403);
    expect(sideEffects()).toEqual({ ...none, quotes: 1 });

    recordAuthenticatedConsents(db, "customer", { storefront: "COURSES", releaseVersion: "v2",
      manifestSha256: legalManifestHash(stageALegalManifest), actionKey: "my-v2-confirmed-consents",
      personalDataConsent: true, accountTermsAccepted: true, marketingConsent: false });
    const noAcceptance = await confirm("lab-no-purchase-acceptance", false);
    expect(await noAcceptance.json()).toEqual(expect.objectContaining({ code: "LAB_CONSENT_REQUIRED" }));
    expect(sideEffects()).toEqual({ ...none, quotes: 1 });
    const paid = await confirm("lab-current-consent");
    expect(paid.status, await paid.clone().text()).toBe(201);
    expect(bank.calls.create).toHaveLength(1);
  });

  it("honours an effective quote when only the LAB offer is closed", async () => {
    setTestStorefronts(db, { LAB: "OPEN" });
    const prepared = await prepareCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      offerRef: "lab:a", previewIdempotencyKey: "soft-close-preview", storefront: "LAB" }, "2026-09-30T10:00:00Z");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
    db.prepare("UPDATE offers SET sale_mode='CLOSED' WHERE id='offer-lab'").run();
    await expect(confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      quoteId: prepared.quoteId, idempotencyKey: "soft-close-confirm", labAcceptance: labAcceptanceFor(db), native: nativeConfirm(db, ledger()),
    }, "2026-09-30T10:01:00Z")).resolves.toMatchObject({ state: "PENDING" });
    expect(bank.calls.create).toHaveLength(1);
  });

  it("completes cancellation for an order that never reached the provider", async () => {
    setTestStorefronts(db, { LAB: "OPEN" });
    const prepared = await prepareCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      offerRef: "lab:a", previewIdempotencyKey: "cancel-lab", storefront: "LAB" }, "2026-09-30T10:00:00Z");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
    const fixed = { ...ledger(), now: () => "2026-09-30T10:01:00Z" };
    const hook = nativeConfirm(db, fixed);
    const dispatch = (orderPublicId: string) => {
      beginLabOccurrenceCancellation(db, { occurrenceRef: "occ-1", actor: "owner", reason: "Synthetic cancellation" }, "2026-09-30T10:01:00Z");
      return hook.dispatch(orderPublicId);
    };
    await expect(confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      quoteId: prepared.quoteId, idempotencyKey: "confirm-cancel-lab", labAcceptance: labAcceptanceFor(db), native: { ...hook, dispatch },
    }, "2026-09-30T10:01:00Z")).resolves.toMatchObject({ state: "EXPIRED" });
    await reconcilePendingNativePayments(db, { ...fixed, now: () => "2026-09-30T10:10:00Z" });
    expect(bank.calls.readPayment).toBe(0);
    expect(bank.calls.create).toHaveLength(0);
    expect(db.prepare("SELECT state, dispatch_started FROM native_payments").get()).toEqual({ state: "EXPIRED", dispatch_started: 0 });
    expect(completeLabOccurrenceCancellation(db, { occurrenceRef: "occ-1", actor: "owner" }, () => "NATIVE",
      "2026-09-30T10:11:00Z")).toMatchObject({ state: "COMPLETED", obligations: [] });
  });

  it("retains a possibly dispatched payment for reconciliation and reports the stopped replay", async () => {
    setTestStorefronts(db, { LAB: "OPEN" });
    const prepared = await prepareCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      offerRef: "lab:a", previewIdempotencyKey: "ambiguous-lab", storefront: "LAB" }, "2026-09-30T10:00:00Z");
    if (prepared.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
    let now = "2026-09-30T10:01:00Z";
    const fixed = { ...ledger(), now: () => now };
    // The merchant cannot tell whether the bank received this attempt. Pause the first read-back so
    // cancellation can start before the sweep receives NOT_FOUND.
    bank.faults.create.push("LOSE_BEFORE_COMMIT");
    bank.faults.readPayment.push("UNAVAILABLE");
    await expect(confirmCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com",
      quoteId: prepared.quoteId, idempotencyKey: "confirm-ambiguous-lab", labAcceptance: labAcceptanceFor(db), native: nativeConfirm(db, fixed),
    }, now)).resolves.toMatchObject({ state: "CREATE_UNKNOWN" });
    now = "2026-09-30T10:10:00Z";
    beginLabOccurrenceCancellation(db, { occurrenceRef: "occ-1", actor: "owner", reason: "Synthetic cancellation" }, now);
    for (let index = 0; index < 3; index += 1) await reconcilePendingNativePayments(db, fixed);
    expect(bank.calls.create).toHaveLength(1);
    expect(bank.calls.readPayment).toBe(4);
    expect(db.prepare("SELECT state, dispatch_started FROM native_payments").get()).toEqual({ state: "CREATE_UNKNOWN", dispatch_started: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='NATIVE_PAYMENT_REVIEW_REQUIRED'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM native_payment_observations WHERE reason='PAYMENT_INITIATION_STOPPED'").get()).toEqual({ n: 1 });
    expect(() => completeLabOccurrenceCancellation(db, { occurrenceRef: "occ-1", actor: "owner" }, () => "NATIVE", now))
      .toThrow("LAB_CANCELLATION_OPEN_PAYMENTS");
  });

  it("the public LAB catalogue is served under native, while LAB sales stay refused server-side", async () => {
    const app = createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "synthetic", refundEnvelopeKeys: keyring,
      paymentRail: rail, nativePayments: ledger(), now: () => new Date("2026-11-22T10:00:00Z") });
    db.prepare("UPDATE lab_occurrences SET visibility='LISTED'").run();
    const catalogue = await app.request("/v1/lab/catalogue");
    expect(catalogue.status).toBe(200);
    expect(await catalogue.json()).toMatchObject({ paymentMode: "native", occurrences: [expect.objectContaining({ offerRef: "lab:a" })] });
    await expect(prepareCheckout(db, rail, config, { customerId: "customer", customerEmail: "student@example.com", offerRef: "lab:a",
      previewIdempotencyKey: "after-catalogue", storefront: "LAB" }, "2026-11-22T10:00:00Z")).rejects.toThrow("SALES_STOPPED");
    expect(sideEffects()).toEqual(none);
  });

  it("ledger: a LAB order can never start a native payment while LAB is closed", async () => {
    const snapshot = JSON.stringify({ schema: "flexperiment.test-native-order/1", paymentPurpose: "Мастер-класс" });
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
      VALUES ('o','LAB-X','customer','PAYMENT_PENDING',350000,?,?,'legal-LAB','2026-09-30T10:00:00Z','2026-09-30T10:00:00Z')`).run(snapshot, "d".repeat(64));
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,fiscal_item_json,created_at)
      VALUES ('l','o','p-lab','lab:a','Мастер-класс',350000,'v1',?,'2026-09-30T10:00:00Z')`).run(JSON.stringify({ name: "Мастер-класс", quantity: 1,
      amountKopecks: 350000, vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE" }));
    await expect(startNativePayment(db, ledger(), "LAB-X")).rejects.toThrow("NATIVE_PAYMENT_INITIATION_STOPPED");
    await reconcilePendingNativePayments(db, ledger());
    expect({ ...sideEffects(), orders: 0 }).toEqual(none);
  });
  describe("Tochka Cheki leaves new LAB operations closed with the LAB switch OPEN", () => {
    let fixture: Awaited<ReturnType<typeof startTochkaHttpFixture>>;
    let tochkaConfig: ReturnType<typeof loadCommerceRuntimeConfig>;
    let runtime: NonNullable<ReturnType<typeof nativePaymentsFromConfig>>;
    const at = "2026-09-30T10:01:00.000Z";
    const later = "2026-09-30T10:10:00.000Z";
    const buyer = { customerId: "customer", customerEmail: "student@example.com" };

    beforeEach(async () => {
      setTestStorefronts(db, { COURSES: "OPEN", LAB: "OPEN" });
      fixture = await startTochkaHttpFixture();
      tochkaConfig = withTestStorefrontSwitch(loadCommerceRuntimeConfig({ ...nativeEnv,
        NATIVE_PROVIDER: "tochka", NATIVE_TOCHKA_FIXTURE_ORIGIN: fixture.origin }));
      runtime = nativePaymentsFromConfig(db, tochkaConfig, keyring)!;
    });
    afterEach(async () => { await fixture.close(); });

    async function oldQuote() {
      const result = await prepareCheckout(db, rail, config, { ...buyer, offerRef: "lab:a",
        previewIdempotencyKey: "lab-before-profile-change", storefront: "LAB" }, "2026-09-30T10:00:00Z");
      if (result.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected a quote");
      return { ...buyer, quoteId: result.quoteId, idempotencyKey: "lab-confirm-profile", labAcceptance: labAcceptanceFor(db) };
    }

    it("refuses new checkout and a previously issued quote before order and reserve", async () => {
      await expect(prepareCheckout(db, runtime.quoteRail, tochkaConfig, { ...buyer, offerRef: "lab:a",
        previewIdempotencyKey: "lab-cheki", storefront: "LAB" }, at)).rejects.toThrow("NATIVE_TOCHKA_PRODUCT_UNAVAILABLE");
      const app = createCommerceV2App({ db, config: tochkaConfig, sourceCommit: "a".repeat(40), serviceToken: "synthetic",
        paymentRail: runtime.quoteRail, nativePayments: runtime.ledger, authenticateCustomer: async () => buyer.customerId,
        now: () => new Date(at) });
      const preview = await app.request("/v1/checkout/preview", { method: "POST",
        headers: { "x-forwarded-host": "localhost:3000", "content-type": "application/json", "idempotency-key": "lab-cheki-http" },
        body: JSON.stringify({ offerRef: "lab:a" }) });
      expect([preview.status, await preview.json()]).toEqual([409, { code: "NATIVE_TOCHKA_PRODUCT_UNAVAILABLE" }]);
      expect(sideEffects()).toEqual(none);
      const quote = await oldQuote();
      await expect(confirmCheckout(db, runtime.quoteRail, tochkaConfig, { ...quote, native: nativeConfirm(db, runtime.ledger) }, at))
        .rejects.toThrow("NATIVE_TOCHKA_PRODUCT_UNAVAILABLE");
      expect(sideEffects()).toEqual({ ...none, quotes: 1 });
      expect(db.prepare("SELECT consumed_at FROM checkout_quotes").get()).toEqual({ consumed_at: null });
      expect(fixture.calls).toMatchObject({ create: 0, list: 0, info: 0 });
    });

    it("refuses direct LAB create and expires a staged unsent LAB payment on sweep", async () => {
      const quote = await oldQuote();
      const active = { ...ledger(), now: () => at };
      const staged = nativeConfirm(db, active);
      await expect(confirmCheckout(db, rail, config, { ...quote, native: { ...staged,
        dispatch: async order => { throw new Error(`SYNTHETIC_STOP:${order}`); } } }, at)).rejects.toThrow("SYNTHETIC_STOP");
      const { public_id: orderId } = db.prepare("SELECT public_id FROM orders").get() as { public_id: string };
      // Remove only the synthetic unsent row, then exercise the direct staging entrypoint on the existing order.
      db.prepare("DELETE FROM native_payments WHERE dispatch_started=0").run();
      await expect(startNativePayment(db, runtime.ledger, orderId)).rejects.toThrow("NATIVE_PAYMENT_INITIATION_STOPPED");
      staged.stage(orderId);
      await reconcilePendingNativePayments(db, { ...runtime.ledger, historicalProviders: [bank], now: () => later });
      expect(db.prepare("SELECT state,dispatch_started FROM native_payments").get()).toEqual({ state: "EXPIRED", dispatch_started: 0 });
      expect(fixture.calls).toMatchObject({ create: 0, info: 0 });
      expect(bank.calls.create).toHaveLength(0);
    });

    it("sweeps a historical LAB payment, refund and MERCHANT receipts with the original synthetic executors attached", async () => {
      const quote = await oldQuote();
      bank.faults.create.push("LOSE_AFTER_COMMIT");
      bank.faults.readPayment.push("UNAVAILABLE");
      const { orderPublicId } = await confirmCheckout(db, rail, config, { ...quote, native: nativeConfirm(db, { ...ledger(), now: () => at }) }, at);
      expect(db.prepare("SELECT state FROM native_payments").get()).toEqual({ state: "CREATE_UNKNOWN" });
      const fiscalAdapter = new FakeFiscalAdapter();
      const original = nativePaymentsFromConfig(db, tochkaConfig, keyring, { historicalFake: { provider: bank, fiscalAdapter } })!;
      const migrated = { ...original.ledger, now: () => later };
      await reconcilePendingNativePayments(db, migrated);
      expect(db.prepare("SELECT state FROM native_payments").get()).toEqual({ state: "PENDING" });
      bank.buyerPays(orderPublicId);
      await reconcilePendingNativePayments(db, migrated);
      expect(db.prepare("SELECT state FROM native_payments").get()).toEqual({ state: "PAID" });
      const request = requestRefund(db, { customerId: buyer.customerId, orderPublicId,
        idempotencyKey: "historical-lab-refund", reasonCode: "CUSTOMER_REQUEST" }, later);
      decideRefund(db, request.requestPublicId, { outcome: "APPROVE", amountKopecks: 350000, policyBasis: "full",
        rationale: "synthetic", actor: "operator" }, later);
      await executeApprovedNativeRefund(db, migrated, request.requestPublicId);
      bank.settleRefund(`refund:${request.requestPublicId}`);
      expect(nativeErasureAdmission(db, buyer.customerId).admitted).toBe(false);
      await reconcileNativeSweep(db, { ...original, ledger: migrated });
      expect(db.prepare("SELECT state FROM native_refunds").get()).toEqual({ state: "SUCCEEDED" });
      expect(db.prepare("SELECT COUNT(*) n FROM fiscal_events WHERE mode='MERCHANT' AND state='REGISTERED'").get()).toEqual({ n: 2 });
      expect(fiscalAdapter.registeredCount).toBe(2);
      expect(nativeErasureAdmission(db, buyer.customerId).admitted).toBe(true);
      expect(bank.calls.create).toHaveLength(1);
      expect(bank.calls.submitRefund).toHaveLength(1);
      expect(fixture.calls).toMatchObject({ create: 0, info: 0, refund: 0 });
    });

    it("the default switched runtime exposes an unavailable historical fiscal executor", async () => {
      const quote = await oldQuote();
      const { orderPublicId } = await confirmCheckout(db, rail, config, { ...quote, native: nativeConfirm(db, { ...ledger(), now: () => at }) }, at);
      bank.buyerPays(orderPublicId);
      await reconcilePendingNativePayments(db, ledger());
      await reconcileNativeSweep(db, runtime);
      await reconcileNativeSweep(db, runtime);
      expect(runtime.ledger.historicalProviders).toBeUndefined();
      expect(db.prepare("SELECT state,last_reason,sealed_contact IS NOT NULL AS retained FROM fiscal_events WHERE kind='PAYMENT_RECEIPT'").get())
        .toEqual({ state: "SUBMITTING", last_reason: "NATIVE_ORIGINAL_FISCAL_EXECUTOR_UNAVAILABLE", retained: 1 });
      expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='NATIVE_FISCAL_READ_BACK_UNAVAILABLE'").get()).toEqual({ n: 2 });
      expect(fixture.calls).toMatchObject({ create: 0, receipt: 0, refund: 0 });
      expect(nativeErasureAdmission(db, buyer.customerId).admitted).toBe(false);
    });

    it("blocks replay of a historical ambiguous LAB create even when the old executor supports replay", async () => {
      const quote = await oldQuote();
      bank.faults.create.push("LOSE_BEFORE_COMMIT");
      bank.faults.readPayment.push("UNAVAILABLE");
      await confirmCheckout(db, rail, config, { ...quote, native: nativeConfirm(db, { ...ledger(), now: () => at }) }, at);
      await reconcilePendingNativePayments(db, { ...runtime.ledger, historicalProviders: [bank], now: () => later });
      expect(db.prepare("SELECT state,dispatch_started FROM native_payments").get()).toEqual({ state: "CREATE_UNKNOWN", dispatch_started: 1 });
      expect(bank.calls.readPayment).toBe(2);
      expect(bank.calls.create).toHaveLength(1);
      expect(fixture.calls.create).toBe(0);
    });
  });

});
