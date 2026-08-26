import { describe, expect, it } from "vitest";
import { genericProductionRuntimeReady, reconcileGenericProductionDeploy } from "../src/generic-production-deploy";
import { migrationInventoryExpectation, type ReleaseCompletion, type ReleaseControlRequest, type ReleaseControlStatus, type ReleaseRuntimeEvidence } from "../src/release-control";

const sourceCommit = "a".repeat(40);
const migrationVersions = ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"];
const request: ReleaseControlRequest = {
  release_id: `deploy-${sourceCommit}`,
  mode: "ROLLING",
  expected: {
    source_commit: sourceCommit,
    migration: migrationInventoryExpectation(migrationVersions),
    legal_version: "2026-08-25.1",
    legal_manifest_sha256: "b".repeat(64),
    legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
  },
};
const status = (overrides: Partial<ReleaseControlStatus> = {}): ReleaseControlStatus => ({ sales_paused: false, owner_release_id: null, owner_mode: null, expected: null, acquired_at: null, paused_at: null, reopened_at: null, ...overrides });
const runtime = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: sourceCommit,
  required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true },
  migration_versions: migrationVersions,
  legal_version: request.expected.legal_version,
  legal_manifest_sha256: request.expected.legal_manifest_sha256,
  legal_hashes: request.expected.legal_hashes,
  legal_publish_time: new Date().toISOString(),
  current_legal_copies_match: true,
  worker_source_commit: sourceCommit,
  worker_started_at: new Date(Date.now() - 1_000).toISOString(),
  worker_observed_at: new Date().toISOString(),
  worker_last_successful_sweep_at: new Date().toISOString(),
  source_legal_manifest_sha256: "0".repeat(64),
  source_legal_publish_time: new Date().toISOString(),
  ...overrides,
});
const completion = (overrides: Partial<ReleaseCompletion> = {}): ReleaseCompletion => ({ complete: false, expected: null, reopened_at: null, ...overrides });
const reconcile = (state: Partial<ReleaseControlStatus> = {}, evidence: Partial<ReleaseRuntimeEvidence> = {}, done: Partial<ReleaseCompletion> = {}) =>
  reconcileGenericProductionDeploy({ request, status: status(state), runtime: runtime(evidence), completion: completion(done) });

describe("generic production deploy reconciliation", () => {
  it("freezes an order-independent full migration inventory", () => {
    expect(request.expected.migration).toBe(migrationInventoryExpectation([...migrationVersions].reverse()));
  });

  it("advances a fresh deployment through acquire, pause, deploy, and guarded reopen", () => {
    expect(reconcile().action).toBe("ACQUIRE_OWNER");
    expect(reconcile({ owner_release_id: request.release_id }).action).toBe("PAUSE_SALES");
    expect(reconcile({ owner_release_id: request.release_id, sales_paused: true }, { source_commit: "d".repeat(40), worker_source_commit: "d".repeat(40) }).action).toBe("DEPLOY");
    expect(reconcile({ owner_release_id: request.release_id, sales_paused: true }).action).toBe("VERIFY_AND_REOPEN");
  });

  it("resumes the same SHA after deployment and fences another SHA", () => {
    expect(reconcile({ owner_release_id: request.release_id, sales_paused: true }).action).toBe("VERIFY_AND_REOPEN");
    expect(reconcile({ owner_release_id: `deploy-${"d".repeat(40)}`, sales_paused: true })).toEqual({ action: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" });
  });

  it("recognizes only its own durable completion", () => {
    expect(reconcile({}, {}, { complete: true, expected: request.expected, reopened_at: new Date().toISOString() })).toEqual({ action: "RELEASE_ALREADY_COMPLETE" });
    expect(reconcile({}, {}, {
      complete: true,
      expected: { ...request.expected, source_commit: "d".repeat(40) },
      reopened_at: new Date().toISOString(),
    })).toEqual({ action: "BLOCKED", reason: "RELEASE_COMPLETION_MISMATCH" });
  });

  it("requires frozen legal evidence and fresh worker completion, not a historical legal literal", () => {
    expect(genericProductionRuntimeReady(request, runtime())).toBe(true);
    expect(genericProductionRuntimeReady(request, runtime({ legal_version: "2026-08-23.2" }))).toBe(false);
    expect(genericProductionRuntimeReady(request, runtime({ legal_hashes: { ...request.expected.legal_hashes, PUBLIC_OFFER: "0".repeat(64) } }))).toBe(false);
    expect(genericProductionRuntimeReady(request, runtime({ worker_last_successful_sweep_at: null }))).toBe(false);
    expect(genericProductionRuntimeReady(request, runtime({ migration_versions: [...migrationVersions, "0035_future_schema.sql"] }))).toBe(false);
  });
});
