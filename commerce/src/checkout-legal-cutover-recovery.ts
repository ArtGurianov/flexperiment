import type { ReleaseControlStatus } from "./release-control";

export type CheckoutLegalCutoverRecovery =
  | { mode: "CANDIDATE" }
  | { mode: "RESUMING_PROMOTION"; promotionSourceCommit: string }
  | { mode: "BLOCKED"; reason: string };

/**
 * Decides which immutable request owns a checkout/legal cutover rerun.
 * A promotion request replaces the candidate request durably, so it must never
 * be overwritten by replaying candidate acquire/pause calls.
 */
export const checkoutLegalCutoverRecovery = (input: {
  status: ReleaseControlStatus;
  releaseId: string;
  candidateSourceCommit: string;
  candidateLegalVersion: string;
}): CheckoutLegalCutoverRecovery => {
  const { status, releaseId, candidateSourceCommit, candidateLegalVersion } = input;
  if (!status.owner_release_id) return status.sales_paused ? { mode: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" } : { mode: "CANDIDATE" };
  if (status.owner_release_id !== releaseId) return { mode: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" };
  if (!status.sales_paused || !status.expected || status.expected.legal_version !== candidateLegalVersion) return { mode: "BLOCKED", reason: "DURABLE_OWNER_MISMATCH" };
  if (status.expected.source_commit === candidateSourceCommit) return { mode: "CANDIDATE" };
  if (!/^[a-f0-9]{40}$/.test(status.expected.source_commit)) return { mode: "BLOCKED", reason: "DURABLE_PROMOTION_SOURCE_INVALID" };
  return { mode: "RESUMING_PROMOTION", promotionSourceCommit: status.expected.source_commit };
};
