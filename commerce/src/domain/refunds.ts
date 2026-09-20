import type Database from "better-sqlite3";
import { id, now } from "../crypto";
import type { PaymentProvider } from "../provider";
import { many, one, type Row, withImmediateTransaction } from "./shared";

interface RefundsHost {
  readonly db: Database.Database;
  readonly provider: PaymentProvider;
  reconcileRefund(refundId: string): Promise<unknown>;
  upsertRefundObligation(paymentId: string, source: string, target: number): Row;
}

export const submitRequestedRefunds = async (host: RefundsHost) => {
  const requests = many(host.db, "SELECT r.*, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.status = 'REQUESTED'");
  for (const refund of requests) {
    const claimed = withImmediateTransaction(host.db, () => host.db.prepare("UPDATE refunds SET status = 'SUBMITTING', submission_started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'REQUESTED'").run(now(), refund.id).changes);
    if (!claimed) continue;
    try {
      if (!refund.provider_payment_id) throw new Error("Provider payment reference is absent.");
      const submitted = await host.provider.refund({ refundId: String(refund.id), providerPaymentId: String(refund.provider_payment_id), amountKopecks: Number(refund.amount_kopecks), idempotencyKey: String(refund.idempotency_key_hash) });
      host.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = ?, last_reconcile_at = ? WHERE id = ? AND status = 'SUBMITTING'").run(submitted.providerReference, now(), refund.id);
    } catch (error) {
      host.db.prepare("UPDATE refunds SET status = 'SUBMIT_UNKNOWN', last_error = ? WHERE id = ? AND status = 'SUBMITTING'").run(error instanceof Error ? error.message : "Refund submission failed", refund.id);
    }
  }
};

/** Retains provider reconciliation as the authority for pending refund rows. */
export const reconcilePendingRefunds = async (host: RefundsHost) => {
  const refunds = many(host.db, "SELECT id FROM refunds WHERE status IN ('RECONCILING', 'SUBMIT_UNKNOWN') ORDER BY created_at LIMIT 50");
  for (const refund of refunds) {
    try { await host.reconcileRefund(String(refund.id)); } catch { /* retain the durable refund command for admin reconciliation */ }
  }
};

export const upsertRefundObligation = (host: RefundsHost, paymentId: string, source: string, target: number) => {
  const existing = one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId);
  if (existing && target > Number(existing.target_refunded_amount_kopecks)) {
    // A fulfilled partial customer-cancellation obligation can later be
    // superseded by a higher organizer/terminal-occurrence target. Reopen
    // only that fulfilled state so the worker can issue the remaining amount.
    host.db.prepare(`UPDATE refund_obligations
      SET target_refunded_amount_kopecks = ?,
        status = CASE WHEN status = 'FULFILLED' THEN 'OPEN' ELSE status END,
        fulfilled_at = CASE WHEN status = 'FULFILLED' THEN NULL ELSE fulfilled_at END
      WHERE id = ?`).run(target, existing.id);
  } else if (!existing) {
    host.db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, ?, ?, 'OPEN')").run(id(), paymentId, source, target);
  }
  const obligation = one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId)!;
  host.db.prepare("INSERT INTO refund_obligation_events(id, obligation_id, source) VALUES (?, ?, ?)").run(id(), obligation.id, source);
  return obligation;
};

export const ensureFullCapturedRefund = (host: RefundsHost, paymentId: string, source: string, capturedTotal: number) => {
  if (capturedTotal <= 0) return null;
  const succeeded = Number(one(host.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", paymentId)?.total ?? 0);
  if (succeeded >= capturedTotal) return one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId) ?? null;
  const existing = one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId);
  if (existing && Number(existing.target_refunded_amount_kopecks) >= capturedTotal) return existing;
  return host.upsertRefundObligation(paymentId, source, capturedTotal);
};
