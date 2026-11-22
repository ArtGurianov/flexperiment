import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { reconcilePendingFiscalEvents, type ServiceRenditionReader } from "../src/fiscal-port";
import { receiveNativeCallback } from "../src/native-payment-callbacks";
import type { ServiceRenderedFact } from "../src/native-payment-contract";
import {
  contourOfOrder, nativeErasureAdmission, nativeOrderStatus, reconcilePendingNativePayments, startNativePayment, type NativeLedgerContext,
} from "../src/native-payment-ledger";
import { executeApprovedNativeRefund, reconcilePendingNativeRefunds } from "../src/native-payment-refunds";
import { decideRefund, executeApprovedRefundOnContour, requestRefund } from "../src/refunds";
import { FakeFiscalAdapter, FakeNativeBank } from "./fixtures/native-fake-provider";

const T0 = "2026-12-01T10:00:00.000Z";
const LATER = "2026-12-01T10:05:00.000Z";
let dir: string;
let file: string;
let db: Database.Database;
let bank: FakeNativeBank;
let admitted: boolean;
let now: string;
const keyring = { currentKeyId: "k1", keys: { k1: randomBytes(32) } };
const ctx = (mode: "MERCHANT" | "PROVIDER" = "MERCHANT"): NativeLedgerContext =>
  ({ provider: bank, keyring, fiscalizationMode: mode, mayInitiate: () => admitted, now: () => now });

function open() {
  const handle = new Database(file);
  handle.pragma("foreign_keys=ON");
  return handle;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flex-119-native-"));
  file = join(dir, "commerce.sqlite");
  db = open();
  migrateV2(db);
  bank = new FakeNativeBank();
  admitted = true;
  now = T0;
  db.exec(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lr1','COURSES','v1','{}','2026-01-01T00:00:00Z',1);
    INSERT INTO customers(id,email_normalized) VALUES ('c1','buyer@example.test');
    INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p-course','course-a','ONLINE_COURSE','PAID','course-a');
    INSERT INTO cities(id,slug,title) VALUES ('city1','msk','Москва');
    INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
      VALUES ('o1','occ-2026-12-05','city1','Мастер-класс','2026-12-05T15:00:00Z','2026-12-05T18:00:00Z','Europe/Moscow',10,'CONFIRMED','Студия','Москва, ул. Тестовая, 1');
    INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('p-lab','lab-a','LAB','PAID','occ-2026-12-05');`);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function order(publicId: string, kind: "ONLINE_COURSE" | "LAB", amount: number) {
  const snapshot = JSON.stringify({ schema: "flexperiment.test-native-order/1", merchantOrderRef: publicId, paymentPurpose: `Оплата заказа ${publicId}` });
  const paymentMethod = kind === "LAB" ? "FULL_PREPAYMENT" : "FULL_PAYMENT";
  db.prepare(`INSERT INTO orders(id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
    VALUES (?,?,'c1','PAYMENT_PENDING',?,?,?,'lr1',?,?)`).run(`order-${publicId}`, publicId, amount, snapshot,
    createHash("sha256").update(snapshot).digest("hex"), T0, T0);
  db.prepare(`INSERT INTO order_lines(id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref,fiscal_item_json,created_at)
    VALUES (?,?,?,?,?,?,'v1',?,?)`).run(`line-${publicId}`, `order-${publicId}`, kind === "LAB" ? "p-lab" : "p-course",
    kind === "LAB" ? "lab:a" : "course:a", "Позиция", amount, JSON.stringify({ name: "Позиция", quantity: 1, amountKopecks: amount, vatCode: "NONE",
      paymentMethod, paymentObject: "SERVICE" }), T0);
  return publicId;
}

const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const entitlements = () => count("SELECT COUNT(*) n FROM course_entitlements WHERE revoked_at IS NULL");
const paymentState = (publicId: string) => one<{ state: string }>(`SELECT payment.state FROM native_payments payment JOIN orders ON orders.id=payment.order_id
  WHERE orders.public_id=?`, publicId).state;

async function refund(publicId: string) {
  const requested = requestRefund(db, { customerId: "c1", orderPublicId: publicId, idempotencyKey: `rr-${publicId}`, reasonCode: "CUSTOMER_REQUEST" }, LATER);
  const line = one<{ unit_amount_kopecks: number }>("SELECT unit_amount_kopecks FROM order_lines WHERE id=?", `line-${publicId}`);
  decideRefund(db, requested.requestPublicId, { outcome: "APPROVE", amountKopecks: line.unit_amount_kopecks, policyBasis: "full", rationale: "test", actor: "operator" }, LATER);
  return requested.requestPublicId;
}

describe("native payment ledger on the fake bank (FLEX-119)", () => {
  it("course: one create, one debit, one grant and one merchant receipt across repeated sweeps", async () => {
    const id = order("ORD-1", "ONLINE_COURSE", 490000);
    expect((await startNativePayment(db, ctx(), id)).state).toBe("PENDING");
    expect(nativeOrderStatus(db, id)).toMatchObject({ payment: "AWAITING_PAYMENT", paymentUrl: expect.stringContaining("fake-bank") });
    bank.buyerPays(id);
    for (let i = 0; i < 3; i += 1) await reconcilePendingNativePayments(db, ctx());
    expect(paymentState(id)).toBe("PAID");
    expect([bank.calls.create.length, bank.debits, entitlements()]).toEqual([1, 1, 1]);
    expect(count("SELECT COUNT(*) n FROM fiscal_events WHERE kind='PAYMENT_RECEIPT' AND state='SUBMITTING'")).toBe(1);
    // A repeated start never sends again.
    await startNativePayment(db, ctx(), id);
    expect(bank.calls.create.length).toBe(1);
    expect(one<{ request_envelope: string | null }>("SELECT request_envelope FROM native_payments").request_envelope).toBeNull();
    expect(nativeOrderStatus(db, id).payment).toBe("ACCESS_GRANTED");
  });

  it("lost create answer after the bank accepted: read-back finds the payment, no second create", async () => {
    const id = order("ORD-2", "ONLINE_COURSE", 490000);
    bank.faults.create.push("LOSE_AFTER_COMMIT");
    bank.faults.readPayment.push("UNAVAILABLE");
    expect((await startNativePayment(db, ctx(), id)).state).toBe("CREATE_UNKNOWN");
    bank.buyerPays(id);
    await reconcilePendingNativePayments(db, ctx());
    expect([paymentState(id), bank.calls.create.length, bank.debits, entitlements()]).toEqual(["PAID", 1, 1, 1]);
  });

  it("lost create before the bank committed: replay is byte-identical under the same key", async () => {
    const id = order("ORD-3", "ONLINE_COURSE", 490000);
    bank.faults.create.push("LOSE_BEFORE_COMMIT");
    await startNativePayment(db, ctx(), id);
    expect(paymentState(id)).toBe("PENDING");
    expect(bank.calls.create).toHaveLength(2);
    expect(bank.calls.create[1]).toEqual(bank.calls.create[0]);
    expect(bank.calls.create[0]!.idempotencyKey).toBe("native-pay:ORD-3:1");
  });

  it("an unknown create is never replayed while sales are stopped; money already taken is still fulfilled", async () => {
    const id = order("ORD-4", "ONLINE_COURSE", 490000);
    bank.faults.create.push("LOSE_BEFORE_COMMIT");
    bank.faults.readPayment.push("UNAVAILABLE");
    await startNativePayment(db, ctx(), id);
    admitted = false;
    await reconcilePendingNativePayments(db, ctx());
    expect([paymentState(id), bank.calls.create.length]).toEqual(["CREATE_UNKNOWN", 1]);
    admitted = true;
    await reconcilePendingNativePayments(db, ctx());
    bank.buyerPays(id);
    admitted = false;
    await reconcilePendingNativePayments(db, ctx());
    expect([paymentState(id), bank.calls.create.length, entitlements()]).toEqual(["PAID", 2, 1]);
  });

  it("restart from the same SQLite file between commit and send resolves without a second payment", async () => {
    const id = order("ORD-5", "ONLINE_COURSE", 490000);
    // Commit the CREATING row, then "crash" before anything is sent: the process dies inside the call.
    bank.createPayment = async () => { throw new Error("PROCESS_KILLED"); };
    await startNativePayment(db, ctx(), id);
    db.prepare("UPDATE native_payments SET state='CREATING'").run(); // the LOST answer was never recorded
    bank.createPayment = FakeNativeBank.prototype.createPayment.bind(bank);
    expect([paymentState(id), bank.calls.create.length]).toEqual(["CREATING", 0]);
    db.close();
    db = open();
    admitted = true;
    now = LATER;
    await reconcilePendingNativePayments(db, ctx());
    bank.buyerPays(id);
    db.close();
    db = open();
    await reconcilePendingNativePayments(db, ctx());
    expect([paymentState(id), bank.calls.create.length, bank.debits, entitlements()]).toEqual(["PAID", 1, 1, 1]);
  });

  it("forged, duplicate and premature callbacks never grant; a valid one only triggers a read-back", async () => {
    const id = order("ORD-6", "ONLINE_COURSE", 490000);
    await startNativePayment(db, ctx(), id);
    const providerPaymentId = bank.payments.get(id)!.id;
    expect((await receiveNativeCallback(db, ctx(), { "x-fake-signature": "00" }, Buffer.from(JSON.stringify(
      { providerEventId: "e0", subjectKind: "PAYMENT", providerSubjectId: providerPaymentId })))).accepted).toBe(false);
    const premature = bank.signedCallback({ providerEventId: "e1", subjectKind: "PAYMENT", providerSubjectId: providerPaymentId });
    await receiveNativeCallback(db, ctx(), premature.headers, premature.body);
    expect([paymentState(id), entitlements()]).toEqual(["PENDING", 0]);
    bank.buyerPays(id);
    const paid = bank.signedCallback({ providerEventId: "e2", subjectKind: "PAYMENT", providerSubjectId: providerPaymentId });
    await receiveNativeCallback(db, ctx(), paid.headers, paid.body);
    expect((await receiveNativeCallback(db, ctx(), paid.headers, paid.body)).duplicate).toBe(true);
    expect([paymentState(id), entitlements()]).toEqual(["PAID", 1]);
    expect(count("SELECT COUNT(*) n FROM native_callback_inbox")).toBe(3);
  });

  it("a paid fact with another amount goes to review, never access", async () => {
    const id = order("ORD-7", "ONLINE_COURSE", 490000);
    await startNativePayment(db, ctx(), id);
    bank.buyerPays(id);
    bank.payments.get(id)!.amountOverride = 100;
    await reconcilePendingNativePayments(db, ctx());
    expect([paymentState(id), entitlements(), one<{ state: string }>("SELECT state FROM orders WHERE public_id=?", id).state])
      .toEqual(["REVIEW_REQUIRED", 0, "REVIEW_REQUIRED"]);
    expect(nativeOrderStatus(db, id)).toMatchObject({ payment: "SUPPORT_REVIEW", supportReference: "pay:ORD-7" });
  });

  it("LAB: provider EXPIRED releases the seat; a late PAID afterwards goes to review with no ticket", async () => {
    const id = order("LAB-1", "LAB", 350000);
    await startNativePayment(db, ctx(), id);
    bank.expire(id);
    await reconcilePendingNativePayments(db, ctx());
    expect([paymentState(id), one<{ state: string }>("SELECT state FROM orders WHERE public_id=?", id).state]).toEqual(["EXPIRED", "EXPIRED"]);
    bank.latePayment(id);
    // An EXPIRED payment is not swept; the late fact arrives as a callback and is read back.
    const late = bank.signedCallback({ providerEventId: "late", subjectKind: "PAYMENT", providerSubjectId: bank.payments.get(id)!.id });
    await receiveNativeCallback(db, ctx(), late.headers, late.body);
    expect([paymentState(id), count("SELECT COUNT(*) n FROM lab_tickets")]).toEqual(["REVIEW_REQUIRED", 0]);
    expect(count("SELECT COUNT(*) n FROM audit_log WHERE action='NATIVE_PAYMENT_REVIEW_REQUIRED'")).toBe(1);
  });

  it("the database refuses a terminal payment that still carries its sealed request", async () => {
    const id = order("ORD-8", "ONLINE_COURSE", 490000);
    bank.faults.create.push("LOSE_BEFORE_COMMIT");
    bank.faults.readPayment.push("UNAVAILABLE");
    await startNativePayment(db, ctx(), id);
    expect(() => db.prepare("UPDATE native_payments SET state='PAID'").run()).toThrow("NATIVE_PAYMENT_TERMINAL_REQUIRES_PURGE");
  });
});

describe("native refunds on the fake bank (FLEX-119)", () => {
  async function paidCourse(id: string) {
    order(id, "ONLINE_COURSE", 490000);
    await startNativePayment(db, ctx(), id);
    bank.buyerPays(id);
    await reconcilePendingNativePayments(db, ctx());
  }

  it("full refund: one return, access revoked once, refund receipt created, envelope purged", async () => {
    await paidCourse("ORD-R1");
    const request = await refund("ORD-R1");
    expect((await executeApprovedNativeRefund(db, ctx(), request)).state).toBe("PROCESSING");
    expect(entitlements()).toBe(1);
    bank.settleRefund(`refund:${request}`);
    for (let i = 0; i < 2; i += 1) await reconcilePendingNativeRefunds(db, ctx());
    expect([bank.returns, entitlements(), one<{ state: string }>("SELECT state FROM refund_requests").state]).toEqual([1, 0, "REFUNDED"]);
    expect(count("SELECT COUNT(*) n FROM fiscal_events WHERE kind='REFUND_RECEIPT' AND payment_method='FULL_PAYMENT'")).toBe(1);
    expect(one<{ request_envelope: string | null }>("SELECT request_envelope FROM native_refunds").request_envelope).toBeNull();
    expect(nativeOrderStatus(db, "ORD-R1").refund).toBe("REFUNDED");
  });

  it("lost refund answer before commit: same sealed request and key replayed once", async () => {
    await paidCourse("ORD-R2");
    const request = await refund("ORD-R2");
    bank.faults.submitRefund.push("LOSE_BEFORE_COMMIT");
    await executeApprovedNativeRefund(db, ctx(), request);
    expect(bank.calls.submitRefund).toHaveLength(2);
    expect(bank.calls.submitRefund[1]).toEqual(bank.calls.submitRefund[0]);
    bank.settleRefund(`refund:${request}`);
    await reconcilePendingNativeRefunds(db, ctx());
    expect([bank.returns, entitlements()]).toEqual([1, 0]);
  });

  it("a proven refusal keeps access and hands the case to a person", async () => {
    await paidCourse("ORD-R3");
    const request = await refund("ORD-R3");
    bank.refuseNextRefund = { code: "REFUND_DECLINED", proven: true };
    expect((await executeApprovedNativeRefund(db, ctx(), request)).state).toBe("FAILED");
    expect([entitlements(), one<{ state: string }>("SELECT state FROM refund_requests").state,
      one<{ state: string }>("SELECT state FROM orders WHERE public_id='ORD-R3'").state]).toEqual([1, "REVIEW_REQUIRED", "FULFILLED"]);
  });

  it("routes by stored contour: a historical RC.2 order never reaches the native provider", async () => {
    order("RC2-1", "ONLINE_COURSE", 490000);
    db.prepare(`INSERT INTO checkout_attempts(id,order_id,idempotency_key,request_payload_json,state,refref_attempt_id,created_at,updated_at)
      VALUES ('a1','order-RC2-1','k-rc2','{}','PAID','rc2-attempt-historical',?,?)`).run(T0, T0);
    db.prepare("UPDATE orders SET state='FULFILLED' WHERE public_id='RC2-1'").run();
    expect(contourOfOrder(db, "RC2-1")).toBe("REFREF_RC2");
    await expect(startNativePayment(db, ctx(), "RC2-1")).rejects.toThrow("PAYMENT_CONTOUR_AMBIGUOUS");
    const request = await refund("RC2-1");
    const used = await executeApprovedRefundOnContour(db, request, { native: async () => "native", original: async () => "original" });
    expect(used).toBe("original");
    await expect(executeApprovedNativeRefund(db, ctx(), request)).rejects.toThrow("REFUND_ROUTED_TO_ORIGINAL_CONTOUR");
    expect(bank.calls.submitRefund).toHaveLength(0);
  });
});

describe("fiscal port and LAB closing receipt on fakes (FLEX-119 × FLEX-85)", () => {
  const fact = (orderLineId: string): ServiceRenderedFact => ({ schema: "flexperiment.service-rendered/1", orderLineId, occurrenceRef: "occ-2026-12-05",
    renderedAt: "2026-12-05T18:00:00Z", evidenceRef: "lab-lifecycle:attendance-close:occ-2026-12-05", recordedBy: "operator:lab", basis: "CHECKED_IN" });
  let rendered: Set<string>;
  let cancelled: boolean;
  const renditions: ServiceRenditionReader = {
    fact: (_db, lineId) => (rendered.has(lineId) ? fact(lineId) : null),
    occurrenceCancelled: () => cancelled,
  };
  beforeEach(() => { rendered = new Set(); cancelled = false; });

  async function paidLab(id: string) {
    order(id, "LAB", 350000);
    await startNativePayment(db, ctx(), id);
    bank.buyerPays(id);
    await reconcilePendingNativePayments(db, ctx());
  }

  it("LAB paid: one ticket, prepayment receipt, settlement reserved with a sealed contact; payment envelope gone", async () => {
    await paidLab("LAB-2");
    expect(count("SELECT COUNT(*) n FROM lab_tickets")).toBe(1);
    const events = db.prepare("SELECT kind,state,payment_method,sealed_contact IS NOT NULL AS sealed FROM fiscal_events ORDER BY kind").all();
    expect(events).toEqual([
      { kind: "FINAL_SETTLEMENT", state: "AWAITING_SERVICE", payment_method: "FULL_PAYMENT", sealed: 1 },
      { kind: "PAYMENT_RECEIPT", state: "SUBMITTING", payment_method: "FULL_PREPAYMENT", sealed: 1 },
    ]);
    expect(readFileSync(file).includes(Buffer.from("buyer@example.test"))).toBe(true); // customers row only
    expect(count("SELECT COUNT(*) n FROM fiscal_events WHERE sealed_contact LIKE '%buyer@%'")).toBe(0);
    expect(nativeOrderStatus(db, "LAB-2").payment).toBe("TICKET_ISSUED");
  });

  it("closing receipt only after SERVICE_RENDERED, exactly once, with no new payment", async () => {
    await paidLab("LAB-3");
    const adapter = new FakeFiscalAdapter();
    await reconcilePendingFiscalEvents(db, { adapter, keyring, renditions, now: () => now });
    expect(one<{ state: string; last_reason: string }>("SELECT state,last_reason FROM fiscal_events WHERE kind='FINAL_SETTLEMENT'"))
      .toEqual({ state: "AWAITING_SERVICE", last_reason: "SERVICE_RENDERED_FACT_REQUIRED" });
    rendered.add("line-LAB-3");
    adapter.faults.submit.push("LOSE_AFTER_COMMIT");
    for (let i = 0; i < 3; i += 1) await reconcilePendingFiscalEvents(db, { adapter, keyring, renditions, now: () => now });
    const settlement = one<{ state: string; sealed_contact: string | null }>("SELECT state,sealed_contact FROM fiscal_events WHERE kind='FINAL_SETTLEMENT'");
    expect(settlement).toEqual({ state: "REGISTERED", sealed_contact: null });
    const issued = adapter.submitted.filter((event) => event.kind === "FINAL_SETTLEMENT");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ eventRef: "fiscal:FINAL_SETTLEMENT:line-LAB-3", paymentMethod: "FULL_PAYMENT", totalKopecks: 350000,
      prepayment: { executor: "NATIVE", paymentRef: "pay:LAB-3" }, serviceRenderedAt: "2026-12-05T18:00:00Z",
      receiptContact: { kind: "EMAIL", value: "buyer@example.test" } });
    expect([adapter.registeredCount, bank.debits, bank.calls.create.length]).toEqual([2, 1, 1]);
  });

  it("an adapter that cannot settle without payment keeps LAB fail-closed (Точка «Чеки» case)", async () => {
    await paidLab("LAB-4");
    rendered.add("line-LAB-4");
    const adapter = new FakeFiscalAdapter({ finalSettlementWithoutPayment: false, refundReceipt: true });
    await reconcilePendingFiscalEvents(db, { adapter, keyring, renditions, now: () => now });
    expect(one<{ state: string; last_reason: string }>("SELECT state,last_reason FROM fiscal_events WHERE kind='FINAL_SETTLEMENT'"))
      .toEqual({ state: "AWAITING_SERVICE", last_reason: "FISCAL_ADAPTER_CANNOT_SETTLE_WITHOUT_PAYMENT" });
  });

  it("refund before the service cancels the reserved settlement and purges its contact", async () => {
    await paidLab("LAB-5");
    const request = await refund("LAB-5");
    await executeApprovedNativeRefund(db, ctx(), request);
    bank.settleRefund(`refund:${request}`);
    await reconcilePendingNativeRefunds(db, ctx());
    expect(one<{ state: string; sealed_contact: string | null }>("SELECT state,sealed_contact FROM fiscal_events WHERE kind='FINAL_SETTLEMENT'"))
      .toEqual({ state: "CANCELLED", sealed_contact: null });
    expect(one<{ state: string }>("SELECT state FROM orders WHERE public_id='LAB-5'").state).toBe("REFUNDED");
  });

  it("an occurrence cancelled before the service cancels the reserved settlement", async () => {
    await paidLab("LAB-6");
    cancelled = true;
    await reconcilePendingFiscalEvents(db, { adapter: new FakeFiscalAdapter(), keyring, renditions, now: () => now });
    expect(one<{ state: string }>("SELECT state FROM fiscal_events WHERE kind='FINAL_SETTLEMENT'").state).toBe("CANCELLED");
  });

  it("no SERVICE_RENDERED by ends_at + 30 days: review, never a silent purge", async () => {
    await paidLab("LAB-7");
    now = "2027-01-10T00:00:00.000Z";
    await reconcilePendingFiscalEvents(db, { adapter: new FakeFiscalAdapter(), keyring, renditions, now: () => now });
    expect(one<{ state: string; sealed: number }>("SELECT state,sealed_contact IS NOT NULL AS sealed FROM fiscal_events WHERE kind='FINAL_SETTLEMENT'"))
      .toEqual({ state: "REVIEW_REQUIRED", sealed: 1 });
  });

  it("erasure is blocked while any payment, refund or fiscal event of the subject is unfinished", async () => {
    await paidLab("LAB-8");
    expect(nativeErasureAdmission(db, "c1")).toMatchObject({ admitted: false, code: "ERASURE_FINANCIAL_REVIEW_REQUIRED" });
    rendered.add("line-LAB-8");
    const adapter = new FakeFiscalAdapter();
    // The settlement waits for the prepayment receipt's REGISTERED, which may land in the same or the next sweep.
    for (let i = 0; i < 2; i += 1) await reconcilePendingFiscalEvents(db, { adapter, keyring, renditions, now: () => now });
    expect(nativeErasureAdmission(db, "c1")).toEqual({ admitted: true, effects: ["PURGE_SEALED_ENVELOPES"] });
  });
});

describe("the direct contour works without Refref (FLEX-119)", () => {
  it("imports no Refref module and makes no network call of its own", async () => {
    for (const source of ["native-payment-contract", "native-payment-ledger", "native-payment-refunds", "native-payment-callbacks", "native-payment-provider", "fiscal-port"]) {
      const text = readFileSync(join(__dirname, "..", "src", `${source}.ts`), "utf8");
      expect(text, source).not.toMatch(/from "\.\/(refref|checkout|vnext)/);
    }
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("REFREF_UNREACHABLE"); }) as typeof fetch;
    try {
      const id = order("ORD-NR", "ONLINE_COURSE", 490000);
      await startNativePayment(db, ctx(), id);
      bank.buyerPays(id);
      await reconcilePendingNativePayments(db, ctx());
      const request = await refund(id);
      await executeApprovedNativeRefund(db, ctx(), request);
      bank.settleRefund(`refund:${request}`);
      await reconcilePendingNativeRefunds(db, ctx());
      await reconcilePendingFiscalEvents(db, { adapter: new FakeFiscalAdapter(), keyring, now: () => now });
      expect([paymentState(id), bank.debits, bank.returns, entitlements()]).toEqual(["PAID", 1, 1, 0]);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
});
