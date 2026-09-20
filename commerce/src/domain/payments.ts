import { many } from "../domain";

type PaymentsHost = any;

/** Retains provider reconciliation as the authority for pending payment rows. */
export const reconcilePendingPayments = async (host: PaymentsHost) => {
  const payments = many(host.db, "SELECT id FROM payments WHERE provider_payment_id IS NOT NULL AND status = 'PENDING' AND state = 'CREATED' ORDER BY created_at LIMIT 50");
  for (const payment of payments) {
    try { await host.reconcilePayment(String(payment.id)); } catch { /* retain reservation until authoritative evidence arrives */ }
  }
};
