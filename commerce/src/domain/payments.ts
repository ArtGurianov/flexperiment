import type Database from "better-sqlite3";
import { now } from "../crypto";
import type { PaymentProvider } from "../provider";
import { DomainError, many, one, withImmediateTransaction } from "./shared";

interface PaymentsHost {
  readonly db: Database.Database;
  readonly provider: PaymentProvider;
  markPaymentPaid(paymentId: string, capturedAmount: number, providerPaymentId?: string): Record<string, unknown>;
  reconcilePayment(paymentId: string): Promise<unknown>;
}

/** Retains provider reconciliation as the authority for pending payment rows. */
export const reconcilePendingPayments = async (host: PaymentsHost) => {
  const payments = many(host.db, "SELECT id FROM payments WHERE provider_payment_id IS NOT NULL AND status = 'PENDING' AND state = 'CREATED' ORDER BY created_at LIMIT 50");
  for (const payment of payments) {
    try { await host.reconcilePayment(String(payment.id)); } catch { /* retain reservation until authoritative evidence arrives */ }
  }
};

export const reconcilePayment = async (host: PaymentsHost, paymentId: string) => {
  const payment = one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId);
  if (!payment) throw new DomainError("PAYMENT_NOT_FOUND", 404);
  if (!payment.provider_payment_id) throw new DomainError("PROVIDER_REFERENCE_REQUIRED", 422);
  const observed = await host.provider.reconcilePayment({ providerPaymentId: String(payment.provider_payment_id) });
  host.db.prepare("UPDATE payments SET last_reconcile_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), paymentId);
  if (observed.status === "PAID" && observed.capturedAmountKopecks !== undefined) return host.markPaymentPaid(paymentId, observed.capturedAmountKopecks, String(payment.provider_payment_id));
  if (observed.status === "FAILED") {
    return withImmediateTransaction(host.db, () => {
      host.db.prepare("UPDATE payments SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now(), paymentId);
      host.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'PAYMENT_PROVIDER_FAILED' WHERE order_id = ? AND status = 'RESERVED'").run(now(), payment.order_id);
      return one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
    });
  }
  // Pending or unknown provider evidence is not a failure proof; retain the
  // reservation and let a later reconciliation establish a terminal outcome.
  host.db.prepare("UPDATE payments SET updated_at = ? WHERE id = ?").run(now(), paymentId);
  return one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
};
