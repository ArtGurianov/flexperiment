import { evaluateReopenGate, type ReleaseCompletion, type ReleaseControlRequest, type ReleaseControlStatus, type ReleaseRuntimeEvidence } from "./release-control";

export type GenericProductionDeployAction = "RELEASE_ALREADY_COMPLETE" | "ACQUIRE_OWNER" | "PAUSE_SALES" | "DEPLOY" | "VERIFY_AND_REOPEN" | "BLOCKED";
export type GenericProductionDeployReconciliation = { action: GenericProductionDeployAction; reason?: string };

const completionMatchesRequest = (completion: ReleaseCompletion, request: ReleaseControlRequest): boolean =>
  completion.complete
  && completion.reopened_at !== null
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
 * Ordinary deployments must prove the exact frozen legal evidence, rather than
 * relying on the historical legal state used by the one-shot age-band cutover.
 */
export const genericProductionRuntimeReady = (request: ReleaseControlRequest, runtime: ReleaseRuntimeEvidence): boolean =>
  evaluateReopenGate(request, runtime) === undefined;

export const reconcileGenericProductionDeploy = (input: {
  request: ReleaseControlRequest;
  status: ReleaseControlStatus;
  runtime: ReleaseRuntimeEvidence;
  completion: ReleaseCompletion;
}): GenericProductionDeployReconciliation => {
  const { request, status, runtime, completion } = input;
  if (completion.complete) return completionMatchesRequest(completion, request)
    ? { action: "RELEASE_ALREADY_COMPLETE" }
    : { action: "BLOCKED", reason: "RELEASE_COMPLETION_MISMATCH" };
  if (status.owner_release_id && status.owner_release_id !== request.release_id) return { action: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" };
  if (!status.owner_release_id) return status.sales_paused ? { action: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" } : { action: "ACQUIRE_OWNER" };
  if (!status.sales_paused) return { action: "PAUSE_SALES" };
  return genericProductionRuntimeReady(request, runtime) ? { action: "VERIFY_AND_REOPEN" } : { action: "DEPLOY" };
};
