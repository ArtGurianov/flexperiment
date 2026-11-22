import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import { capabilityHash, labLegalReview } from "../src/lab-tickets";
import { LAB_INTEREST_CONSENT, labInterestConsentSha256 } from "../src/lab-interest";
import { CommerceConfigurationError, loadCommerceRuntimeConfig, type CommerceRuntimeConfig } from "../src/payment-mode";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { openTestStorefront, qualifyTestFiscalPolicies, setTestStorefronts, withTestStorefrontSwitch } from "./fixtures/sales";

/**
 * FLEX-8 on fixtures: COURSES=OPEN, LAB=CLOSED, PAYMENT_MODE=native (FLEX-119, agent C, PR #289).
 * LAB must have no payment side effect at the API, database or provider level. The native contour
 * exists only once #289 is integrated; before that, `native` is refused at configuration (fail closed),
 * which the first test pins. The provider-level suite runs whenever the native modules are present.
 */
const nativeEnv = { DEPLOY_ENV: "test", PAYMENT_MODE: "native", NATIVE_PROVIDER: "fake", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-" };
const nativeConfig = (() => {
  try { return loadCommerceRuntimeConfig(nativeEnv); }
  catch (error) { if (error instanceof CommerceConfigurationError && error.message === "PAYMENT_MODE_INVALID") return null; throw error; }
})();
// Resolved at runtime so this file also compiles before the native contour is integrated.
const nativeModule = (name: string) => import(/* @vite-ignore */ `../src/${name}`) as Promise<Record<string, unknown>>;

describe("FLEX-8 native fixture admission", () => {
  it.runIf(nativeConfig === null)("refuses PAYMENT_MODE=native at startup until the native contour is integrated", () => {
    expect(() => loadCommerceRuntimeConfig(nativeEnv)).toThrow(new CommerceConfigurationError("PAYMENT_MODE_INVALID"));
  });
});

describe.runIf(nativeConfig !== null)("FLEX-8: COURSES=OPEN, LAB=CLOSED, PAYMENT_MODE=native", () => {
  const origin = "http://localhost:3000";
  const now = "2026-10-19T10:00:00.000Z";
  const consent = { version: LAB_INTEREST_CONSENT.version, textSha256: labInterestConsentSha256 };
  let db: Database.Database;
  let bank: { calls: { create: unknown[]; readPayment: number; submitRefund: unknown[]; readRefund: number } };
  let app: ReturnType<typeof createCommerceV2App>;
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const paymentTables = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'native_%' OR name='fiscal_events')`)
    .all() as Array<{ name: string }>).map(({ name }) => name);
  const moneyState = () => Object.fromEntries([...paymentTables(), "customers", "orders", "order_lines", "checkout_quotes", "checkout_attempts",
    "lab_guest_access", "lab_tickets", "refund_requests"].map((table) => [table, count(table)]));
  const call = (path: string, body?: unknown, token?: string, key = "k") => app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin, "x-real-ip": "203.0.113.9", "content-type": "application/json", "idempotency-key": key, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  beforeEach(async () => {
    db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
    db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','LAB','lab-b',?,?,1)").run(stageBLegalManifestJson, now);
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address,visibility)
      VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Адрес','LISTED')`).run();
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one')").run();
    db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode,payment_purpose) VALUES ('offer','lab:one','product',10000,'PUBLIC','LAB workshop')").run();
    qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB"); openTestStorefront(db, "ONLINE_COURSE");
    setTestStorefronts(db, { COURSES: "OPEN", LAB: "CLOSED" });
    const { FakeNativeBank } = await nativeModule("native-payment-fake") as { FakeNativeBank: new () => typeof bank };
    const { NativeQuoteRail } = await nativeModule("native-payment-rail") as { NativeQuoteRail: new (input: unknown) => unknown };
    bank = new FakeNativeBank();
    const config = withTestStorefrontSwitch(nativeConfig!) as CommerceRuntimeConfig;
    app = createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "synthetic", now: () => new Date(now),
      paymentRail: new NativeQuoteRail({ merchantId: "flexperiment-native", fiscalizationMode: "MERCHANT" }) as never,
      ...({ nativePayments: { provider: bank, keyring: { currentKeyId: "k", keys: { k: Buffer.alloc(32, 7) } }, fiscalizationMode: "MERCHANT", mayInitiate: () => true } } as object),
      campaignUnsubscribeSecret: "synthetic-secret", sendLabInterestEmail: async () => {},
      labGuestTrustedProxyIps: ["10.0.5.4"], labGuestPeerAddress: () => "10.0.5.4" });
  });
  afterEach(() => db.close());

  it("publishes the LAB event as closed and takes interest with zero payment-side rows and zero provider calls", async () => {
    const before = moneyState();
    expect(paymentTables().length).toBeGreaterThan(0);
    const showcase = await (await call("/v1/lab/showcase")).json();
    expect(showcase.sales).toEqual({ state: "CLOSED", reason: "STOREFRONT_CLOSED" });
    expect(showcase.occurrences).toMatchObject([{ occurrenceRef: "lab:one", amountKopecks: 10000, sales: "CLOSED" }]);
    expect((await call("/v1/lab/interest", { email: "fan@example.test", consent })).status).toBe(202);
    expect(moneyState()).toEqual(before);
    expect(bank.calls).toEqual({ create: [], readPayment: 0, submitRefund: [], readRefund: 0 });
  });

  it("refuses a LAB quote and payment with a historical capability: no row, hold, ledger entry or provider call", async () => {
    const token = randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('history','history@example.test')").run();
    db.prepare("INSERT INTO lab_guest_access(order_public_id,customer_id,token_sha256,acceptance_json,created_at,updated_at) VALUES ('history-order','history',?,NULL,?,?)")
      .run(capabilityHash(token), now, now);
    const before = moneyState();
    const preview = await call("/v1/checkout/preview", { offerRef: "lab:one" }, token, "preview");
    expect(preview.status).toBeGreaterThanOrEqual(400); expect(JSON.stringify(await preview.json())).toContain("SALES_STOPPED");
    const acceptance = { personalDataConsent: true, termsAccepted: true, receiptContactAccepted: true,
      releaseVersion: labLegalReview(db).releaseVersion, manifestSha256: labLegalReview(db).manifestSha256 };
    expect((await call("/v1/checkout", { quoteId: "missing", labAcceptance: acceptance }, token, "pay")).status).toBeGreaterThanOrEqual(400);
    expect(moneyState()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkout_quotes WHERE seat_hold_ref IS NOT NULL").get()).toEqual({ n: 0 });
    expect(bank.calls).toEqual({ create: [], readPayment: 0, submitRefund: [], readRefund: 0 });
  });
});
