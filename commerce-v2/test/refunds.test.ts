import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { checkout, MockPaymentRail, type PaymentRail } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { decideRefund, executeApprovedRefund, listRefundCases, recordCourseAccessStart, requestRefund } from "../src/refunds";

let db: Database.Database;
let rail: MockPaymentRail;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  rail = new MockPaymentRail();
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
    VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
});

async function paidOrder(scenario?: string) {
  return checkout(db, rail, {
    customerId: "customer", customerEmail: "student@example.com", offerRef: "course:one",
    idempotencyKey: `checkout-${scenario ?? "success"}`, scenario,
  }, "2026-09-30T10:00:00Z");
}

describe("refund authority", () => {
  it("records immutable policy facts but cannot execute without an operator decision", async () => {
    const order = await paidOrder();
    recordCourseAccessStart(db, { customerId: "customer", courseRef: "course-one", lessonRef: "lesson-one" }, "2026-09-30T10:10:00Z");
    const request = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-one",
      reasonCode: "CUSTOMER_REQUEST",
    }, "2026-09-30T10:15:00Z");
    expect(request.state).toBe("REQUESTED");
    await expect(executeApprovedRefund(db, rail, request.requestPublicId)).rejects.toThrow("REFUND_APPROVAL_REQUIRED");
    const cases = listRefundCases(db);
    expect(cases.refunds[0]?.policyFacts).toMatchObject({ courseAccessStartedAt: "2026-09-30T10:10:00Z", automatedEligibility: "NOT_EVALUATED" });
    expect(db.prepare("SELECT revoked_at FROM course_entitlements").get()).toEqual({ revoked_at: null });
  });

  it("executes an approved full refund once and revokes only its line grant", async () => {
    const order = await paidOrder();
    const request = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-two", reasonCode: "CUSTOMER_REQUEST",
    });
    decideRefund(db, request.requestPublicId, {
      outcome: "APPROVE", amountKopecks: 10000, policyBasis: "course-offer-v1 § refunds", rationale: "approved by operator", actor: "operator@example.com",
    });
    expect(await executeApprovedRefund(db, rail, request.requestPublicId)).toMatchObject({ state: "SUCCEEDED" });
    expect(await executeApprovedRefund(db, rail, request.requestPublicId)).toMatchObject({ state: "SUCCEEDED" });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "REFUNDED" });
    expect(db.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM course_entitlements").get()).toEqual({ revoked: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM refund_executions").get()).toEqual({ count: 1 });
  });

  it("keeps access after a partial refund and rejects an amount above the line remainder", async () => {
    const order = await paidOrder();
    const first = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-partial", reasonCode: "CUSTOMER_REQUEST",
    });
    decideRefund(db, first.requestPublicId, {
      outcome: "APPROVE", amountKopecks: 4000, policyBasis: "manual exception", rationale: "partial remedy", actor: "operator",
    });
    await executeApprovedRefund(db, rail, first.requestPublicId);
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "FULFILLED" });
    expect(db.prepare("SELECT revoked_at FROM course_entitlements").get()).toEqual({ revoked_at: null });

    const second = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-too-large", reasonCode: "OTHER",
    });
    expect(() => decideRefund(db, second.requestPublicId, {
      outcome: "APPROVE", amountKopecks: 6001, policyBasis: "manual exception", rationale: "bad arithmetic", actor: "operator",
    })).toThrow("REFUND_AMOUNT_INVALID");
  });

  it("persists an ambiguous execution without submitting it a second time", async () => {
    const order = await paidOrder();
    const request = requestRefund(db, {
      customerId: "customer", orderPublicId: order.orderPublicId, idempotencyKey: "refund-request-unknown", reasonCode: "CUSTOMER_REQUEST",
    });
    decideRefund(db, request.requestPublicId, {
      outcome: "APPROVE", amountKopecks: 10000, policyBasis: "manual decision", rationale: "approved", actor: "operator",
    });
    let calls = 0;
    const uncertainRail = {
      ...rail,
      refund: async () => { calls += 1; throw new TypeError("network timeout"); },
    } as unknown as PaymentRail;
    expect(await executeApprovedRefund(db, uncertainRail, request.requestPublicId)).toMatchObject({ state: "PROCESSING", outcomeUnknown: true });
    expect(await executeApprovedRefund(db, uncertainRail, request.requestPublicId)).toMatchObject({ state: "PROCESSING" });
    expect(calls).toBe(1);
    expect(db.prepare("SELECT state,last_error_code FROM refund_executions").get()).toEqual({ state: "PROCESSING", last_error_code: "network timeout" });
  });
});
