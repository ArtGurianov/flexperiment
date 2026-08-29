import type Database from "better-sqlite3";
import { ReleaseControlError, ReleaseSalesGate, type CertificationOrderContext } from "./release-control";

/**
 * Composition of the two independent authorities that can close new orders.
 *
 * Extracted from CommerceDomain so the release-sensitive surface can be named
 * precisely. domain.ts carries nearly all business logic and changes for
 * ordinary work; if enforcement lived there, a generic deploy would have to
 * treat every ordinary change as release-sensitive, and the controlled cutover
 * path - real money, real pause - would become the only way to ship anything.
 *
 * The two gates are separate state machines and compose only here:
 *
 *   emergency gate  - operator-owned, absolute, checked first
 *   release gate    - deployment-owned, event-sourced
 */

/** Fail closed: a missing row means stopped, never open. */
export const emergencySalesPaused = (db: Database.Database): boolean => {
  const row = db.prepare("SELECT sales_paused FROM emergency_sales_gate WHERE singleton = 1").get() as { sales_paused?: unknown } | undefined;
  return Number(row?.sales_paused ?? 1) === 1;
};

/**
 * The emergency stop is checked first and unconditionally. A certification
 * lease is a machine-issued order from a release owner; it is not permission to
 * walk past an operator who stopped sales. A release needing its certification
 * order must fail and require an explicit reopen.
 */
export const assertNewOrdersOpen = (db: Database.Database, context?: CertificationOrderContext) => {
  if (emergencySalesPaused(db)) throw new ReleaseControlError("SALES_TEMPORARILY_PAUSED", 503);
  return new ReleaseSalesGate(db).assertNewOrdersOpen(context);
};

/**
 * Non-throwing read for public status. Pause, ledger corruption and
 * unavailability are one customer-visible state: the blocking source is never
 * disclosed, and anything other than a clean pass counts as blocked.
 */
export const newOrdersBlocked = (db: Database.Database): boolean => {
  try { assertNewOrdersOpen(db); return false; }
  catch (error) { if (error instanceof ReleaseControlError) return true; throw error; }
};
