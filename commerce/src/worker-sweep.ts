import { CommerceDomain, DomainError } from "./domain";

type SweepDomain = Pick<CommerceDomain,
  "recoverStaleCommands" | "detectStalePreparedSettlements" | "reconcileCreateUnknownPayments" | "reconcilePendingPayments" |
  "createObligationRefunds" | "submitRequestedRefunds" | "reconcilePendingRefunds" | "processEmailOutbox" |
  "reconcileUnisenderEventDumps" | "processCityInterestLifecycle" | "detectOverdueVenueAnnouncements">;

/**
 * Runs the financial recovery sequence. A stale PREPARED review is useful
 * operational evidence, but a competing SQLite writer must not defer payment,
 * refund, or email recovery in the same sweep.
 */
export async function runWorkerSweep(domain: SweepDomain) {
  domain.recoverStaleCommands();
  try { domain.detectStalePreparedSettlements(); }
  catch (error) {
    if (!(error instanceof DomainError) || error.code !== "SETTLEMENT_BUSY") throw error;
  }
  await domain.reconcileCreateUnknownPayments();
  await domain.reconcilePendingPayments();
  domain.createObligationRefunds();
  await domain.submitRequestedRefunds();
  await domain.reconcilePendingRefunds();
  await domain.processEmailOutbox();
  await domain.reconcileUnisenderEventDumps();
  domain.detectOverdueVenueAnnouncements();
  return domain.processCityInterestLifecycle();
}
