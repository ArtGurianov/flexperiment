import { describe, expect, it } from "vitest";
import { candidateRuntimeReady } from "../src/candidate-runtime-readiness";
import type { ReleaseRuntimeEvidence } from "../src/release-control";

const sourceCommit = "a".repeat(40);
const runtime = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: sourceCommit,
  required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true },
  migration_versions: ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"],
  legal_version: "2026-08-23.2",
  legal_manifest_sha256: null,
  legal_hashes: null,
  legal_publish_time: null,
  current_legal_copies_match: false,
  worker_source_commit: sourceCommit,
  worker_started_at: new Date(Date.now() - 1_000).toISOString(),
  worker_observed_at: new Date().toISOString(),
  worker_last_successful_sweep_at: new Date().toISOString(),
  source_legal_manifest_sha256: null,
  source_legal_publish_time: null,
  ...overrides,
});

describe("candidate runtime readiness", () => {
  it("keeps Phase 0 target 0033 ready without worker liveness or a successful sweep", () => {
    expect(candidateRuntimeReady({
      salesPaused: true,
      sourceCommit,
      expectedMigration: "0033_runtime_release_evidence.sql",
      runtime: runtime({
        required_migrations: { "0031_participant_age_band.sql": false, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": false },
        migration_versions: ["0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"],
        worker_source_commit: null,
        worker_started_at: null,
        worker_observed_at: null,
        worker_last_successful_sweep_at: null,
      }),
    })).toBe(true);
  });

  it("requires worker liveness and successful-sweep evidence for target 0034", () => {
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0034_worker_sweep_evidence.sql", runtime: runtime({ worker_last_successful_sweep_at: null }) })).toBe(false);
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0034_worker_sweep_evidence.sql", runtime: runtime({ worker_observed_at: null }) })).toBe(false);
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0034_worker_sweep_evidence.sql", runtime: runtime() })).toBe(true);
  });

  it("requires the release-specific previous legal version before publication", () => {
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0034_worker_sweep_evidence.sql", previousLegalVersion: "2026-08-25.1", runtime: runtime({ legal_version: "2026-08-25.1" }) })).toBe(true);
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0034_worker_sweep_evidence.sql", previousLegalVersion: "2026-08-25.1", runtime: runtime() })).toBe(false);
  });

  it("fails closed for an unknown or unapplied target migration", () => {
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0099_future.sql", runtime: runtime() })).toBe(false);
    expect(candidateRuntimeReady({ salesPaused: true, sourceCommit, expectedMigration: "0034_worker_sweep_evidence.sql", runtime: runtime({ migration_versions: ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"] }) })).toBe(false);
  });
});
