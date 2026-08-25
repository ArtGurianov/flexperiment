import { readFileSync } from "node:fs";
import { requiredCutoverMigrations, workerEvidenceIsFresh, workerSweepEvidenceIsFresh, type ReleaseRuntimeEvidence } from "./release-control";

const [statusPath, sourceCommit] = process.argv.slice(2);
if (!statusPath || !sourceCommit) throw new Error("Pass the release-control status JSON path and expected source commit.");
const payload = JSON.parse(readFileSync(statusPath, "utf8")) as { sales_paused?: boolean; runtime?: ReleaseRuntimeEvidence };
const runtime = payload.runtime;
const ready = payload.sales_paused === true
  && runtime?.source_commit === sourceCommit
  && workerEvidenceIsFresh(runtime.worker_source_commit, runtime.worker_observed_at, sourceCommit)
  && workerSweepEvidenceIsFresh(runtime.worker_source_commit, runtime.worker_last_successful_sweep_at, sourceCommit)
  && runtime.migration_applied === true
  && requiredCutoverMigrations.every((version) => runtime.required_migrations[version] === true)
  && runtime.legal_version === "2026-08-23.2";
if (!ready) process.exitCode = 1;
