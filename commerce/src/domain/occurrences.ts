import { DomainError, one } from "../domain";

type OccurrencesHost = any;

export const cancellationFinancialOverview = (host: OccurrencesHost, occurrenceId: string) => {
  const occurrence = one(host.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", occurrenceId);
  if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
  if (occurrence.fulfillment_status !== "CANCELLED") throw new DomainError("OCCURRENCE_NOT_CANCELLED", 409);
  return one(host.db, `WITH payment_totals AS (
    SELECT p.id, p.captured_amount_kopecks AS captured,
      COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS refund_succeeded,
      COALESCE((SELECT COUNT(*) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'REVIEW_REQUIRED'), 0) AS refund_review_count,
      CASE WHEN ro.status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END AS obligation_review
    FROM payments p JOIN orders o ON o.id = p.order_id
    LEFT JOIN refund_obligations ro ON ro.payment_id = p.id
    WHERE o.occurrence_id = ? AND p.captured_amount_kopecks > 0
  ) SELECT
    COUNT(*) AS paid_orders,
    COALESCE(SUM(captured), 0) AS captured_kopecks,
    COALESCE(SUM(captured), 0) AS refund_target_kopecks,
    COALESCE(SUM(refund_succeeded), 0) AS refund_succeeded_kopecks,
    COALESCE(SUM(CASE WHEN captured > refund_succeeded THEN captured - refund_succeeded ELSE 0 END), 0) AS refund_outstanding_kopecks,
    COALESCE(SUM(CASE WHEN refund_review_count > 0 OR obligation_review = 1 THEN CASE WHEN captured > refund_succeeded THEN captured - refund_succeeded ELSE 0 END ELSE 0 END), 0) AS refund_needs_attention_kopecks,
    COALESCE(SUM(CASE WHEN refund_review_count > 0 OR obligation_review = 1 THEN 1 ELSE 0 END), 0) AS refund_needs_attention_count
    FROM payment_totals`, occurrenceId)!;
};
