import { evaluateReopenGate, type ReleaseCompletion, type ReleaseControlRequest, type ReleaseControlStatus, type ReleaseRuntimeEvidence } from "./release-control";

/**
 * Epoch A has one reviewed, deployable product artifact. Controller commits
 * live on main and are deliberately not ancestors of this direct child.
 */
export const EPOCH_A_RUNTIME_SHA = "80e152259628719af20d363a76ed6b991d67482a";
export const EPOCH_A_PRODUCTION_BASE_SHA = "0ddc33d0fd0077fe0ba238ec75ae4090fc38ac34";
export const EPOCH_A_RELEASE_ID = `epoch-a-dormant-notifications:${EPOCH_A_RUNTIME_SHA}`;
export const EPOCH_A_PRE_B_LEGAL_VERSION = "2026-08-26.1";
export const EPOCH_A_NOTIFICATION_LEGAL_VERSION = "2026-08-28.1";
export const EPOCH_A_REQUIRED_MIGRATION = "0038_occurrence_availability_notifications.sql";

export type EpochAAction = "RELEASE_ALREADY_COMPLETE" | "ACQUIRE_AND_PAUSE" | "DEPLOY_OR_CONVERGE" | "READY_TO_COMPLETE" | "BLOCKED";
export type EpochAReconciliation = { action: EpochAAction; reason?: string };

const completionMatches = (completion: ReleaseCompletion, request: ReleaseControlRequest): boolean =>
  completion.complete
  && completion.expected !== null
  && completion.expected.source_commit === request.expected.source_commit
  && completion.expected.migration === request.expected.migration
  && completion.expected.legal_version === request.expected.legal_version
  && completion.expected.legal_manifest_sha256 === request.expected.legal_manifest_sha256
  && completion.expected.legal_hashes.PUBLIC_OFFER === request.expected.legal_hashes.PUBLIC_OFFER
  && completion.expected.legal_hashes.PRIVACY_POLICY === request.expected.legal_hashes.PRIVACY_POLICY
  && completion.expected.legal_hashes.PD_CONSENT === request.expected.legal_hashes.PD_CONSENT
  && completion.expected.legal_hashes.CHECKOUT_DISCLOSURE === request.expected.legal_hashes.CHECKOUT_DISCLOSURE;

/**
 * Compatibility is not inferred from convergence. Epoch A first proves the
 * pre-B durable legal state, then proves the deployed R interpreter still
 * reports the notification capability as unavailable.
 */
export const epochADormantLegalEvidence = (input: {
  runtime: ReleaseRuntimeEvidence;
  publicLegalVersion: string | null;
  occurrenceNotificationsAvailable: boolean | null;
}): string | undefined => {
  if (input.runtime.legal_version === EPOCH_A_NOTIFICATION_LEGAL_VERSION || input.publicLegalVersion === EPOCH_A_NOTIFICATION_LEGAL_VERSION) return "EPOCH_A_FUTURE_LEGAL_RELEASE_ACTIVE";
  if (input.runtime.legal_version !== EPOCH_A_PRE_B_LEGAL_VERSION) return "EPOCH_A_PRE_B_LEGAL_VERSION_MISMATCH";
  if (input.publicLegalVersion !== EPOCH_A_PRE_B_LEGAL_VERSION) return "EPOCH_A_PUBLIC_LEGAL_VERSION_MISMATCH";
  if (input.occurrenceNotificationsAvailable !== false) return "EPOCH_A_NOTIFICATION_CAPABILITY_NOT_DORMANT";
  if (!input.runtime.current_legal_copies_match) return "EPOCH_A_CURRENT_LEGAL_COPIES_MISMATCH";
  return undefined;
};

export const epochARuntimeReady = (request: ReleaseControlRequest, runtime: ReleaseRuntimeEvidence, legal: { version: string | null; occurrenceNotificationsAvailable: boolean | null }): string | undefined =>
  evaluateReopenGate(request, runtime) ?? epochADormantLegalEvidence({
    runtime,
    publicLegalVersion: legal.version,
    occurrenceNotificationsAvailable: legal.occurrenceNotificationsAvailable,
  });

/**
 * A workflow run is only a transport attempt. This classifier accepts fresh
 * durable state and never promotes a run log into release authority.
 */
export const reconcileEpochA = (input: {
  stage: "prepare" | "complete";
  request: ReleaseControlRequest;
  status: ReleaseControlStatus;
  runtime: ReleaseRuntimeEvidence;
  completion: ReleaseCompletion;
  legal: { version: string | null; occurrenceNotificationsAvailable: boolean | null };
}): EpochAReconciliation => {
  const { stage, request, status, runtime, completion, legal } = input;
  if (completion.complete) return completionMatches(completion, request)
    ? { action: "RELEASE_ALREADY_COMPLETE" }
    : { action: "BLOCKED", reason: "EPOCH_A_COMPLETION_MISMATCH" };
  if (status.owner_release_id && status.owner_release_id !== request.release_id) return { action: "BLOCKED", reason: "EPOCH_A_FOREIGN_RELEASE_OWNER" };
  if (!status.owner_release_id) return status.sales_paused
    ? { action: "BLOCKED", reason: "EPOCH_A_PAUSED_WITHOUT_OWNER" }
    : stage === "prepare"
      ? { action: "ACQUIRE_AND_PAUSE" }
      : { action: "BLOCKED", reason: "EPOCH_A_COMPLETE_REQUIRES_PAUSED_OWNER" };
  if (!status.sales_paused || status.owner_mode !== request.mode) return { action: "BLOCKED", reason: "EPOCH_A_OWNER_PROJECTION_MISMATCH" };
  const readiness = epochARuntimeReady(request, runtime, legal);
  if (stage === "complete") return readiness ? { action: "BLOCKED", reason: readiness } : { action: "READY_TO_COMPLETE" };
  return readiness ? { action: "DEPLOY_OR_CONVERGE", reason: readiness } : { action: "READY_TO_COMPLETE" };
};
