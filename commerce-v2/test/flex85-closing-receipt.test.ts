import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { controlRoomSessionCookie, issueControlRoomSession } from "../src/control-room-auth";
import { checkout, MockPaymentRail } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { beginLabOccurrenceCancellation } from "../src/lab-lifecycle";
import { checkInLabTicket, readOwnedLabTicket } from "../src/lab-tickets";
import { requestRefund } from "../src/refunds";
import { attestLabAttendance, closingEligibility, labServiceRenderedBacklog, listServiceRenderedFacts, recordCheckedInServiceRendered,
  serviceRenderedFact, SERVICE_RENDERED_SCHEMA } from "../src/service-rendered";
import { finalSettlementKey, FixtureFiscalProvider, runFixtureIssuance, type JobState } from "./fixtures/c-issuance-job";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { confirmLabBuyer, labAcceptanceFor } from "./fixtures/lab-purchase";
import { openTestStorefront, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";

/**
 * FLEX-85 evidence (D → FLEX-84 package), synthetic fixtures only: prepayment at purchase, D's
 * authoritative SERVICE_RENDERED after the master class, and exactly one closing receipt with no new
 * charge through replay, a lost answer and reconciliation. The issuance job and provider are test
 * stand-ins following C's published rules (#289); C's adapter qualification is separate.
 */
let db: Database.Database, rail: MockPaymentRail, provider: FixtureFiscalProvider;
const BOUGHT = "2026-10-19T10:00:00.000Z", ENDS = "2026-11-01T17:00:00Z", AFTER = "2026-11-01T18:00:00.000Z";
const REF = "lab:one";
const secret = Buffer.alloc(32, 9);
let buyers = 0;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const native = () => "NATIVE";

async function paidSeat(checkedIn = true) {
  const id = `buyer-${++buyers}`;
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.test`);
  confirmLabBuyer(db, id);
  const paid = await checkout(db, rail, testCheckoutConfig, { customerId: id, customerEmail: `${id}@example.test`, offerRef: REF,
    idempotencyKey: `pay-${id}`, labAcceptance: labAcceptanceFor(db) }, BOUGHT);
  expect(paid.state).toBe("PAID");
  const line = db.prepare(`SELECT line.id,line.fiscal_item_json,ticket.id AS ticket_id FROM order_lines line JOIN orders ON orders.id=line.order_id
    JOIN lab_tickets ticket ON ticket.order_line_id=line.id WHERE orders.public_id=?`).get(paid.orderPublicId) as { id: string; fiscal_item_json: string; ticket_id: string };
  if (checkedIn) {
    const ticket = readOwnedLabTicket(db, secret, id, paid.orderPublicId);
    checkInLabTicket(db, { qrToken: "qrToken" in ticket ? ticket.qrToken! : "", occurrenceRef: REF, actor: "door" }, "2026-11-01T09:05:00.000Z");
  }
  return { customerId: id, orderPublicId: paid.orderPublicId, lineId: line.id, ticketId: line.ticket_id, fiscalItem: JSON.parse(line.fiscal_item_json) };
}

beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db); rail = new MockPaymentRail(); buyers = 0;
  provider = new FixtureFiscalProvider();
  db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-legal','LAB','lab-b',?,?,1)").run(stageBLegalManifestJson, BOUGHT);
  db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
  db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
    VALUES ('event',?, 'city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Адрес')`).run(REF);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('product',?,'LAB','PAID',?)").run(REF, REF);
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer',?,'product',10000,'PUBLIC')").run(REF);
  qualifyTestFiscalPolicies(db); openTestStorefront(db, "LAB");
});
afterEach(() => db.close());

describe("FLEX-85: prepayment → SERVICE_RENDERED → one closing receipt, no new charge", () => {
  it("runs end to end with replay, a lost answer and reconciliation, and never charges again", async () => {
    const create = vi.spyOn(rail, "create"), recover = vi.spyOn(rail, "recoverCreate");
    const seat = await paidSeat();
    expect(create).toHaveBeenCalledOnce();

    const recorded = recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER);
    expect(recorded).toEqual({ occurrenceRef: REF, recorded: [seat.lineId], replayed: [], review: [] });
    const fact = serviceRenderedFact(db, seat.lineId);
    expect(fact).toEqual({ schema: SERVICE_RENDERED_SCHEMA, orderLineId: seat.lineId, occurrenceRef: REF, renderedAt: "2026-11-01T09:05:00.000Z",
      evidenceRef: `lab-ticket:${seat.ticketId}:used`, recordedBy: "owner", basis: "CHECKED_IN", attestationReason: null, recordedAt: AFTER });
    expect(recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER)).toMatchObject({ recorded: [], replayed: [seat.lineId] });
    expect(listServiceRenderedFacts(db)).toEqual([fact]);

    const store = new Map<string, { state: JobState; providerRef?: string; code?: string }>();
    provider.loseNextAnswer = true; // The provider issued, the answer is lost.
    await runFixtureIssuance(db, provider, store, native);
    expect(store.get(finalSettlementKey(seat.lineId))).toEqual({ state: "UNKNOWN" });
    provider.readBackUnavailable = true;
    await runFixtureIssuance(db, provider, store, native); // Unknown and unreadable: nothing is sent again.
    provider.readBackUnavailable = false;
    await runFixtureIssuance(db, provider, store, native);
    expect(store.get(finalSettlementKey(seat.lineId))).toEqual({ state: "ISSUED", providerRef: "fixture-receipt-1" });
    await runFixtureIssuance(db, provider, store, native);
    expect(provider.submissions).toHaveLength(1); expect(provider.receipts.size).toBe(1);
    expect(provider.readBacks).toEqual([finalSettlementKey(seat.lineId), finalSettlementKey(seat.lineId)]);
    expect(provider.submissions[0]).toMatchObject({ key: `fiscal:FINAL_SETTLEMENT:${seat.lineId}`, lines: [seat.fiscalItem],
      advanceOffsetKopecks: 10000, newPaymentKopecks: 0 });
    expect(create).toHaveBeenCalledOnce(); expect(recover).not.toHaveBeenCalled(); expect(count("checkout_attempts")).toBe(1);
    expect(() => db.prepare("UPDATE lab_service_renditions SET basis='ATTENDED_ATTESTED'").run()).toThrow("LAB_SERVICE_RENDERED_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM lab_service_renditions").run()).toThrow("LAB_SERVICE_RENDERED_IMMUTABLE");
  });

  it("re-sends under the same key only after read-back says NOT_FOUND (a claim lost before the provider acted)", async () => {
    const seat = await paidSeat();
    recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER);
    const store = new Map([[finalSettlementKey(seat.lineId), { state: "UNKNOWN" as JobState }]]);
    await runFixtureIssuance(db, provider, store, native);
    expect(provider.readBacks).toEqual([finalSettlementKey(seat.lineId)]); expect(provider.submissions).toHaveLength(1);
    expect(store.get(finalSettlementKey(seat.lineId))).toMatchObject({ state: "ISSUED" });
  });

  it("survives a restore: the restored copy keeps the same facts and the job reads back before any repeat", async () => {
    const seat = await paidSeat();
    recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER);
    const store = new Map<string, { state: JobState }>();
    provider.loseNextAnswer = true; await runFixtureIssuance(db, provider, store, native);
    const restored = new Database(db.serialize()); restored.pragma("foreign_keys=ON");
    try {
      expect(listServiceRenderedFacts(restored)).toEqual(listServiceRenderedFacts(db));
      await runFixtureIssuance(restored, provider, store, native);
      expect(provider.submissions).toHaveLength(1); expect(provider.receipts.size).toBe(1);
      expect(store.get(finalSettlementKey(seat.lineId))).toMatchObject({ state: "ISSUED" });
    } finally { restored.close(); }
  });

  it("hands a line prepaid through REFREF_RC2, or of an unknown contour, to a person instead of closing it natively", async () => {
    const rc2 = await paidSeat(), unknown = await paidSeat();
    recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER);
    const store = new Map<string, { state: JobState; code?: string }>();
    await runFixtureIssuance(db, provider, store, line => line === rc2.lineId ? "REFREF_RC2" : line === unknown.lineId ? null : "NATIVE");
    expect(store.get(finalSettlementKey(rc2.lineId))).toEqual({ state: "HANDOFF", code: "PREPAID_VIA_REFREF_RC2_HUMAN_HANDOFF" });
    expect(store.get(finalSettlementKey(unknown.lineId))).toEqual({ state: "HANDOFF", code: "CONTOUR_UNKNOWN_HUMAN_HANDOFF" });
    expect(provider.submissions).toHaveLength(0);
    expect(closingEligibility(null, "NATIVE", "NONE")).toEqual({ eligible: false, code: "SERVICE_RENDERED_MISSING" });
    expect(closingEligibility(serviceRenderedFact(db, rc2.lineId), "NATIVE", "REQUESTED")).toEqual({ eligible: false, code: "OCCURRENCE_CANCELLED" });
  });
});

describe("SERVICE_RENDERED basis (E position 21.11.2026; owner decision on no-show pending)", () => {
  it("refuses before the end and for a cancelling occurrence", async () => {
    await paidSeat();
    expect(() => recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, "2026-11-01T16:59:59.000Z")).toThrow("LAB_SERVICE_NOT_FINISHED");
    beginLabOccurrenceCancellation(db, { occurrenceRef: REF, actor: "owner", reason: "Отмена" }, "2026-10-30T10:00:00.000Z");
    expect(() => recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER)).toThrow("LAB_OCCURRENCE_CANCELLED");
    expect(count("lab_service_renditions")).toBe(0);
  });
  it("reviews a no-show, an open refund and an unpaid order; attests attendance one line at a time with a closed reason", async () => {
    const checkedIn = await paidSeat(), noShow = await paidSeat(false), attended = await paidSeat(false), refunding = await paidSeat(false);
    requestRefund(db, { customerId: refunding.customerId, orderPublicId: refunding.orderPublicId, idempotencyKey: "r", reasonCode: "CUSTOMER_REQUEST" }, "2026-10-20T10:00:00.000Z");
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('pending','pending@example.test')").run(); confirmLabBuyer(db, "pending");
    await checkout(db, rail, testCheckoutConfig, { customerId: "pending", customerEmail: "pending@example.test", offerRef: REF,
      idempotencyKey: "pay-pending", scenario: "customer_action", labAcceptance: labAcceptanceFor(db) }, BOUGHT);
    const result = recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER);
    expect(result.recorded).toEqual([checkedIn.lineId]);
    expect(result.review).toEqual(expect.arrayContaining([
      { orderPublicId: noShow.orderPublicId, orderLineId: noShow.lineId, code: "NO_SHOW_REVIEW" },
      { orderPublicId: attended.orderPublicId, orderLineId: attended.lineId, code: "NO_SHOW_REVIEW" },
      { orderPublicId: refunding.orderPublicId, orderLineId: refunding.lineId, code: "REFUND_OPEN_OR_DONE" },
      expect.objectContaining({ code: "ORDER_PAYMENT_PENDING" }),
    ]));
    expect(() => attestLabAttendance(db, { orderLineId: attended.lineId, reason: "BECAUSE", recordedBy: "owner" }, AFTER)).toThrow("LAB_ATTESTATION_REASON_INVALID");
    expect(() => attestLabAttendance(db, { orderLineId: checkedIn.lineId, reason: "QR_SCAN_FAILED", recordedBy: "owner" }, AFTER)).toThrow("LAB_SERVICE_RENDERED_ALREADY_RECORDED");
    expect(() => attestLabAttendance(db, { orderLineId: refunding.lineId, reason: "QR_SCAN_FAILED", recordedBy: "owner" }, AFTER)).toThrow("LAB_ATTESTATION_REFUSED_REFUND_OPEN_OR_DONE");
    expect(() => attestLabAttendance(db, { orderLineId: attended.lineId, reason: "QR_SCAN_FAILED", recordedBy: "owner" }, "2026-11-01T16:00:00.000Z"))
      .toThrow("LAB_ATTESTATION_REFUSED_SERVICE_NOT_FINISHED");
    const attestation = attestLabAttendance(db, { orderLineId: attended.lineId, reason: "QR_SCAN_FAILED", recordedBy: "owner" }, AFTER);
    expect(attestation).toMatchObject({ replayed: false, fact: { basis: "ATTENDED_ATTESTED", attestationReason: "QR_SCAN_FAILED", renderedAt: ENDS, recordedBy: "owner" } });
    expect(attestLabAttendance(db, { orderLineId: attended.lineId, reason: "QR_SCAN_FAILED", recordedBy: "owner" }, AFTER)).toMatchObject({ replayed: true });
    expect(() => attestLabAttendance(db, { orderLineId: attended.lineId, reason: "SCANNER_UNAVAILABLE", recordedBy: "owner" }, AFTER)).toThrow("LAB_SERVICE_RENDERED_ALREADY_RECORDED");
    expect(serviceRenderedFact(db, noShow.lineId)).toBeNull();
    expect(() => db.prepare(`INSERT INTO lab_service_renditions(order_line_id,occurrence_ref,basis,attestation_reason,rendered_at,evidence_ref,recorded_by,recorded_at)
      VALUES (?,?, 'ATTENDED_ATTESTED',NULL,?,?,?,?)`).run(noShow.lineId, REF, AFTER, "x", "owner", AFTER)).toThrow();
  });
  it("treats a moved occurrence as not rendered (review), never attestable", async () => {
    const seat = await paidSeat(false);
    // A move outside the workflow (direct DB edit) after the sale.
    db.prepare("UPDATE lab_occurrences SET starts_at='2026-11-01T10:00:00Z' WHERE occurrence_ref=?").run(REF);
    expect(recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER).review)
      .toEqual([{ orderPublicId: seat.orderPublicId, orderLineId: seat.lineId, code: "OCCURRENCE_MOVED_REVIEW" }]);
    expect(() => attestLabAttendance(db, { orderLineId: seat.lineId, reason: "ATTENDANCE_LIST_CONFIRMED", recordedBy: "owner" }, AFTER))
      .toThrow("LAB_ATTESTATION_REFUSED_OCCURRENCE_MOVED_REVIEW");
  });
  it("alerts when an ended occurrence still has paid lines without a fact after 24 hours", async () => {
    const recorded = await paidSeat(true), open = await paidSeat(false);
    expect(labServiceRenderedBacklog(db, "2026-11-01T16:00:00.000Z")).toEqual([]);
    expect(labServiceRenderedBacklog(db, AFTER).map(line => [line.orderLineId, line.code, line.alert]))
      .toEqual(expect.arrayContaining([[recorded.lineId, "CHECKED_IN_NOT_RECORDED", false], [open.lineId, "NO_SHOW_REVIEW", false]]));
    recordCheckedInServiceRendered(db, { occurrenceRef: REF, recordedBy: "owner" }, AFTER);
    expect(labServiceRenderedBacklog(db, "2026-11-02T17:00:00.000Z")).toEqual([expect.objectContaining({ orderLineId: open.lineId, code: "NO_SHOW_REVIEW", alert: true })]);
  });
  it("is an operator command over HTTP: public and service-token callers cannot record, an active Control Room session can", async () => {
    const seat = await paidSeat(), absent = await paidSeat(false);
    const auth = { origin: "http://localhost:3001", sessionSecret: "synthetic-session-secret-long-enough", passwordScrypt: "unused" };
    const app = createCommerceV2App({ db, config: testCheckoutConfig, sourceCommit: "a".repeat(40), serviceToken: "synthetic", paymentRail: rail,
      now: () => new Date(AFTER), controlRoomAuth: auth });
    const path = `/v1/admin/v2/lab/occurrences/${encodeURIComponent(REF)}/service-rendered`;
    for (const headers of [{}, { authorization: "Bearer synthetic" }] as Array<Record<string, string>>) {
      expect((await app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" })).status).toBe(401);
    }
    expect(count("lab_service_renditions")).toBe(0);
    const session = issueControlRoomSession(auth.sessionSecret, "singleton-admin", Date.parse(AFTER));
    db.prepare("INSERT INTO control_room_admin_sessions(id,admin_id,created_at,expires_at) VALUES (?,?,?,?)")
      .run(session.session.sid, session.session.sub, AFTER, new Date(session.session.exp).toISOString());
    const headers = { origin: auth.origin, "Content-Type": "application/json", cookie: controlRoomSessionCookie(session.token, 3600).split(";")[0] };
    expect(await (await app.request(path, { method: "POST", headers, body: "{}" })).json()).toMatchObject({ recorded: [seat.lineId] });
    const attendance = await app.request(`/v1/admin/v2/lab/order-lines/${absent.lineId}/attendance`, { method: "POST", headers,
      body: JSON.stringify({ reason: "SCANNER_UNAVAILABLE" }) });
    expect(attendance.status).toBe(200);
    expect(await (await app.request(`/v1/admin/v2/lab/order-lines/${absent.lineId}/service-rendered`, { headers })).json())
      .toMatchObject({ basis: "ATTENDED_ATTESTED", recordedBy: "singleton-admin" });
    const reconcile = await app.request(`/v1/admin/v2/lab/occurrences/${encodeURIComponent(REF)}/cancellation/reconcile`, { method: "POST", headers });
    expect(reconcile.status).toBe(503); expect(await reconcile.json()).toEqual({ error: { code: "LAB_ROUTE_CONTOUR_UNAVAILABLE" } });
  });
});
