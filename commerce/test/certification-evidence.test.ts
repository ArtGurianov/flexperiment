import { describe, expect, it } from "vitest";
import { evaluateCertificationEvidence } from "../src/certification-evidence";

const exactEvidence = {
  occurrence_id: "occurrence-1", expected_occurrence_id: "occurrence-1",
  promo_id_snapshot: "promo-1", expected_promo_id: "promo-1",
  order_id: "order-1", expected_order_id: "order-1",
  payment_id: "payment-1", refund_id: "refund-1",
  price_kopecks_snapshot: 101, discount_kopecks_snapshot: 1, amount_kopecks: 100,
  payment_status: "REFUNDED", captured_amount_kopecks: 100, refunded_amount_kopecks: 100,
};

describe("certification evidence", () => {
  it("accepts only the fixed 101-to-100 fixture with exact persisted IDs", () => {
    expect(evaluateCertificationEvidence(exactEvidence)).toEqual({ certified: true, evidence: { occurrence_id: "occurrence-1", promo_id: "promo-1", order_id: "order-1", payment_id: "payment-1", refund_id: "refund-1", price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } });
    expect(evaluateCertificationEvidence({ ...exactEvidence, price_kopecks_snapshot: 1000, discount_kopecks_snapshot: 100, amount_kopecks: 900, captured_amount_kopecks: 900, refunded_amount_kopecks: 900 }).certified).toBe(false);
    expect(evaluateCertificationEvidence({ ...exactEvidence, occurrence_id: "other-occurrence" })).toMatchObject({ reason: "CERTIFICATION_SCOPE_MISMATCH" });
    expect(evaluateCertificationEvidence({ ...exactEvidence, promo_id_snapshot: "other-promo" })).toMatchObject({ reason: "CERTIFICATION_SCOPE_MISMATCH" });
    expect(evaluateCertificationEvidence({ ...exactEvidence, refund_id: null })).toMatchObject({ reason: "CERTIFICATION_PAYMENT_REFUND_MISSING" });
  });
});
