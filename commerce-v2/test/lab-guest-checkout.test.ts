import Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCommerceV2App } from "../src/app";
import { MockPaymentRail, reconcileCheckout } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { bindVerifiedAuthUser } from "../src/customers";
import { listCustomerOrderHistory } from "../src/library";
import { labAccess, checkInLabTicket, prepareLabRecovery, readLabTicket, startLabGuest, type LabTicketEmail } from "../src/lab-tickets";
import { labAcceptanceFor, seedHistoricalGuestLabPurchase } from "./fixtures/lab-purchase";
import { decideRefund, executeApprovedRefund } from "../src/refunds";
import { controlRoomSessionCookie, issueControlRoomSession } from "../src/control-room-auth";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { openTestStorefront, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";

let db: Database.Database, rail: MockPaymentRail;
let time: Date;
const origin = "http://localhost:3000"; // loadCommerceOrigins test defaults: LAB.
const now = "2026-10-19T10:00:00.000Z";
const capability = () => randomBytes(32).toString("base64url");
let app: ReturnType<typeof createCommerceV2App>;
const emails: LabTicketEmail[] = [];
let signedIn: string | null = null;
let clientIp = "203.0.113.1", peerAddress: string | undefined = "10.0.5.4";
const send = vi.fn(async (message: LabTicketEmail) => { emails.push(message); });
const auth = { origin: "http://localhost:3001", sessionSecret: "synthetic-session-secret-long-enough", passwordScrypt: "unused" };
const request = (path: string, body?: unknown, token?: string, key = "test") => app.request(path, {
  method: body === undefined ? "GET" : "POST", headers: { origin, "x-real-ip": clientIp, "Content-Type": "application/json", "Idempotency-Key": key,
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const json = async (response: Response) => { const body = await response.json(); expect(response.status, JSON.stringify(body)).toBeLessThan(300); return body; };
// FLEX-60: new guest purchases are closed on the server. `start` is a guest who opened access before
// the closure; `purchase` is a historical guest purchase (fixture), whose initial ticket email went out.
const start = async (token = capability(), email = "guest@example.com") => ({ token, ...startLabGuest(db, { email, accessToken: token }, now) });
const quote = async (token: string, mockScenario?: string, key = "preview") => request("/v1/checkout/preview", { offerRef: "lab:one", mockScenario }, token, key);
const acceptance = () => labAcceptanceFor(db);
const pay = async (token: string, quoteId: string, key = "payment") => json(await request("/v1/checkout", { quoteId, labAcceptance: acceptance() }, token, key));
async function purchase(scenario?: string, email = "guest@example.com") {
  const seeded = await seedHistoricalGuestLabPurchase(db, rail, testCheckoutConfig, { email, accessToken: capability(), offerRef: "lab:one", now, scenario, storefrontOrigin: origin });
  if (seeded.paid?.state === "PAID") {
    db.prepare("UPDATE lab_guest_access SET initial_email_attempted_at=? WHERE order_public_id=?").run(now, seeded.orderPublicId);
    const message = prepareLabRecovery(db, email, seeded.orderPublicId, origin, now); if (message) await send(message);
  }
  return { ...seeded, paid: seeded.paid! };
}
const recoveryToken = (index = emails.length - 1) => new URLSearchParams(new URL(emails[index].url).hash.slice(1)).get("recover")!;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); rail = new MockPaymentRail(); time = new Date(now);
  emails.length = 0; send.mockClear(); signedIn = null; clientIp = "203.0.113.1"; peerAddress = "10.0.5.4";
  db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('legal','LAB','lab-b',?,?,1)").run(stageBLegalManifestJson, now);
  db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
  db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
    VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Адрес')`).run();
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product','lab:one','LAB','PAID','lab:one')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','lab:one','product',10000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB");
  app = createCommerceV2App({ db, config: testCheckoutConfig, sourceCommit: "a".repeat(40), serviceToken: "synthetic",
    paymentRail: rail, now: () => time, sendLabTicketEmail: send, controlRoomAuth: auth,
    labGuestTrustedProxyIps: ["10.0.5.4"], labGuestPeerAddress: () => peerAddress,
    authenticateCustomer: async () => signedIn });
});
afterEach(() => db.close());

describe("FLEX-60: new guest purchases are closed on the server", () => {
  it("refuses guest start, a guest preview and a legacy unconsumed guest intent: no hold, order or payment", async () => {
    const create = vi.spyOn(rail, "create"), resolve = vi.spyOn(rail, "resolve");
    const started = await request("/v1/lab/guest/start", { email: "guest@example.com", accessToken: capability() });
    expect(started.status).toBe(403); expect(await started.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
    expect(count("lab_guest_access")).toBe(0);
    const opened = await start();
    const preview = await quote(opened.token);
    expect(preview.status).toBe(403); expect(await preview.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
    expect(count("checkout_quotes")).toBe(0);
    // An intent issued before the closure is not a payment: its confirmation is refused under the order lock.
    const legacy = await seedHistoricalGuestLabPurchase(db, rail, testCheckoutConfig, { email: "legacy@example.com", accessToken: capability(),
      offerRef: "lab:one", now, storefrontOrigin: origin, stopAt: "QUOTE" });
    resolve.mockClear();
    const confirm = await request("/v1/checkout", { quoteId: legacy.prepared.quoteId, labAcceptance: acceptance() }, legacy.token);
    expect(confirm.status).toBe(403); expect(await confirm.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
    expect(create).not.toHaveBeenCalled(); expect(count("orders")).toBe(0); expect(count("checkout_attempts")).toBe(0);
    expect(count("user")).toBe(0); expect(count("account_consents")).toBe(0); expect(count("marketing_consents")).toBe(0);
  });
  it("keeps a historical guest order's ticket, read-back and replay working without a new payment", async () => {
    const guest = await purchase();
    expect(guest.paid).toMatchObject({ orderPublicId: guest.orderPublicId, state: "PAID" });
    const create = vi.spyOn(rail, "create");
    const ticket = await json(await request("/v1/lab/guest/ticket", undefined, guest.token));
    expect(ticket).toMatchObject({ status: "VALID", occurrence: { title: "LAB" }, qrImage: expect.stringMatching(/^data:image\/png;base64,/) });
    expect(ticket.qrToken).not.toBe(guest.token);
    expect(await json(await request(`/v1/checkout/${guest.orderPublicId}`, undefined, guest.token))).toMatchObject({ state: "PAID" });
    const again = await pay(guest.token, guest.prepared.quoteId);
    expect(again.orderPublicId).toBe(guest.orderPublicId);
    expect((await pay(guest.token, guest.prepared.quoteId, "fresh-key")).orderPublicId).toBe(guest.orderPublicId);
    expect(create).not.toHaveBeenCalled(); expect(count("lab_tickets")).toBe(1); expect(count("orders")).toBe(1);
    expect(JSON.stringify(db.prepare("SELECT * FROM lab_guest_access").get())).not.toContain(guest.token);
  });
  it("preserves LMS sign-in, LAB legal and disabled-payment gates", async () => {
    expect((await request("/v1/checkout/preview", { offerRef: "course:one" })).status).toBe(401);
    const guest = await start();
    expect((await request("/v1/checkout/preview", { offerRef: "course:one" }, guest.token)).status).toBe(403);
    db.prepare("UPDATE legal_releases SET active=0").run(); expect((await quote(guest.token)).status).toBeGreaterThanOrEqual(400);
    app = createCommerceV2App({ db, config: { ...testCheckoutConfig, paymentMode: "disabled" }, sourceCommit: "test", serviceToken: "synthetic", paymentRail: rail });
    expect((await quote(guest.token)).status).toBe(503);
  });
  it("cannot read, reconcile, confirm or refund another order with the same customer email", async () => {
    const first = await purchase(), other = await start();
    expect(labAccess(db, first.token).customer_id).toBe(labAccess(db, other.token).customer_id);
    expect((await request(`/v1/checkout/${first.orderPublicId}`, undefined, other.token)).status).toBe(404);
    expect((await request("/v1/checkout", { quoteId: first.prepared.quoteId, labAcceptance: acceptance() }, other.token)).status).toBe(404);
    expect(await json(await request("/v1/lab/guest/ticket", undefined, other.token))).toMatchObject({ status: "NOT_ISSUED" });
    expect((await request("/v1/lab/guest/refunds", { reasonCode: "CUSTOMER_REQUEST", orderPublicId: first.orderPublicId }, other.token)).status).toBeGreaterThanOrEqual(400);
    expect(await json(await request("/v1/lab/guest/refunds", undefined, other.token))).toEqual({ refunds: [] });
  });
  it("reads a historical lost create ACK back on the same order, line and payment", async () => {
    const create = vi.spyOn(rail, "create");
    const guest = await purchase("ambiguous_create");
    expect(guest.paid.state).toBe("CREATE_UNKNOWN"); expect(count("lab_tickets")).toBe(0);
    expect((await pay(guest.token, guest.prepared.quoteId)).state).toBe("PAID");
    expect(count("orders")).toBe(1); expect(count("order_lines")).toBe(1); expect(count("lab_tickets")).toBe(1); expect(create).toHaveBeenCalledOnce();
  });
  it.each(["wrong_amount", "decline"])("does not issue for %s", async scenario => {
    const guest = await purchase(scenario); expect(guest.paid.state).toBe(scenario === "wrong_amount" ? "REVIEW_REQUIRED" : "DECLINED"); expect(count("lab_tickets")).toBe(0);
  });
  it("issues once after a late payment", async () => {
    const pending = await purchase("late_payment"); expect(pending.paid.state).toBe("PENDING"); expect(count("lab_tickets")).toBe(0);
    await json(await request(`/v1/checkout/${pending.orderPublicId}`, undefined, pending.token));
    expect(count("lab_tickets")).toBe(1);
    await json(await request(`/v1/checkout/${pending.orderPublicId}`, undefined, pending.token)); expect(count("lab_tickets")).toBe(1);
  });
});

describe("historical guest orders next to a confirmed account (PR #264 P1, after FLEX-60)", () => {
  const signIn = () => {
    db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run("owner", "Owner", "guest@example.com");
    signedIn = bindVerifiedAuthUser(db, { id: "owner", email: "guest@example.com" });
  };
  it("does not let a guest open payment block the same-email account's LAB checkout", async () => {
    await purchase("customer_action"); signIn();
    const prepared = await json(await request("/v1/checkout/preview", { offerRef: "lab:one" }));
    expect((await json(await request("/v1/checkout", { quoteId: prepared.quoteId, labAcceptance: acceptance() }))).state).toBe("PAID");
    expect(count("checkout_attempts")).toBe(2);
    expect(db.prepare(`SELECT acceptance.evidence_status,acceptance.source FROM lab_purchase_acceptances acceptance
      JOIN orders ON orders.id=acceptance.order_id JOIN checkout_quotes intent ON intent.order_public_id=orders.public_id WHERE intent.id=?`).all(prepared.quoteId))
      .toEqual([{ evidence_status: "VERIFIED_ACCOUNT", source: "CONFIRMED_ACCOUNT_ORDER_CONFIRM" }]);
  });
  it("keeps the last seat of a historical unresolved guest payment against a confirmed account", async () => {
    db.prepare("UPDATE lab_occurrences SET capacity=1").run();
    await purchase("customer_action"); signIn();
    const response = await request("/v1/checkout/preview", { offerRef: "lab:one" });
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ code: "LAB_OCCURRENCE_SOLD_OUT" });
    expect(count("checkout_attempts")).toBe(1);
  });
});

describe("email recovery, binding and irreversible check-in", () => {
  it("sends the same public reply for absent/mismatched emails; requesting recovery never invalidates the old QR", async () => {
    const guest = await purchase(), ticket = readLabTicket(db, guest.token);
    for (const email of ["guest@example.com", "missing@example.com"]) {
      const reply = await request("/v1/lab/guest/recover", { email, orderPublicId: guest.orderPublicId });
      expect(reply.status).toBe(202); expect(await reply.json()).toEqual({ accepted: true });
    }
    expect(emails).toHaveLength(2); expect(readLabTicket(db, guest.token)).toEqual(ticket);
  });
  it("rotates access and QR only on explicit redemption; lost redemption ACK is replayable but old/reused tokens fail", async () => {
    const guest = await purchase(), original = readLabTicket(db, guest.token), recovery = recoveryToken();
    const replacement = capability();
    const body = { recoveryToken: recovery, accessToken: replacement };
    await json(await request("/v1/lab/guest/recover/confirm", body)); await json(await request("/v1/lab/guest/recover/confirm", body));
    expect((await request("/v1/lab/guest/ticket", undefined, guest.token)).status).toBe(409);
    const ticket = readLabTicket(db, replacement); expect(ticket).toMatchObject({ status: "VALID" });
    expect("qrToken" in ticket && ticket.qrToken).not.toBe("qrToken" in original && original.qrToken);
    expect(() => checkInLabTicket(db, { qrToken: "qrToken" in original ? original.qrToken! : "", occurrenceRef: "lab:one", actor: "owner" }, now)).toThrow("LAB_QR_INVALID");
    expect((await request("/v1/lab/guest/recover/confirm", { ...body, accessToken: capability() })).status).toBe(409);
  });
  it("recovers purchased tickets by email alone with one email; missing addresses get the identical acknowledgement", async () => {
    await purchase();
    const before = send.mock.calls.length;
    expect(await json(await request("/v1/lab/guest/recover", { email: "guest@example.com" }))).toEqual({ accepted: true });
    expect(send.mock.calls.length).toBe(before + 1); expect(emails.at(-1)?.ticketLinks).toHaveLength(1);
    expect(await json(await request("/v1/lab/guest/recover", { email: "missing@example.com" }))).toEqual({ accepted: true });
    expect(send.mock.calls.length).toBe(before + 1);
  });
  it("refuses expired recovery links without replacing the active access", async () => {
    const guest = await purchase(); time = new Date(Date.parse(now) + 16 * 60_000);
    expect((await request("/v1/lab/guest/recover/confirm", { recoveryToken: recoveryToken(), accessToken: capability() })).status).toBe(409);
    expect(readLabTicket(db, guest.token)).toMatchObject({ status: "VALID" });
  });
  it("commits exactly one of two scans, refuses another occurrence, persists across recovery and cannot clear used_at in SQL", async () => {
    const guest = await purchase(), ticket = readLabTicket(db, guest.token);
    if (!("qrToken" in ticket)) throw new Error("ticket missing");
    expect(() => checkInLabTicket(db, { qrToken: ticket.qrToken!, occurrenceRef: "lab:other", actor: "door" }, now)).toThrow("LAB_QR_INVALID");
    const outcomes = await Promise.allSettled([1, 2].map(async () => checkInLabTicket(db, { qrToken: ticket.qrToken!, occurrenceRef: "lab:one", actor: "door" }, now)));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(() => db.prepare("UPDATE lab_tickets SET used_at=NULL,used_by=NULL").run()).toThrow("LAB_TICKET_USE_IRREVERSIBLE");
    expect(() => db.prepare("DELETE FROM lab_tickets").run()).toThrow("LAB_TICKET_USE_IRREVERSIBLE");
    const replacement = capability(); await json(await request("/v1/lab/guest/recover/confirm", { recoveryToken: recoveryToken(), accessToken: replacement }));
    expect(readLabTicket(db, replacement)).toMatchObject({ status: "USED", usedAt: now });
    expect(readLabTicket(db, replacement)).not.toHaveProperty("qrToken");
  });
  it("allows only an active Control Room operator, not public or service-token callers, to consume QR", async () => {
    const guest = await purchase(), ticket = readLabTicket(db, guest.token);
    const body = { qrToken: "qrToken" in ticket ? ticket.qrToken : "", occurrenceRef: "lab:one" };
    expect((await request("/v1/admin/v2/lab/check-in", body, guest.token)).status).toBe(403);
    const session = issueControlRoomSession(auth.sessionSecret, "singleton-admin", time.getTime());
    db.prepare("INSERT INTO control_room_admin_sessions(id,admin_id,created_at,expires_at) VALUES (?,?,?,?)")
      .run(session.session.sid, session.session.sub, now, new Date(session.session.exp).toISOString());
    const init = { method: "POST", headers: { origin: auth.origin, "Content-Type": "application/json", cookie: controlRoomSessionCookie(session.token, 3600).split(";")[0] }, body: JSON.stringify(body) };
    expect((await app.request("/v1/admin/v2/lab/check-in", init)).status).toBe(200);
    expect(await (await app.request("/v1/admin/v2/lab/check-in", init)).json()).toMatchObject({ error: { code: "LAB_QR_ALREADY_USED" } });
  });
  it("later binds the same guest and ticket to a verified account; an unrelated account cannot reissue", async () => {
    const guest = await purchase(), customerId = labAccess(db, guest.token).customer_id;
    db.prepare('INSERT INTO "user"(id,name,email,email_verified) VALUES (?,?,?,1)').run("u", "Guest", "guest@example.com");
    expect(bindVerifiedAuthUser(db, { id: "u", email: "guest@example.com" })).toBe(customerId);
    expect(listCustomerOrderHistory(db, customerId)).toEqual([expect.objectContaining({ orderPublicId: guest.orderPublicId, productKind: "LAB" })]);
    signedIn = "foreign";
    expect((await request("/v1/lab/guest/reissue", { orderPublicId: guest.orderPublicId, accessToken: capability() })).status).toBe(409);
    signedIn = customerId; const token = capability();
    await json(await request("/v1/lab/guest/reissue", { orderPublicId: guest.orderPublicId, accessToken: token }));
    expect(readLabTicket(db, token)).toMatchObject({ status: "VALID" }); expect(() => readLabTicket(db, guest.token)).toThrow();
  });
  it("runs the guest refund lifecycle with frozen receipt contact; full refund voids QR and late PAID cannot revive it", async () => {
    const guest = await purchase(), original = readLabTicket(db, guest.token);
    const refund = await json(await request("/v1/lab/guest/refunds", { reasonCode: "CUSTOMER_REQUEST" }, guest.token));
    expect(await json(await request("/v1/lab/guest/refunds", undefined, guest.token))).toMatchObject({ refunds: [expect.objectContaining({ orderPublicId: guest.orderPublicId })] });
    expect(readLabTicket(db, guest.token)).toMatchObject({ status: "VALID" });
    decideRefund(db, refund.requestPublicId, { outcome: "APPROVE", amountKopecks: 10000, policyBasis: "LAB offer", rationale: "reviewed", actor: "owner" }, now);
    await executeApprovedRefund(db, rail, { currentKeyId: "k", keys: { k: Buffer.alloc(32, 1) } }, refund.requestPublicId, now);
    expect(readLabTicket(db, guest.token)).toMatchObject({ status: "VOID" });
    await reconcileCheckout(db, rail, guest.orderPublicId, now);
    expect(readLabTicket(db, guest.token)).toMatchObject({ status: "VOID" });
    expect(() => checkInLabTicket(db, { qrToken: "qrToken" in original ? original.qrToken! : "", occurrenceRef: "lab:one", actor: "door" }, now)).toThrow("LAB_TICKET_VOID");
  });
  it("bounds email requests durably, refuses foreign origins and never echoes provider secrets", async () => {
    const guest = await purchase(); send.mockRejectedValueOnce(new Error("secret-provider-body"));
    for (let i = 0; i < 5; i++) expect(await json(await request("/v1/lab/guest/recover", { email: "guest@example.com", orderPublicId: guest.orderPublicId }))).toEqual({ accepted: true });
    expect(send).toHaveBeenCalledTimes(4); // initial ticket + three allowed recoveries; no auto retry.
    const foreign = await app.request("/v1/lab/guest/start", { method: "POST", headers: { origin: "https://foreign.test" }, body: JSON.stringify({ email: "a@b.test", accessToken: capability() }) });
    expect(foreign.status).toBe(403);
  });
});


describe("independent request sources (PR #264 P2)", () => {
  it("does not share recovery quotas between independent sources even for the same email", async () => {
    const guest = await purchase();
    for (let i = 0; i < 110; i++) expect(await json(await request("/v1/lab/guest/recover", { email: "guest@example.com", orderPublicId: guest.orderPublicId }))).toEqual({ accepted: true });
    expect(send).toHaveBeenCalledTimes(4);
    clientIp = "203.0.113.2";
    await json(await request("/v1/lab/guest/recover", { email: "guest@example.com" }));
    expect(send).toHaveBeenCalledTimes(5);
  });
  it.each([undefined, "10.0.5.99"])("refuses missing/untrusted transport %s despite plausible forged IP headers", async peer => {
    peerAddress = peer;
    const headers = { origin, "Content-Type": "application/json", "x-real-ip": "192.0.2.2",
      "x-forwarded-for": "192.0.2.3", "cf-connecting-ip": "192.0.2.4", forwarded: "for=192.0.2.5" };
    const body = JSON.stringify({ email: "guest@example.com", accessToken: capability() });
    const recover = await app.request("/v1/lab/guest/recover", { method: "POST", headers, body });
    expect(recover.status).toBe(503); expect(await recover.json()).toEqual({ code: "LAB_SOURCE_UNAVAILABLE" });
    // Closed before any source accounting: nothing is allocated whatever the transport says.
    const started = await app.request("/v1/lab/guest/start", { method: "POST", headers, body });
    expect(started.status).toBe(403);
    expect(count("lab_guest_access")).toBe(0); expect(count("lab_guest_rate_limits")).toBe(0); expect(send).not.toHaveBeenCalled();
  });
});
