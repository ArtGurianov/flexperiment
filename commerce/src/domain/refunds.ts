import type Database from "better-sqlite3";
import { many } from "./shared";

interface RefundsHost {
  readonly db: Database.Database;
  reconcileRefund(refundId: string): Promise<unknown>;
}

/** Retains provider reconciliation as the authority for pending refund rows. */
export const reconcilePendingRefunds = async (host: RefundsHost) => {
  const refunds = many(host.db, "SELECT id FROM refunds WHERE status IN ('RECONCILING', 'SUBMIT_UNKNOWN') ORDER BY created_at LIMIT 50");
  for (const refund of refunds) {
    try { await host.reconcileRefund(String(refund.id)); } catch { /* retain the durable refund command for admin reconciliation */ }
  }
};
