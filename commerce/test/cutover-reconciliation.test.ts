import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reconcileCutover } from "../src/cutover-reconciliation";
import type { ReleaseCompletion, ReleaseControlRequest, ReleaseControlStatus, ReleaseRuntimeEvidence } from "../src/release-control";

const request: ReleaseControlRequest = {
  release_id: `gha-${randomUUID()}`,
  mode: "CONTROLLED_CUTOVER",
  expected: {
    source_commit: "a".repeat(40), migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-25.1", legal_manifest_sha256: "b".repeat(64),
    legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
  },
};
const status = (overrides: Partial<ReleaseControlStatus> = {}): ReleaseControlStatus => ({ sales_paused: false, owner_release_id: null, owner_mode: null, expected: null, acquired_at: null, paused_at: null, reopened_at: null, ...overrides });
const runtime = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: request.expected.source_commit, worker_source_commit: request.expected.source_commit, worker_started_at: new Date().toISOString(), worker_observed_at: new Date().toISOString(), worker_last_successful_sweep_at: new Date().toISOString(),
  required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true }, legal_version: "2026-08-23.2", legal_manifest_sha256: null,
  migration_versions: ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"],
  legal_hashes: null, legal_publish_time: null, current_legal_copies_match: false, source_legal_manifest_sha256: null, source_legal_publish_time: null, ...overrides,
});
const completion = (overrides: Partial<ReleaseCompletion> = {}): ReleaseCompletion => ({ complete: false, expected: null, reopened_at: null, ...overrides });
const reconcile = (state: Partial<ReleaseControlStatus>, evidence: Partial<ReleaseRuntimeEvidence> = {}, done: Partial<ReleaseCompletion> = {}) =>
  reconcileCutover({ request, candidateSourceCommit: request.expected.source_commit, status: status(state), runtime: runtime(evidence), completion: completion(done), previousLegalVersion: "2026-08-23.2" });

describe("controlled cutover durable reconciliation", () => {
  it.each([
    ["before acquire", {}, {}, "ACQUIRE_OWNER"],
    ["after acquire before pause", { owner_release_id: request.release_id }, {}, "PAUSE_SALES"],
    ["after pause before candidate deploy", { owner_release_id: request.release_id, sales_paused: true }, { source_commit: "d".repeat(40) }, "DEPLOY_CANDIDATE"],
    ["after candidate deploy dispatch", { owner_release_id: request.release_id, sales_paused: true }, { worker_source_commit: "d".repeat(40) }, "DEPLOY_CANDIDATE"],
    ["after candidate runtime proof", { owner_release_id: request.release_id, sales_paused: true }, {}, "PUBLISH_LEGAL"],
    ["lost legal-publish response", { owner_release_id: request.release_id, sales_paused: true, expected: request.expected }, { legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256, legal_publish_time: new Date().toISOString() }, "CREATE_PROMOTION"],
    ["after legal publication", { owner_release_id: request.release_id, sales_paused: true, expected: request.expected }, { legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256 }, "CREATE_PROMOTION"],
    ["after promotion source generation", { owner_release_id: request.release_id, sales_paused: true, expected: request.expected }, { legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256 }, "CREATE_PROMOTION"],
    ["after promotion push before expectation update", { owner_release_id: request.release_id, sales_paused: true, expected: request.expected }, { legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256 }, "CREATE_PROMOTION"],
  ])("keeps sales paused and reconciles %s", (_label, state, evidence, action) => {
    expect(reconcile(state as Partial<ReleaseControlStatus>, evidence as Partial<ReleaseRuntimeEvidence>).action).toBe(action);
  });

  it("fences competing or uncertain states and recognizes only its own durable completion", () => {
    expect(reconcile({ owner_release_id: "other-release", sales_paused: true })).toEqual({ action: "BLOCKED", reason: "RELEASE_CONTROL_OWNED" });
    expect(reconcile({ sales_paused: true })).toEqual({ action: "BLOCKED", reason: "PAUSED_WITHOUT_OWNER" });
    expect(reconcile({ owner_release_id: request.release_id, sales_paused: true }, { legal_version: "2026-08-26.1" })).toEqual({ action: "BLOCKED", reason: "LEGAL_RELEASE_RESUME_MISMATCH" });
    expect(reconcile({ sales_paused: false, owner_release_id: null, expected: request.expected }, { legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256 }, { complete: true, expected: request.expected, reopened_at: new Date().toISOString() }).action).toBe("RELEASE_ALREADY_COMPLETE");
  });

  it("does not publish legal from a stale worker or an incomplete schema", () => {
    const paused = { owner_release_id: request.release_id, sales_paused: true };
    expect(reconcile(paused, { worker_observed_at: new Date(Date.now() - 90_001).toISOString() }).action).toBe("DEPLOY_CANDIDATE");
    expect(reconcile(paused, { worker_last_successful_sweep_at: null }).action).toBe("DEPLOY_CANDIDATE");
    expect(reconcile(paused, { required_migrations: { "0031_participant_age_band.sql": false, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true } }).action).toBe("DEPLOY_CANDIDATE");
    expect(reconcile(paused, { required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": false, "0034_worker_sweep_evidence.sql": true } }).action).toBe("DEPLOY_CANDIDATE");
    expect(reconcile(paused).action).toBe("PUBLISH_LEGAL");
  });

  it("keeps Phase 0 target 0033 independent of worker sweep evidence", () => {
    const phase0Request = { ...request, expected: { ...request.expected, migration: "0033_runtime_release_evidence.sql" } };
    const phase0Runtime = runtime({
      required_migrations: { "0031_participant_age_band.sql": false, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": false },
      migration_versions: ["0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql"],
      worker_source_commit: null,
      worker_started_at: null,
      worker_observed_at: null,
      worker_last_successful_sweep_at: null,
    });
    expect(reconcileCutover({ request: phase0Request, candidateSourceCommit: phase0Request.expected.source_commit, status: status({ owner_release_id: phase0Request.release_id, sales_paused: true }), runtime: phase0Runtime, completion: completion(), previousLegalVersion: "2026-08-23.2" }).action).toBe("PUBLISH_LEGAL");
  });

  it("retries the promoted source after expectations update or deployment dispatch", () => {
    const promotedRequest = { ...request, expected: { ...request.expected, source_commit: "d".repeat(40) } };
    const promotedStatus = status({ owner_release_id: request.release_id, sales_paused: true, expected: promotedRequest.expected });
    const candidateRuntime = runtime({ source_commit: request.expected.source_commit, worker_source_commit: request.expected.source_commit, legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256 });
    expect(reconcileCutover({ request: promotedRequest, candidateSourceCommit: request.expected.source_commit, status: promotedStatus, runtime: candidateRuntime, completion: completion(), previousLegalVersion: "2026-08-23.2" }).action).toBe("DEPLOY_PROMOTION");
    const promotedRuntime = runtime({ source_commit: promotedRequest.expected.source_commit, worker_source_commit: promotedRequest.expected.source_commit, legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256 });
    expect(reconcileCutover({ request: promotedRequest, candidateSourceCommit: request.expected.source_commit, status: promotedStatus, runtime: promotedRuntime, completion: completion(), previousLegalVersion: "2026-08-23.2" }).action).toBe("VERIFY_AND_REOPEN");
  });

  it("advances a fresh release one durable transition at a time", () => {
    const actions: string[] = [];
    let durable = status();
    let evidence = runtime({ source_commit: "d".repeat(40), worker_source_commit: "d".repeat(40) });
    const next = (activeRequest = request, candidateSourceCommit = request.expected.source_commit) => reconcileCutover({ request: activeRequest, candidateSourceCommit, status: durable, runtime: evidence, completion: completion(), previousLegalVersion: "2026-08-23.2" }).action;
    actions.push(next()); // acquire
    durable = status({ owner_release_id: request.release_id });
    actions.push(next()); // pause
    durable = status({ owner_release_id: request.release_id, sales_paused: true, expected: request.expected });
    actions.push(next()); // candidate deploy
    evidence = runtime();
    actions.push(next()); // legal publish
    evidence = runtime({ legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256, legal_publish_time: new Date().toISOString() });
    actions.push(next()); // promote source
    const promotedRequest = { ...request, expected: { ...request.expected, source_commit: "d".repeat(40) } };
    durable = status({ owner_release_id: request.release_id, sales_paused: true, expected: promotedRequest.expected });
    actions.push(next(promotedRequest)); // promotion deploy
    evidence = runtime({ source_commit: promotedRequest.expected.source_commit, worker_source_commit: promotedRequest.expected.source_commit, legal_version: request.expected.legal_version, legal_manifest_sha256: request.expected.legal_manifest_sha256, legal_publish_time: new Date().toISOString() });
    actions.push(next(promotedRequest)); // verify/reopen
    expect(actions).toEqual(["ACQUIRE_OWNER", "PAUSE_SALES", "DEPLOY_CANDIDATE", "PUBLISH_LEGAL", "CREATE_PROMOTION", "DEPLOY_PROMOTION", "VERIFY_AND_REOPEN"]);
  });
});
