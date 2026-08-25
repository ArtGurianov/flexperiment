import { requiredCutoverMigrations, workerEvidenceIsFresh, workerSweepEvidenceIsFresh, type ReleaseCompletion, type ReleaseControlRequest, type ReleaseControlStatus, type ReleaseRuntimeEvidence } from "./release-control";

export type CutoverAction = "RELEASE_ALREADY_COMPLETE" | "ACQUIRE_OWNER" | "PAUSE_SALES" | "DEPLOY_CANDIDATE" | "PUBLISH_LEGAL" | "CREATE_PROMOTION" | "DEPLOY_PROMOTION" | "VERIFY_AND_REOPEN" | "BLOCKED";

export type CutoverReconciliation = { action: CutoverAction; reason?: string };

const candidateRuntimeReady = (runtime: ReleaseRuntimeEvidence, request: ReleaseControlRequest) =>
  runtime.source_commit === request.expected.source_commit
  && workerEvidenceIsFresh(runtime.worker_source_commit, runtime.worker_observed_at, request.expected.source_commit)
  && workerSweepEvidenceIsFresh(runtime.worker_source_commit, runtime.worker_last_successful_sweep_at, request.expected.source_commit)
  && runtime.migration_applied
  && requiredCutoverMigrations.every((version) => runtime.required_migrations[version] === true);

/**
 * Durable-state reconciliation used by the workflow before it mutates anything.
 * Uncertain states remain paused and are deliberately not converted into a retry.
 */
export const reconcileCutover = (input: { request: ReleaseControlRequest; candidateSourceCommit: string; status: ReleaseControlStatus; runtime: ReleaseRuntimeEvidence; completion: ReleaseCompletion; previousLegalVersion: string }): CutoverReconciliation => {
  const { request, candidateSourceCommit, status, runtime, completion, previousLegalVersion } = input;
  if (completion.complete) return { action: "RELEASE_ALREADY_COMPLETE" };
  if (status.owner_release_id && status.owner_release_id !== request.release_id) return { action: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" };
  if (!status.owner_release_id) return status.sales_paused ? { action: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" } : { action: "ACQUIRE_OWNER" };
  if (!status.sales_paused) return { action: "PAUSE_SALES" };
  if (runtime.legal_version === previousLegalVersion) return candidateRuntimeReady(runtime, request) ? { action: "PUBLISH_LEGAL" } : { action: "DEPLOY_CANDIDATE" };
  if (runtime.legal_version === request.expected.legal_version && runtime.legal_manifest_sha256 === request.expected.legal_manifest_sha256) {
    if (status.expected?.source_commit === candidateSourceCommit && candidateRuntimeReady(runtime, request)) return { action: "CREATE_PROMOTION" };
    return candidateRuntimeReady(runtime, request) ? { action: "VERIFY_AND_REOPEN" } : { action: "DEPLOY_PROMOTION" };
  }
  return { action: "BLOCKED", reason: "LEGAL_RELEASE_RESUME_MISMATCH" };
};
