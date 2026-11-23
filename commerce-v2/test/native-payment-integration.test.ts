import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { controlRoomIntegrationSummary } from "../src/control-room";
import { confirmCheckout, prepareCheckout, type PaymentRail } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { loadCommerceOrigins } from "../src/origins";
import { legalManifestHash } from "../src/legal-control";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { draftFiscalPolicy } from "../src/fiscal-policy";
import { nativeConfirm, reconcilePendingNativePayments, startNativePayment, type NativeLedgerContext } from "../src/native-payment-ledger";
import { NativeQuoteRail } from "../src/native-payment-rail";
import { nativePaymentsFromConfig } from "../src/native-payment-runtime";
import { CommerceConfigurationError, loadCommerceRuntimeConfig } from "../src/payment-mode";
import { decideRefund, requestRefund } from "../src/refunds";
import { enrolledTotp, testTotpKey } from "./fixtures/control-room-totp";
import { stageALegalManifestJson, stageBLegalManifest, stageBLegalManifestJson } from "./fixtures/legal";
import { confirmLabBuyer, labAcceptanceFor } from "./fixtures/lab-purchase";
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
    }, "2026-09-30T10:01:00Z")).toMatchObject({ state: "CREATING" });
    await reconcilePendingNativePayments(db, { ...ledger, now: () => "2026-09-30T10:10:00.000Z" });
    expect(db.prepare("SELECT state,last_reason FROM native_payments").get()).toEqual({ state: "CREATE_UNKNOWN", last_reason: "PAYMENT_INITIATION_STOPPED" });
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
});
