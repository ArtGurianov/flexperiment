import { many } from "../domain";

type RefundsHost = any;

/** Retains provider reconciliation as the authority for pending refund rows. */
export const reconcilePendingRefunds = async (host: RefundsHost) => {
  const refunds = many(host.db, "SELECT id FROM refunds WHERE status IN ('RECONCILING', 'SUBMIT_UNKNOWN') ORDER BY created_at LIMIT 50");
  for (const refund of refunds) {
    try { await host.reconcileRefund(String(refund.id)); } catch { /* retain the durable refund command for admin reconciliation */ }
  }
};
