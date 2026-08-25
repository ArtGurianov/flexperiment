import { requiredMigrationsFor, workerEvidenceIsFresh, workerSweepEvidenceIsFresh, type ReleaseRuntimeEvidence } from "./release-control";

export const candidateRuntimeReady = (input: {
  salesPaused: boolean | undefined;
  runtime: ReleaseRuntimeEvidence | undefined;
  sourceCommit: string;
  expectedMigration: string;
}): boolean => {
  const { runtime, sourceCommit, expectedMigration } = input;
  const requiredMigrations = requiredMigrationsFor(expectedMigration);
  const requiresWorkerSweep = requiredMigrations?.includes("0034_worker_sweep_evidence.sql") === true;
  if (!input.salesPaused || !runtime || !requiredMigrations || runtime.source_commit !== sourceCommit) return false;
  if (!runtime.migration_versions.includes(expectedMigration) || requiredMigrations.some((version) => runtime.required_migrations[version] !== true)) return false;
  if (!requiresWorkerSweep) return runtime.legal_version === "2026-08-23.2";
  return workerEvidenceIsFresh(runtime.worker_source_commit, runtime.worker_observed_at, sourceCommit)
    && workerSweepEvidenceIsFresh(runtime.worker_source_commit, runtime.worker_started_at, runtime.worker_last_successful_sweep_at, sourceCommit)
    && runtime.legal_version === "2026-08-23.2";
};
