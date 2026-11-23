import { confirmLabBuyer } from "./fixtures/lab-purchase";
import { labInterestManifest } from "./fixtures/lab-interest";
import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { MockPaymentRail } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { capabilityHash, issueLabTicket, labLegalReview } from "../src/lab-tickets";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { openTestStorefront, qualifyTestFiscalPolicies, setTestStorefronts, testCheckoutConfig, withTestStorefrontSwitch } from "./fixtures/sales";

/**
 * FLEX-8 acceptance, on fixtures: with LAB sales closed the showcase and interest work, existing
 * tickets and refunds keep working, and the server refuses every new LAB quote, seat hold, order and
 * payment attempt with no payment-rail call.
 */
const origin = "http://localhost:3000";
const now = "2026-10-19T10:00:00.000Z";
let db: Database.Database, rail: MockPaymentRail;
const consent = labInterestManifest.consent;
const capability = () => randomBytes(32).toString("base64url");
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Money-side state: the five owner "zero" facts plus customers and guest access. */
const moneyState = () => Object.fromEntries(["customers", "orders", "order_lines", "checkout_quotes", "checkout_attempts", "lab_guest_access",
  "lab_tickets", "refund_requests", "refund_executions"].map((table) => [table, count(table)]));
const holds = () => (db.prepare("SELECT COUNT(*) AS n FROM checkout_quotes WHERE seat_hold_ref IS NOT NULL").get() as { n: number }).n;

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); rail = new MockPaymentRail();
  db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','LAB','lab-b',?,?,1)").run(stageBLegalManifestJson, now);
  db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
  db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address,visibility)
    VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Адрес','LISTED')`).run();
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','lab:one','product',10000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB");
});
afterEach(() => db.close());

const appWith = (config = testCheckoutConfig, signedIn = false) => createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "synthetic",
  paymentRail: rail, authenticateCustomer: signedIn ? async () => "history-customer" : undefined, now: () => new Date(now), campaignUnsubscribeSecret: "synthetic-secret", labInterestSignupsEnabled: true, labInterestManifest, sendLabInterestEmail: async () => {},
  labGuestTrustedProxyIps: ["10.0.5.4"], labGuestPeerAddress: () => "10.0.5.4", sendLabTicketEmail: async () => {} });
const call = (app: ReturnType<typeof appWith>, path: string, body?: unknown, token?: string, key = "k") => app.request(path, {
  method: body === undefined ? "GET" : "POST",
  headers: { origin, "x-real-ip": "203.0.113.7", "content-type": "application/json", "idempotency-key": key, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
/**
 * A historical guest capability, as an order started before the closure would hold.
 */
const historicalGuest = async () => {
  const token = capability();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('history-customer','history@example.test')").run();
  db.prepare(`INSERT INTO lab_guest_access(order_public_id,customer_id,token_sha256,acceptance_json,created_at,updated_at)
    VALUES ('history-order','history-customer',?,NULL,?,?)`).run(capabilityHash(token), now, now);
  return token;
};
const acceptance = () => ({ personalDataConsent: true, termsAccepted: true, receiptContactAccepted: true,
  releaseVersion: labLegalReview(db).releaseVersion, manifestSha256: labLegalReview(db).manifestSha256 });

describe("FLEX-8: LAB closed while COURSES stays open", () => {
  it("refuses guest registration without allocating a customer or access capability", async () => {
    setTestStorefronts(db, { LAB: "CLOSED", COURSES: "OPEN" });
    const before = moneyState();
    const result = await call(appWith(), "/v1/lab/guest/start", { email: "new@example.test", accessToken: capability() });
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
    expect(moneyState()).toEqual(before);
  });
  it.each([
    ["LAB switch CLOSED, offer PUBLIC", () => setTestStorefronts(db, { LAB: "CLOSED", COURSES: "OPEN" }), "SALES_STOPPED"],
    ["offer CLOSED, switch OPEN", () => db.prepare("UPDATE offers SET sale_mode='CLOSED'").run(), "OFFER_CLOSED"],
  ])("refuses a new LAB quote with %s, without any money-side row or rail call", async (_label, close, code) => {
    await historicalGuest();
    confirmLabBuyer(db, "history-customer");
    const app = appWith(testCheckoutConfig, true);
    close();
    const create = vi.spyOn(rail, "create"), resolve = vi.spyOn(rail, "resolve");
    const before = moneyState();
    const preview = await call(app, "/v1/checkout/preview", { offerRef: "lab:one" }, undefined, "preview");
    expect(preview.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await preview.json())).toContain(code);
    const pay = await call(app, "/v1/checkout", { quoteId: "missing", labAcceptance: acceptance() }, undefined, "pay");
    expect(pay.status).toBeGreaterThanOrEqual(400);
    expect(moneyState()).toEqual(before); expect(holds()).toBe(0);
    expect(create).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
    // The showcase still publishes the event with its date and price; interest is accepted.
    const showcase = await (await call(app, "/v1/lab/showcase")).json();
    expect(showcase.sales.state).toBe("CLOSED");
    expect(showcase.occurrences).toMatchObject([{ occurrenceRef: "lab:one", startsAt: "2026-11-01T09:00:00Z", amountKopecks: 10000, sales: "CLOSED" }]);
    expect((await call(app, "/v1/lab/interest", { email: "fan@example.test", cityId: "city", consent })).status).toBe(202);
    expect(moneyState()).toEqual(before); expect(holds()).toBe(0);
  });

  it("keeps a historical paid ticket and its refund request working after the closure", async () => {
    const app = appWith(); const token = await historicalGuest();
    db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
      VALUES ('order','history-order','history-customer','FULFILLED',10000,'{}',?,'legal',?,?)`).run("a".repeat(64), now, now);
    db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,fiscal_item_json,created_at)
      VALUES ('line','order','product','lab:one','LAB',10000,'lab-b','{}',?)`).run(now);
    issueLabTicket(db, "line", now);
    expect(count("lab_tickets")).toBe(1);
    setTestStorefronts(db, { LAB: "CLOSED", COURSES: "OPEN" });
    db.prepare("UPDATE offers SET sale_mode='CLOSED'").run();
    expect((await call(app, "/v1/lab/guest/ticket", undefined, token)).status).toBe(200);
    expect((await call(app, "/v1/lab/guest/refunds", { reasonCode: "CUSTOMER_REQUEST" }, token, "refund")).status).toBe(201);
    expect(count("refund_requests")).toBe(1); expect(count("lab_tickets")).toBe(1);
  });
});

describe("FLEX-8: non-financial acceptance with PAYMENT_MODE=disabled", () => {
  it("publishes the closed event and takes interest, while every LAB money path is refused", async () => {
    const config = withTestStorefrontSwitch(loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "disabled" }));
    db.prepare("UPDATE offers SET sale_mode='CLOSED'").run();
    const app = appWith(config);
    const before = moneyState();
    const showcase = await (await call(app, "/v1/lab/showcase")).json();
    expect(showcase.sales).toEqual({ state: "CLOSED", reason: "PAYMENTS_DISABLED" });
    expect(showcase.occurrences[0]).toMatchObject({ amountKopecks: 10000, sales: "CLOSED" });
    expect((await call(app, "/v1/lab/interest", { email: "fan@example.test", cityId: "city", consent })).status).toBe(202);
    for (const [path, body] of [["/v1/lab/guest/start", { email: "new@example.test", accessToken: capability() }], ["/v1/checkout/preview", { offerRef: "lab:one" }], ["/v1/checkout", { quoteId: "missing" }]] as const) {
      expect((await call(app, path, body, capability())).status).toBeGreaterThanOrEqual(400);
    }
    expect(moneyState()).toEqual(before); expect(holds()).toBe(0);
    expect(count("lab_interest_signups")).toBe(1);
  });
});
