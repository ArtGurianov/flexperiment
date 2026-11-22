import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { checkout, confirmCheckout, MockPaymentRail, prepareCheckout, reconcileCheckout } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { beginLabOccurrenceCancellation, completeLabOccurrenceCancellation, labOccurrenceOrders, reconcileLabOccurrenceAttempts,
  type LabRouteContour } from "../src/lab-lifecycle";
import { labSeatInventory } from "../src/lab-occurrences";
import { checkInLabTicket, labTicketQrSecretFromEnv, readOwnedLabTicket, reissueOwnedLabQr } from "../src/lab-tickets";
import { decideRefund, executeApprovedRefund, requestRefund } from "../src/refunds";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { confirmLabBuyer, labAcceptanceFor } from "./fixtures/lab-purchase";
import { openTestStorefront, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";

// FLEX-57–62 (D): the LAB lifecycle on a confirmed account, on synthetic fixtures only.
let db: Database.Database, rail: MockPaymentRail;
const NOW = "2026-10-19T10:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const REF = "lab:one";
const secret = Buffer.alloc(32, 7);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function world(target: Database.Database, capacity = 20) {
  target.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal','LAB','lab-b',?,?,1)").run(stageBLegalManifestJson, NOW);
  target.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
  target.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
    VALUES ('event',?, 'city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',?,'CONFIRMED','Студия','Адрес')`).run(REF, capacity);
  target.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product',?,'LAB','PAID',?)").run(REF, REF);
  target.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer',?,'product',10000,'PUBLIC')").run(REF);
  qualifyTestFiscalPolicies(target); openTestStorefront(target, "LAB");
}
let buyers = 0;
const buyer = (confirmed = true) => {
  const id = `buyer-${++buyers}`;
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.test`);
  if (confirmed) confirmLabBuyer(db, id);
  return { customerId: id, customerEmail: `${id}@example.test` };
};
const preview = (who: ReturnType<typeof buyer>, key = `preview-${who.customerId}`, scenario?: string, now = NOW) =>
  prepareCheckout(db, rail, testCheckoutConfig, { ...who, offerRef: REF, previewIdempotencyKey: key, scenario, storefront: "LAB" }, now);
const buy = (who: ReturnType<typeof buyer>, scenario?: string, now = NOW) =>
  checkout(db, rail, testCheckoutConfig, { ...who, offerRef: REF, idempotencyKey: `pay-${who.customerId}`, scenario, labAcceptance: labAcceptanceFor(db) }, now);
/** Stand-in for C's routeContour(order) (FLEX-119, #289): every fixture order is native, unless listed. */
const contours = new Map<string, string | null>();
const routeContour: LabRouteContour = order => contours.has(order.orderPublicId) ? contours.get(order.orderPublicId)! : "NATIVE";
const occurrence = () => db.prepare("SELECT * FROM lab_occurrences WHERE occurrence_ref=?").get(REF) as Parameters<typeof labSeatInventory>[1];

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); rail = new MockPaymentRail(); buyers = 0; contours.clear();
  world(db);
});
afterEach(() => db.close());

describe("FLEX-60: confirmed account before any hold, order or payment", () => {
  it("refuses an unconfirmed customer before a hold and records nothing", async () => {
    const who = buyer(false);
    const resolve = vi.spyOn(rail, "resolve"), create = vi.spyOn(rail, "create");
    await expect(preview(who)).rejects.toThrow("LAB_ACCOUNT_CONFIRMATION_REQUIRED");
    expect(count("checkout_quotes")).toBe(0); expect(count("orders")).toBe(0);
    expect(resolve).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
  it("refuses confirmation when the account lost its binding after the quote, under the order lock", async () => {
    const who = buyer(), quote = await preview(who);
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("quote expected");
    db.prepare("UPDATE customers SET auth_user_id=NULL WHERE id=?").run(who.customerId);
    const create = vi.spyOn(rail, "create");
    await expect(confirmCheckout(db, rail, testCheckoutConfig, { ...who, quoteId: quote.quoteId, idempotencyKey: "pay", labAcceptance: labAcceptanceFor(db) }, at(1)))
      .rejects.toThrow("LAB_ACCOUNT_CONFIRMATION_REQUIRED");
    expect(create).not.toHaveBeenCalled(); expect(count("orders")).toBe(0);
  });
  it("never records a marketing choice in the purchase acceptance (regression, E 21.11.2026)", async () => {
    const who = buyer(); await buy(who);
    const row = db.prepare("SELECT consents_json FROM lab_purchase_acceptances").get() as { consents_json: string };
    const consents = JSON.parse(row.consents_json) as { documents: Array<{ kind: string }> } & Record<string, unknown>;
    expect(Object.keys(consents).sort()).toEqual(["documents", "personalDataConsent", "receiptContactAccepted", "termsAccepted"]);
    expect(consents.documents.map(document => document.kind)).not.toContain("marketing_consent");
    expect(row.consents_json).not.toMatch(/marketing/i);
  });
  it("requires the current Stage B acceptance and stores it with the customer and order snapshot in the confirm transaction", async () => {
    const who = buyer(), quote = await preview(who);
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("quote expected");
    const create = vi.spyOn(rail, "create");
    for (const labAcceptance of [undefined, { ...labAcceptanceFor(db), termsAccepted: false }, { ...labAcceptanceFor(db), manifestSha256: "0".repeat(64) }]) {
      await expect(confirmCheckout(db, rail, testCheckoutConfig, { ...who, quoteId: quote.quoteId, idempotencyKey: "pay", labAcceptance }, at(1)))
        .rejects.toThrow("LAB_CONSENT_REQUIRED");
    }
    expect(create).not.toHaveBeenCalled(); expect(count("orders")).toBe(0); expect(count("lab_purchase_acceptances")).toBe(0);
    const paid = await confirmCheckout(db, rail, testCheckoutConfig, { ...who, quoteId: quote.quoteId, idempotencyKey: "pay", labAcceptance: labAcceptanceFor(db) }, at(1));
    expect(paid.state).toBe("PAID");
    const order = db.prepare("SELECT id,snapshot_hash FROM orders").get() as { id: string; snapshot_hash: string };
    const row = db.prepare("SELECT * FROM lab_purchase_acceptances").get() as Record<string, string>;
    expect(row).toMatchObject({ order_id: order.id, customer_id: who.customerId, quote_id: quote.quoteId, release_version: "lab-b",
      manifest_sha256: labAcceptanceFor(db).manifestSha256, order_snapshot_hash: order.snapshot_hash,
      accepted_at: at(1), source: "CONFIRMED_ACCOUNT_ORDER_CONFIRM", evidence_status: "VERIFIED_ACCOUNT" });
    expect(JSON.parse(row.consents_json).documents.map((document: { kind: string }) => document.kind)).toEqual(
      expect.arrayContaining(["personal_data", "receipt_contact", "refund_terms"]));
    // E (21.11.2026): the minimum only — no email, IP, free text or marketing choice.
    expect(JSON.stringify(row)).not.toContain(who.customerEmail); expect(row.consents_json).not.toMatch(/marketing|"ip|note|@/i);
    expect(Object.keys(JSON.parse(row.consents_json)).sort()).toEqual(["documents", "personalDataConsent", "receiptContactAccepted", "termsAccepted"]);
    expect(() => db.prepare("UPDATE lab_purchase_acceptances SET release_version='x'").run()).toThrow("LAB_ACCEPTANCE_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM lab_purchase_acceptances").run()).toThrow("LAB_ACCEPTANCE_IMMUTABLE");
  });
  it("refuses a confirmation after the LAB release changed since the quote", async () => {
    const who = buyer(), quote = await preview(who);
    if (quote.state !== "PRICE_REVIEW_REQUIRED") throw new Error("quote expected");
    db.prepare("UPDATE legal_releases SET active=0").run();
    db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal-2','LAB','lab-b2',?,?,1)").run(stageBLegalManifestJson, NOW);
    await expect(confirmCheckout(db, rail, testCheckoutConfig, { ...who, quoteId: quote.quoteId, idempotencyKey: "pay", labAcceptance: labAcceptanceFor(db) }, at(1)))
      .rejects.toThrow("CHECKOUT_QUOTE_STALE"); // Intent admission sees the new release first; LAB_LEGAL_RELEASE_CHANGED backs it up.
    expect(count("orders")).toBe(0);
  });
});

describe("FLEX-57/58: seats, uncertain payments, one booking and one ticket", () => {
  it("gives the last seat to exactly one of two concurrent confirmed buyers", async () => {
    db.prepare("UPDATE lab_occurrences SET capacity=1").run();
    const outcomes = await Promise.allSettled([preview(buyer()), preview(buyer())]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { message: "LAB_OCCURRENCE_SOLD_OUT" } });
    expect(labSeatInventory(db, occurrence(), NOW)).toMatchObject({ held: 1, available: 0 });
  });
  it("keeps the seat of an uncertain payment after every TTL and releases it only on a final outcome", async () => {
    db.prepare("UPDATE lab_occurrences SET capacity=1").run();
    const first = buyer();
    expect((await buy(first, "ambiguous_create")).state).toBe("CREATE_UNKNOWN");
    const late = at(24 * 60);
    expect(labSeatInventory(db, occurrence(), late)).toMatchObject({ pending: 1, available: 0 });
    await expect(preview(buyer(), "late-preview", undefined, late)).rejects.toThrow("LAB_OCCURRENCE_SOLD_OUT");
    const order = db.prepare("SELECT public_id FROM orders").get() as { public_id: string };
    expect((await reconcileCheckout(db, rail, order.public_id, late, testCheckoutConfig)).state).toBe("PAID");
    expect(labSeatInventory(db, occurrence(), late)).toMatchObject({ sold: 1, pending: 0, available: 0 });
  });
  it("issues one booking and one ticket however often the payment result repeats, including a late result", async () => {
    const who = buyer();
    expect((await buy(who, "late_payment")).state).toBe("PENDING");
    expect(count("lab_tickets")).toBe(0);
    const order = db.prepare("SELECT public_id FROM orders").get() as { public_id: string };
    for (let i = 0; i < 3; i++) await reconcileCheckout(db, rail, order.public_id, at(10 + i));
    expect((await buy(who, "late_payment")).orderPublicId).toBe(order.public_id);
    expect(count("orders")).toBe(1); expect(count("order_lines")).toBe(1); expect(count("checkout_attempts")).toBe(1); expect(count("lab_tickets")).toBe(1);
  });
});

describe("FLEX-60/123: the owner's ticket and QR, single check-in", () => {
  const paidTicket = async () => {
    const who = buyer(); await buy(who);
    const { public_id } = db.prepare("SELECT public_id FROM orders WHERE customer_id=?").get(who.customerId) as { public_id: string };
    return { who, orderPublicId: public_id };
  };
  it("shows the same QR on every view, only to the order's owner; reissue is explicit and revokes the old QR", async () => {
    const { who, orderPublicId } = await paidTicket();
    const first = readOwnedLabTicket(db, secret, who.customerId, orderPublicId);
    expect(first).toMatchObject({ status: "VALID", qrToken: expect.any(String) });
    expect(readOwnedLabTicket(db, secret, who.customerId, orderPublicId)).toEqual(first);
    const stranger = buyer();
    expect(() => readOwnedLabTicket(db, secret, stranger.customerId, orderPublicId)).toThrow("LAB_TICKET_NOT_FOUND");
    expect(() => readOwnedLabTicket(db, Buffer.alloc(8), who.customerId, orderPublicId)).toThrow("LAB_TICKET_SECRET_UNAVAILABLE");
    const reissued = reissueOwnedLabQr(db, secret, who.customerId, orderPublicId, at(5));
    expect(reissued).toMatchObject({ status: "VALID" });
    expect("qrToken" in reissued && reissued.qrToken).not.toBe("qrToken" in first && first.qrToken);
    expect(() => checkInLabTicket(db, { qrToken: "qrToken" in first ? first.qrToken! : "", occurrenceRef: REF, actor: "door" }, at(6))).toThrow("LAB_QR_INVALID");
    expect(checkInLabTicket(db, { qrToken: "qrToken" in reissued ? reissued.qrToken! : "", occurrenceRef: REF, actor: "door" }, at(6))).toMatchObject({ status: "USED" });
  });
  it("commits exactly one of two scans, refuses another occurrence and keeps the use record through reissue attempts", async () => {
    const { who, orderPublicId } = await paidTicket();
    const ticket = readOwnedLabTicket(db, secret, who.customerId, orderPublicId);
    const qrToken = "qrToken" in ticket ? ticket.qrToken! : "";
    expect(() => checkInLabTicket(db, { qrToken, occurrenceRef: "lab:other", actor: "door" }, at(1))).toThrow("LAB_QR_INVALID");
    const scans = await Promise.allSettled([1, 2].map(async () => checkInLabTicket(db, { qrToken, occurrenceRef: REF, actor: "door" }, at(2))));
    expect(scans.filter(scan => scan.status === "fulfilled")).toHaveLength(1);
    expect(() => reissueOwnedLabQr(db, secret, who.customerId, orderPublicId, at(3))).toThrow("LAB_QR_ALREADY_USED");
    expect(readOwnedLabTicket(db, secret, who.customerId, orderPublicId)).toMatchObject({ status: "USED", usedAt: at(2) });
    expect(readOwnedLabTicket(db, secret, who.customerId, orderPublicId)).not.toHaveProperty("qrToken");
  });
  it("serves the owned ticket only on an MY session of the confirmed owner and the configured secret", async () => {
    const { who, orderPublicId } = await paidTicket();
    let session: { customerId: string; audience: "MY" | "LMS" | "LEGACY" } | null = null;
    const make = (labTicketQrSecret?: Buffer, withResolver = true) => createCommerceV2App({ db, config: testCheckoutConfig, sourceCommit: "a".repeat(40),
      serviceToken: "synthetic", paymentRail: rail, now: () => new Date(NOW), labTicketQrSecret,
      // A legacy authenticator alone never opens an MY route.
      authenticateCustomer: async () => who.customerId, resolveSessionAudience: withResolver ? async () => session : undefined });
    const get = (app: ReturnType<typeof make>) => app.request(`/v1/my/tickets/${orderPublicId}`);
    expect((await get(make(secret, false))).status).toBe(503);
    expect((await get(make(secret))).status).toBe(401);
    for (const audience of ["LMS", "LEGACY"] as const) {
      session = { customerId: who.customerId, audience };
      const refused = await get(make(secret));
      expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ code: "SESSION_AUDIENCE_FORBIDDEN" });
    }
    session = { customerId: who.customerId, audience: "MY" };
    expect((await get(make())).status).toBe(503);
    const response = await get(make(secret));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ status: "VALID", qrImage: expect.stringMatching(/^data:image\/png;base64,/) });
    session = { customerId: buyer().customerId, audience: "MY" }; // A foreign confirmed customer.
    expect((await get(make(secret))).status).toBe(404);
    // An unverified email is not a confirmed account, even with an MY session.
    db.prepare('UPDATE "user" SET email_verified=0 WHERE id=(SELECT auth_user_id FROM customers WHERE id=?)').run(who.customerId);
    session = { customerId: who.customerId, audience: "MY" };
    const unverified = await get(make(secret));
    expect(unverified.status).toBe(403); expect(await unverified.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
  });
});

describe("FLEX-59: occurrence cancellation with committed seats", () => {
  it("closes sales at once, waits for every started payment, then cancels with refund obligations of the original executor", async () => {
    const paid = buyer(), checkedIn = buyer(), pending = buyer();
    await buy(paid); await buy(checkedIn); expect((await buy(pending, "late_payment")).state).toBe("PENDING");
    const held = buyer(); await preview(held);
    const usedOrder = db.prepare("SELECT public_id FROM orders WHERE customer_id=?").get(checkedIn.customerId) as { public_id: string };
    const qr = readOwnedLabTicket(db, secret, checkedIn.customerId, usedOrder.public_id);
    checkInLabTicket(db, { qrToken: "qrToken" in qr ? qr.qrToken! : "", occurrenceRef: REF, actor: "door" }, at(1));

    expect(beginLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner", reason: "Площадка недоступна" }, at(2))).toMatchObject({ state: "REQUESTED" });
    expect(beginLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner", reason: "again" }, at(3))).toMatchObject({ replayed: true });
    expect(db.prepare("SELECT sale_mode FROM offers").get()).toEqual({ sale_mode: "CLOSED" });
    expect(db.prepare("SELECT state,failure_code FROM checkout_quotes WHERE customer_id=?").get(held.customerId))
      .toEqual({ state: "EXPIRED", failure_code: "LAB_OCCURRENCE_CANCELLING" });
    db.prepare("UPDATE offers SET sale_mode='PUBLIC'").run(); // Even a reopened offer row cannot sell a cancelling occurrence.
    await expect(preview(buyer(), "after-begin", undefined, at(4))).rejects.toThrow("LAB_OCCURRENCE_CANCELLING");

    // The started payment keeps its seat and blocks completion until its own executor reports a final outcome.
    expect(() => completeLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner" }, routeContour, at(5))).toThrow("LAB_CANCELLATION_OPEN_PAYMENTS");
    expect(labSeatInventory(db, occurrence(), at(5))).toMatchObject({ pending: 1 });
    const unavailable = await reconcileLabOccurrenceAttempts(db, REF, routeContour, { REFREF_RC2: async () => undefined });
    expect(unavailable).toMatchObject({ selected: 1, reconciled: 0, executorUnavailable: [expect.any(String)] });
    const read = vi.spyOn(rail, "reconcile"), create = vi.spyOn(rail, "create"), recover = vi.spyOn(rail, "recoverCreate");
    expect(await reconcileLabOccurrenceAttempts(db, REF, routeContour, { NATIVE: (id: string) => reconcileCheckout(db, rail, id, at(6)) })).toMatchObject({ reconciled: 1 });
    expect(read).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();

    const done = completeLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner" }, routeContour, at(7));
    expect(done.state).toBe("COMPLETED");
    expect(done.obligations).toHaveLength(3);
    expect(done.obligations.every(obligation => obligation.contour === "NATIVE" && obligation.reasonCode === "OCCURRENCE_CHANGED")).toBe(true);
    expect(done.obligations.filter(obligation => obligation.ticketUsedAt)).toEqual([expect.objectContaining({ orderPublicId: usedOrder.public_id, ticketUsedAt: at(1) })]);
    expect(completeLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner" }, routeContour, at(8))).toMatchObject({ replayed: true, obligations: done.obligations });
    expect(db.prepare("SELECT lifecycle,cancellation_reason FROM lab_occurrences").get()).toEqual({ lifecycle: "CANCELLED", cancellation_reason: "Площадка недоступна" });
    expect(db.prepare("SELECT change_kind FROM lab_occurrence_revisions ORDER BY created_at DESC LIMIT 1").get()).toEqual({ change_kind: "CANCELLED" });
    // Entry ends; a pass that already happened stays recorded.
    expect(readOwnedLabTicket(db, secret, paid.customerId, (db.prepare("SELECT public_id FROM orders WHERE customer_id=?").get(paid.customerId) as { public_id: string }).public_id))
      .toMatchObject({ status: "VOID" });
    expect(db.prepare("SELECT used_at,used_by FROM lab_tickets WHERE used_at IS NOT NULL").all()).toEqual([{ used_at: at(1), used_by: "door" }]);
    expect(() => db.prepare("UPDATE lab_occurrence_cancellations SET state='REQUESTED',completed_at=NULL,obligations_json=NULL").run()).toThrow("LAB_CANCELLATION_FORWARD_ONLY");
  });
});

describe("cancellation reason (E review item 6)", () => {
  it("accepts a short operational reason and refuses a long one", () => {
    expect(() => beginLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner", reason: "x".repeat(201) }, at(1))).toThrow("LAB_CHANGE_REASON_REQUIRED");
    expect(beginLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner", reason: "Площадка недоступна" }, at(1))).toMatchObject({ state: "REQUESTED" });
  });
});

describe("FLEX-62: refund and a late result", () => {
  it("refunds a cancelled seat, voids entry and a later PAID read-back cannot revive it", async () => {
    const who = buyer(); await buy(who);
    const { public_id: orderPublicId } = db.prepare("SELECT public_id FROM orders").get() as { public_id: string };
    const ticket = readOwnedLabTicket(db, secret, who.customerId, orderPublicId);
    const refund = requestRefund(db, { customerId: who.customerId, orderPublicId, idempotencyKey: "refund", reasonCode: "OCCURRENCE_CHANGED" }, at(1));
    expect(requestRefund(db, { customerId: who.customerId, orderPublicId, idempotencyKey: "refund", reasonCode: "OCCURRENCE_CHANGED" }, at(2)).requestPublicId)
      .toBe(refund.requestPublicId);
    decideRefund(db, refund.requestPublicId, { outcome: "APPROVE", amountKopecks: 10000, policyBasis: "LAB offer", rationale: "occurrence cancelled", actor: "owner" }, at(3));
    await executeApprovedRefund(db, rail, { currentKeyId: "k", keys: { k: Buffer.alloc(32, 1) } }, refund.requestPublicId, at(4));
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "REFUNDED" });
    expect(labSeatInventory(db, occurrence(), at(4))).toMatchObject({ sold: 0, available: 20 });
    await reconcileCheckout(db, rail, orderPublicId, at(5));
    expect(readOwnedLabTicket(db, secret, who.customerId, orderPublicId)).toMatchObject({ status: "VOID" });
    expect(() => checkInLabTicket(db, { qrToken: "qrToken" in ticket ? ticket.qrToken! : "", occurrenceRef: REF, actor: "door" }, at(6))).toThrow("LAB_TICKET_VOID");
    expect(labOccurrenceOrders(db, REF)).toEqual([expect.objectContaining({ orderState: "REFUNDED", refundState: "REFUNDED" })]);
  });
});

describe("historical purchases keep their original contour (C's routeContour)", () => {
  it("never reads back an order through another contour's rail, and hands an unknown contour to a person", async () => {
    const historical = buyer(), unknown = buyer();
    expect((await buy(historical, "late_payment")).state).toBe("PENDING");
    expect((await buy(unknown, "late_payment")).state).toBe("PENDING");
    const orderOf = (who: ReturnType<typeof buyer>) => (db.prepare("SELECT public_id FROM orders WHERE customer_id=?").get(who.customerId) as { public_id: string }).public_id;
    contours.set(orderOf(historical), "REFREF_RC2"); contours.set(orderOf(unknown), null);
    beginLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner", reason: "Отмена" }, at(1));
    const native = vi.fn(async () => undefined);
    expect(await reconcileLabOccurrenceAttempts(db, REF, routeContour, { NATIVE: native }))
      .toEqual({ selected: 2, reconciled: 0, failed: 0, executorUnavailable: expect.arrayContaining([orderOf(historical), orderOf(unknown)]) });
    expect(native).not.toHaveBeenCalled();
    const refref = vi.fn(async (id: string) => reconcileCheckout(db, rail, id, at(2)));
    contours.set(orderOf(unknown), "REFREF_RC2");
    expect(await reconcileLabOccurrenceAttempts(db, REF, routeContour, { REFREF_RC2: refref })).toMatchObject({ reconciled: 2 });
    contours.set(orderOf(unknown), null);
    const done = completeLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner" }, routeContour, at(3));
    expect(done.obligations.map(obligation => [obligation.orderPublicId, obligation.contour]))
      .toEqual(expect.arrayContaining([[orderOf(historical), "REFREF_RC2"], [orderOf(unknown), null]]));
  });
});

describe("MY contracts (FLEX-122 R4, FLEX-123 R2)", () => {
  let signedIn: string | null = null;
  const MY = "http://localhost:3002";
  beforeEach(() => { signedIn = null; });
  const make = (qrSecret: Buffer | null = secret) => createCommerceV2App({ db, config: testCheckoutConfig, sourceCommit: "a".repeat(40),
    serviceToken: "synthetic", paymentRail: rail, now: () => new Date(NOW), authenticateCustomer: async () => signedIn, labTicketQrSecret: qrSecret ?? undefined, myOrigin: MY,
    resolveSessionAudience: async () => signedIn ? { customerId: signedIn, audience: "MY" as const } : null });
  const post = (app: ReturnType<typeof make>, path: string, body: unknown, origin = MY, key = "k") => app.request(path, { method: "POST",
    headers: { origin, "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify(body) });

  it("answers preview and confirm with 403 LAB_ACCOUNT_CONFIRMATION_REQUIRED for an unconfirmed account; confirmed takes the same labAcceptance body", async () => {
    const app = make();
    const unconfirmed = buyer(false); signedIn = unconfirmed.customerId;
    const preview = await post(app, "/v1/checkout/preview", { offerRef: REF });
    expect(preview.status).toBe(403); expect(await preview.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
    const confirmed = buyer(); signedIn = confirmed.customerId;
    const quote = await (await post(app, "/v1/checkout/preview", { offerRef: REF }, MY, "q")).json() as { quoteId: string };
    const { auth_user_id: userId } = db.prepare("SELECT auth_user_id FROM customers WHERE id=?").get(confirmed.customerId) as { auth_user_id: string };
    db.prepare("UPDATE customers SET auth_user_id=NULL WHERE id=?").run(confirmed.customerId); // Lost between preview and confirm.
    const refused = await post(app, "/v1/checkout", { quoteId: quote.quoteId, labAcceptance: labAcceptanceFor(db) }, MY, "p");
    expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
    db.prepare("UPDATE customers SET auth_user_id=? WHERE id=?").run(userId, confirmed.customerId);
    const noAcceptance = await post(app, "/v1/checkout", { quoteId: quote.quoteId }, MY, "p2");
    expect(noAcceptance.status).toBe(403); expect(await noAcceptance.json()).toEqual({ code: "LAB_CONSENT_REQUIRED" });
    const paid = await post(app, "/v1/checkout", { quoteId: quote.quoteId, labAcceptance: labAcceptanceFor(db) }, MY, "p3");
    expect(paid.status).toBe(201); expect(await paid.json()).toMatchObject({ state: "PAID" });
    expect(count("lab_purchase_acceptances")).toBe(1);
  });

  it("lists a confirmed account's tickets without QR, token or capability, private and no-store", async () => {
    const app = make();
    expect((await app.request("/v1/my/tickets")).status).toBe(401);
    const who = buyer(); await buy(who);
    const order = db.prepare("SELECT public_id FROM orders").get() as { public_id: string };
    signedIn = who.customerId;
    const response = await app.request("/v1/my/tickets");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toEqual({ tickets: [{ orderPublicId: order.public_id, title: "LAB", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T17:00:00Z",
      timezone: "Asia/Novosibirsk", venueName: "Студия", status: "VALID", viewPath: `/tickets/${order.public_id}` }] });
    expect(JSON.stringify(body)).not.toMatch(/qr|token|capability/i);
    expect(db.prepare("SELECT qr_sha256 FROM lab_tickets").get()).toEqual({ qr_sha256: null }); // Listing issues no QR.
    const other = buyer(false); signedIn = other.customerId;
    const refused = await app.request("/v1/my/tickets");
    expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ code: "LAB_ACCOUNT_CONFIRMATION_REQUIRED" });
  });

  it("reissues an owned QR only from a known origin and stays closed without the env secret", async () => {
    const who = buyer(); await buy(who); signedIn = who.customerId;
    const { public_id } = db.prepare("SELECT public_id FROM orders").get() as { public_id: string };
    const path = `/v1/my/tickets/${public_id}/qr/reissue`;
    expect((await post(make(), path, {}, "https://foreign.test")).status).toBe(403);
    expect((await post(make(), path, {})).status).toBe(200);
    expect((await post(make(null), path, {})).status).toBe(503);
    expect(labTicketQrSecretFromEnv({})).toBeUndefined();
    expect(labTicketQrSecretFromEnv({ LAB_TICKET_QR_SECRET: Buffer.alloc(16, 1).toString("base64url") })).toBeUndefined();
    expect(labTicketQrSecretFromEnv({ LAB_TICKET_QR_SECRET: "not base64url!" })).toBeUndefined();
    expect(labTicketQrSecretFromEnv({ LAB_TICKET_QR_SECRET: Buffer.alloc(32, 1).toString("base64url") })).toEqual(Buffer.alloc(32, 1));
  });
});
