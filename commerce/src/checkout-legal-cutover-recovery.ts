import type { ReleaseControlStatus } from "./release-control";

export type CheckoutLegalCutoverRecovery =
  | { mode: "CANDIDATE" }
  | { mode: "ADOPTING_PREPUBLICATION_REPAIR"; repairSourceCommit: string }
  | { mode: "RESUMING_PREPUBLICATION_REPAIR"; repairSourceCommit: string }
  | { mode: "REPAIRED_CANDIDATE"; repairSourceCommit: string }
  | { mode: "RESUMING_PROMOTION"; promotionSourceCommit: string }
  | { mode: "BLOCKED"; reason: string };

/**
 * Decides which immutable request owns a checkout/legal cutover rerun.
 * A same-owner pre-publication repair and a promotion both replace the
 * candidate request durably, so neither may be overwritten by replaying
 * candidate acquire/pause calls.
 */
export const checkoutLegalCutoverRecovery = (input: {
  status: ReleaseControlStatus;
  releaseId: string;
  candidateSourceCommit: string;
  candidateLegalVersion: string;
  previousLegalVersion: string;
  activeLegalVersion: string | null;
  repairSourceCommit?: string;
}): CheckoutLegalCutoverRecovery => {
  const {
    status,
    releaseId,
    candidateSourceCommit,
    candidateLegalVersion,
    previousLegalVersion,
    activeLegalVersion,
    repairSourceCommit,
  } = input;
  if (!status.owner_release_id) return status.sales_paused ? { mode: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" } : { mode: "CANDIDATE" };
  if (status.owner_release_id !== releaseId) return { mode: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" };
  if (!status.sales_paused || !status.expected || status.expected.legal_version !== candidateLegalVersion) return { mode: "BLOCKED", reason: "DURABLE_OWNER_MISMATCH" };
  if (![previousLegalVersion, candidateLegalVersion].includes(activeLegalVersion ?? "")) return { mode: "BLOCKED", reason: "UNEXPECTED_LEGAL_PUBLICATION_STATE" };

  const durableSourceCommit = status.expected.source_commit;
  if (!/^[a-f0-9]{40}$/.test(durableSourceCommit)) return { mode: "BLOCKED", reason: "DURABLE_SOURCE_INVALID" };

  if (activeLegalVersion === previousLegalVersion) {
    if (durableSourceCommit === candidateSourceCommit) {
      if (!repairSourceCommit) return { mode: "CANDIDATE" };
      return { mode: "ADOPTING_PREPUBLICATION_REPAIR", repairSourceCommit };
    }
    if (repairSourceCommit && repairSourceCommit !== durableSourceCommit) return { mode: "BLOCKED", reason: "DURABLE_REPAIR_SOURCE_MISMATCH" };
    return { mode: "RESUMING_PREPUBLICATION_REPAIR", repairSourceCommit: durableSourceCommit };
  }

  if (durableSourceCommit === candidateSourceCommit) return { mode: "CANDIDATE" };
  if (repairSourceCommit && durableSourceCommit === repairSourceCommit) return { mode: "REPAIRED_CANDIDATE", repairSourceCommit: durableSourceCommit };
  return { mode: "RESUMING_PROMOTION", promotionSourceCommit: durableSourceCommit };
};
