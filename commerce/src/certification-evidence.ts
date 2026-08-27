export type CertificationFinancialEvidence = {
  occurrence_id: string;
  expected_occurrence_id: string;
  promo_id_snapshot: string | null;
  expected_promo_id: string;
  order_id: string;
  expected_order_id: string | null;
  payment_id: string;
  refund_id: string | null;
  price_kopecks_snapshot: unknown;
  discount_kopecks_snapshot: unknown;
  amount_kopecks: unknown;
  payment_status: unknown;
  captured_amount_kopecks: unknown;
  refunded_amount_kopecks: unknown;
};

export type CertificationEvidenceResult =
  | { certified: true; evidence: CertificationEvidenceBundle }
  | { certified: false; reason: string };

export type CertificationEvidenceBundle = {
  occurrence_id: string;
  promo_id: string;
  order_id: string;
  payment_id: string;
  refund_id: string;
  price_kopecks: 101;
  discount_kopecks: 1;
  amount_kopecks: 100;
  captured_kopecks: 100;
  refunded_kopecks: 100;
};

const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

/** Pure classification only: it never performs payment or refund side effects. */
export const evaluateCertificationEvidence = (evidence: CertificationFinancialEvidence): CertificationEvidenceResult => {
  if (!evidence.expected_order_id || evidence.order_id !== evidence.expected_order_id) return { certified: false, reason: "CERTIFICATION_ORDER_MISMATCH" };
  if (evidence.occurrence_id !== evidence.expected_occurrence_id || evidence.promo_id_snapshot !== evidence.expected_promo_id) return { certified: false, reason: "CERTIFICATION_SCOPE_MISMATCH" };
  if (!evidence.payment_id || !evidence.refund_id) return { certified: false, reason: "CERTIFICATION_PAYMENT_REFUND_MISSING" };
  const price = integer(evidence.price_kopecks_snapshot);
  const discount = integer(evidence.discount_kopecks_snapshot);
  const amount = integer(evidence.amount_kopecks);
  const captured = integer(evidence.captured_amount_kopecks);
  const refunded = integer(evidence.refunded_amount_kopecks);
  if (price === undefined || discount === undefined || amount === undefined || captured === undefined || refunded === undefined) return { certified: false, reason: "CERTIFICATION_AMOUNT_EVIDENCE_INVALID" };
  if (price !== 101 || discount !== 1 || amount !== 100) return { certified: false, reason: "CERTIFICATION_FIXTURE_EVIDENCE_MISMATCH" };
  if (evidence.payment_status !== "REFUNDED" || captured !== 100 || refunded !== 100) return { certified: false, reason: "CERTIFICATION_CAPTURE_REFUND_INCOMPLETE" };
  return { certified: true, evidence: { occurrence_id: evidence.occurrence_id, promo_id: evidence.expected_promo_id, order_id: evidence.order_id, payment_id: evidence.payment_id, refund_id: evidence.refund_id, price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } };
};
