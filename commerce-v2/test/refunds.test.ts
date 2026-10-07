import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { checkout, MockPaymentRail, reconcileCheckout, type AcceptedRefund, type RailProjection, type RefundSubmission } from "../src/checkout";
import { migrateV2 } from "../src/db";
import type { RefundEnvelope, RefundEnvelopeKeyring } from "../src/refund-envelope";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { activatePublicSales, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";
import { decideRefund, executeApprovedRefund, listRefundCases, reconcilePendingRefunds, recordCourseAccessStart, requestRefund } from "../src/refunds";

const keys: RefundEnvelopeKeyring = { currentKeyId: "k1", keys: { k1: Buffer.alloc(32, 1), k0: Buffer.alloc(32, 2) } };

/** The mock rail, with what Refref answers scripted per test. Every envelope it is sent is kept. */
class ScriptedRail extends MockPaymentRail {
  sent: RefundEnvelope[] = [];
  reads = 0;
  submitAnswers: Array<(envelope: RefundEnvelope) => Promise<RefundSubmission>> = [];
  executionAnswer: ((id: string) => Promise<RefundSubmission>) | null = null;
  refundAnswer: ((id: string) => Promise<AcceptedRefund | null>) | null = null;
  async submitRefund(envelope: RefundEnvelope): Promise<RefundSubmission> {
    this.sent.push(envelope);
    const next = this.submitAnswers.shift();
    return next ? next(envelope) : super.submitRefund(envelope);
  }
  async readRefundExecution(id: string): Promise<RefundSubmission> {
    this.reads += 1;
    return this.executionAnswer ? this.executionAnswer(id) : super.readRefundExecution(id);
  }
  async readRefund(id: string): Promise<AcceptedRefund | null> {
    return this.refundAnswer ? this.refundAnswer(id) : super.readRefund(id);
  }
}

let db: Database.Database;
let rail: ScriptedRail;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new ScriptedRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
    VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
  qualifyTestFiscalPolicies(db);
  activatePublicSales(db);
});

async function paidOrder(scenario?: string) {
  return checkout(db, rail, testCheckoutConfig, {
    customerId: "customer", customerEmail: "student@example.com", offerRef: "course:one",
    idempotencyKey: `checkout-${scenario ?? "success"}`, scenario,
  }, "2026-09-30T10:00:00Z");
}

async function approvedRefund(scenario?: string, amountKopecks = 10_000) {
  const order = await paidOrder(scenario);
  const request = requestRefund(db, {
    customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: `refund-request-${scenario ?? "ok"}`, reasonCode: "CUSTOMER_REQUEST",
  });
  decideRefund(db, request.requestPublicId, {
    outcome: "APPROVE", amountKopecks, policyBasis: "course-offer-v1 § refunds", rationale: "approved", actor: "operator",
  });
  return { order, request };
}

const revoked = () => (db.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM course_entitlements").get() as { revoked: number }).revoked;
const execution = () => db.prepare("SELECT state,provider_execution_id,canonical_refund_id,last_error_code FROM refund_executions").get();

describe("refund authority", () => {
  it("records immutable policy facts but cannot execute without an operator decision", async () => {
    const order = await paidOrder();
    recordCourseAccessStart(db, { customerId: "customer", courseRef: "course-one", lessonRef: "lesson-one" }, "2026-09-30T10:10:00Z");
    const request = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-one", reasonCode: "CUSTOMER_REQUEST",
    }, "2026-09-30T10:15:00Z");
    expect(request.state).toBe("REQUESTED");
    await expect(executeApprovedRefund(db, rail, keys, request.requestPublicId)).rejects.toThrow("REFUND_APPROVAL_REQUIRED");
    expect(listRefundCases(db).refunds[0]?.policyFacts).toMatchObject({ courseAccessStartedAt: "2026-09-30T10:10:00Z", automatedEligibility: "NOT_EVALUATED" });
    expect(revoked()).toBe(0);
  });

  it("approves full refunds only: a partial is refused, as is more than the line", async () => {
    const order = await paidOrder();
    const request = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-partial", reasonCode: "CUSTOMER_REQUEST",
    });
    const decide = (amountKopecks: number) => () => decideRefund(db, request.requestPublicId, {
      outcome: "APPROVE", amountKopecks, policyBasis: "manual exception", rationale: "partial remedy", actor: "operator" });
    expect(decide(4_000)).toThrow("REFUND_FULL_ONLY");
    expect(decide(10_001)).toThrow("REFUND_AMOUNT_INVALID");
    expect(db.prepare("SELECT COUNT(*) AS count FROM refund_decisions").get()).toEqual({ count: 0 });
  });

  it("revokes access only on the accepted Refund it read back, and executes once", async () => {
    const { request } = await approvedRefund();
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "SUCCEEDED" });
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "SUCCEEDED" });
    expect(rail.sent).toHaveLength(1);
    expect(execution()).toMatchObject({ state: "SUCCEEDED", canonical_refund_id: "mock-refund-1" });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "REFUNDED" });
    expect(revoked()).toBe(1);
    // The envelope is sealed: the receipt e-mail it carries is not readable in the row.
    const row = db.prepare("SELECT request_envelope,envelope_key_id FROM refund_executions").get() as { request_envelope: string; envelope_key_id: string };
    expect(row.envelope_key_id).toBe("k1");
    expect(JSON.stringify(row)).not.toContain("student@example.com");
  });

  it("after a lost answer, replays exactly the frozen envelope — never a rebuilt request — and keeps access until the Refund", async () => {
    const { request } = await approvedRefund();
    rail.submitAnswers.push(async () => ({ status: "UNKNOWN" }));
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "PROCESSING", outcomeUnknown: true });
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "PROCESSING" });
    expect(rail.sent).toHaveLength(1);
    expect(revoked()).toBe(0);
    // Meanwhile the customer's e-mail changes: the replay still carries the frozen one.
    db.prepare("UPDATE customers SET email_normalized='changed@example.com' WHERE id='customer'").run();
    expect(await reconcilePendingRefunds(db, rail, keys)).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect(rail.sent).toHaveLength(2);
    expect(rail.sent[1]).toEqual(rail.sent[0]);
    expect(execution()).toMatchObject({ state: "SUCCEEDED" });
    expect(revoked()).toBe(1);
  });

  it("reads a named execution instead of resubmitting it, and finishes only when it names an accepted Refund", async () => {
    const { request } = await approvedRefund();
    rail.submitAnswers.push(async () => ({ status: "SUBMITTED", refundExecutionId: "exec-1", supportReference: "s", canonicalRefundId: null }));
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "PROCESSING", providerExecutionId: "exec-1" });
    let named: string | null = null;
    rail.executionAnswer = async (id) => ({ status: "PROCESSING", refundExecutionId: id, supportReference: "s", canonicalRefundId: named });
    rail.refundAnswer = async (id) => ({ id, paymentId: rail.sent[0]!.paymentId, amountKopecks: 10_000, status: "SUCCEEDED" });
    await reconcilePendingRefunds(db, rail, keys);
    expect([rail.sent.length, rail.reads, revoked()]).toEqual([1, 1, 0]);
    named = "refund-1";
    await reconcilePendingRefunds(db, rail, keys);
    expect([rail.sent.length, rail.reads, revoked()]).toEqual([1, 2, 1]);
    expect(execution()).toMatchObject({ state: "SUCCEEDED", provider_execution_id: "exec-1", canonical_refund_id: "refund-1" });
  });

  it.each([
    ["another payment", { paymentId: "another-payment" }],
    ["another amount", { amountKopecks: 9_999 }],
  ])("an accepted Refund of %s is a person's to look at, never a revocation", async (_what, mismatch) => {
    const { request } = await approvedRefund();
    rail.refundAnswer = async (id) => ({ id, paymentId: rail.sent[0]!.paymentId, amountKopecks: 10_000, status: "SUCCEEDED", ...mismatch });
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "REVIEW_REQUIRED" });
    expect(execution()).toMatchObject({ state: "REVIEW_REQUIRED", canonical_refund_id: null, last_error_code: "REFUND_FACT_MISMATCH" });
    expect(revoked()).toBe(0);
  });

  it("deletes the sealed envelope once the resolution is terminal, keeps it while anything is uncertain, never seals again", async () => {
    const envelopeOf = () => db.prepare(`SELECT request_envelope IS NOT NULL AS sealed, envelope_purged_at IS NOT NULL AS purged,
      idempotency_key AS k, refref_payment_id AS p, amount_kopecks AS a FROM refund_executions`).get() as { sealed: number; purged: number; k: string; p: string; a: number };
    const { request } = await approvedRefund();
    rail.submitAnswers.push(async () => ({ status: "UNKNOWN" }));
    await executeApprovedRefund(db, rail, keys, request.requestPublicId);
    expect(envelopeOf()).toMatchObject({ sealed: 1, purged: 0 });
    // Uncertain: the database will not let it go either.
    expect(() => db.prepare("UPDATE refund_executions SET request_envelope=NULL,envelope_purged_at='t'").run()).toThrow("REFUND_ENVELOPE_FROZEN");
    await reconcilePendingRefunds(db, rail, keys);
    expect(execution()).toMatchObject({ state: "SUCCEEDED" });
    // Terminal: deleted; the non-personal frozen facts remain, and nothing is sealed again.
    expect(envelopeOf()).toMatchObject({ sealed: 0, purged: 1, k: `refund:${request.requestPublicId}:refund`, a: 10_000 });
    expect(() => db.prepare("UPDATE refund_executions SET request_envelope='x'").run()).toThrow("REFUND_ENVELOPE_PURGED");
    expect(() => db.prepare("UPDATE refund_executions SET envelope_purged_at='later'").run()).toThrow("REFUND_ENVELOPE_PURGED");
  });

  it("deletes it after a refusal Refref proved terminal, and keeps it under review that is not one", async () => {
    const { request } = await approvedRefund("refund_failure");
    await executeApprovedRefund(db, rail, keys, request.requestPublicId);
    expect(db.prepare("SELECT request_envelope IS NULL AS gone, envelope_purged_at IS NOT NULL AS purged, last_error_code AS c FROM refund_executions").get())
      .toEqual({ gone: 1, purged: 1, c: "REFUND_DECLINED" });
  });

  it("keeps it after a FAILED answer that is not a proven refusal", async () => {
    const { request } = await approvedRefund();
    rail.submitAnswers.push(async () => ({ status: "FAILED", refundExecutionId: "exec-x", supportReference: "s", canonicalRefundId: null }));
    await executeApprovedRefund(db, rail, keys, request.requestPublicId);
    expect(db.prepare("SELECT request_envelope IS NOT NULL AS sealed, last_error_code AS c FROM refund_executions").get())
      .toEqual({ sealed: 1, c: "REFUND_EXECUTION_FAILED" });
  });

  it("keeps it when the accepted Refund does not match: a person decides, and may still need it", async () => {
    const { request } = await approvedRefund();
    rail.refundAnswer = async (id) => ({ id, paymentId: "another-payment", amountKopecks: 10_000, status: "SUCCEEDED" });
    await executeApprovedRefund(db, rail, keys, request.requestPublicId);
    expect(db.prepare("SELECT request_envelope IS NOT NULL AS sealed, state, last_error_code AS c FROM refund_executions").get())
      .toEqual({ sealed: 1, state: "REVIEW_REQUIRED", c: "REFUND_FACT_MISMATCH" });
    expect(() => db.prepare("UPDATE refund_executions SET request_envelope=NULL,envelope_purged_at='t'").run()).toThrow("REFUND_ENVELOPE_FROZEN");
  });

  it("projects a proven refund failure to review without revoking access", async () => {
    const { request } = await approvedRefund("refund_failure");
    expect(await executeApprovedRefund(db, rail, keys, request.requestPublicId)).toMatchObject({ state: "REVIEW_REQUIRED" });
    expect(execution()).toMatchObject({ state: "REVIEW_REQUIRED", last_error_code: "REFUND_DECLINED" });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "REVIEW_REQUIRED" });
    expect(revoked()).toBe(0);
  });

  it("a rotation keeps the envelope readable; a key gone from the ring sends nothing", async () => {
    const { request } = await approvedRefund();
    rail.submitAnswers.push(async () => ({ status: "UNKNOWN" }));
    await executeApprovedRefund(db, rail, { currentKeyId: "k0", keys: keys.keys }, request.requestPublicId);
    expect(db.prepare("SELECT envelope_key_id FROM refund_executions").get()).toEqual({ envelope_key_id: "k0" });
    rail.submitAnswers.push(async () => ({ status: "UNKNOWN" }));
    await reconcilePendingRefunds(db, rail, keys);
    expect(rail.sent).toHaveLength(2);
    expect(await reconcilePendingRefunds(db, rail, { currentKeyId: "k1", keys: { k1: keys.keys.k1! } })).toEqual({ selected: 1, reconciled: 0, failed: 1 });
    expect(rail.sent).toHaveLength(2);
    expect(execution()).toMatchObject({ state: "PROCESSING", last_error_code: "REFUND_ENVELOPE_KEY_UNAVAILABLE" });
  });

  it("the database keeps the envelope frozen and success bound to an accepted Refund", async () => {
    const { request } = await approvedRefund();
    rail.submitAnswers.push(async () => ({ status: "UNKNOWN" }));
    await executeApprovedRefund(db, rail, keys, request.requestPublicId);
    expect(() => db.prepare("UPDATE refund_executions SET request_envelope='x'").run()).toThrow("REFUND_ENVELOPE_FROZEN");
    expect(() => db.prepare("UPDATE refund_executions SET amount_kopecks=1").run()).toThrow("REFUND_ENVELOPE_FROZEN");
    expect(() => db.prepare("UPDATE refund_executions SET state='SUCCEEDED'").run()).toThrow("REFUND_SUCCESS_REQUIRES_ACCEPTED_REFUND");
    expect(() => db.prepare(`INSERT INTO refund_executions(id,refund_request_id,idempotency_key,state,created_at,updated_at)
      VALUES ('x',(SELECT id FROM refund_requests),'k','PROCESSING','t','t')`).run()).toThrow("REFUND_ENVELOPE_REQUIRED");
  });

  it("an execution from before the envelope goes to a person, and nothing is rebuilt or sent", async () => {
    const { request } = await approvedRefund();
    db.exec("DROP TRIGGER refund_execution_envelope_required");
    db.prepare(`INSERT INTO refund_executions(id,refund_request_id,idempotency_key,state,created_at,updated_at)
      SELECT 'legacy',id,'refund:legacy','PROCESSING','t','t' FROM refund_requests WHERE public_id=?`).run(request.requestPublicId);
    expect(await reconcilePendingRefunds(db, rail, keys)).toEqual({ selected: 1, reconciled: 1, failed: 0 });
    expect([rail.sent.length, revoked()]).toEqual([0, 0]);
    expect(execution()).toMatchObject({ state: "REVIEW_REQUIRED", last_error_code: "REFUND_ENVELOPE_MISSING" });
  });

  it("a payment Refref reports refunded without a refund Flexperiment made keeps access and goes to review", async () => {
    const order = await paidOrder();
    class RefundedElsewhere extends MockPaymentRail {
      async reconcile(input: { attemptId: string }): Promise<RailProjection> {
        return { ...(await rail.reconcile(input as never)), attemptId: input.attemptId, state: "REFUNDED" };
      }
    }
    await reconcileCheckout(db, new RefundedElsewhere(), order.orderPublicId, "2026-09-30T11:00:00Z");
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "REVIEW_REQUIRED" });
    expect(revoked()).toBe(0);
  });
});
