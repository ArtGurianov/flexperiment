import { describe, expect, it } from "vitest";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { evaluateReadiness, type ReleaseReadinessEvidence, type ReleaseReadinessExpectation } from "../../src/release/readiness";

const now = new Date("2026-09-19T00:00:00.000Z");
const commit = "a".repeat(40);
const versions = ["0001_launch_baseline.sql"];
const expectation: ReleaseReadinessExpectation = { sourceCommit: commit, schemaInventory: schemaInventoryExpectation(versions), legalVersion: "2026-09-19.1", legalManifestSha256: "b".repeat(64) };
const runtime = { sourceCommit: commit, startedAt: "2026-09-18T23:59:00.000Z", heartbeatAt: "2026-09-18T23:59:59.000Z" };
const admitted = (): ReleaseReadinessEvidence => ({ commerce: runtime, worker: { ...runtime, lastSuccessfulSweepAt: "2026-09-18T23:59:59.000Z" }, schema: { lineage: "SUPPORTED", versions }, legal: { version: expectation.legalVersion, manifestSha256: expectation.legalManifestSha256 } });

describe("release readiness", () => {
  it("admits only matching commit, fresh worker evidence, inventory and legal evidence", () => {
    expect(evaluateReadiness(expectation, admitted(), now)).toEqual({ state: "ADMITTED" });
  });

  it("keeps incomplete convergence distinct from an inadmissible lineage", () => {
    expect(evaluateReadiness(expectation, { ...admitted(), worker: undefined }, now)).toEqual({ state: "PENDING", code: "WORKER_RUNTIME_EVIDENCE_MISSING" });
    expect(evaluateReadiness(expectation, { ...admitted(), schema: { lineage: "SUPPORTED", versions: [] } }, now)).toEqual({ state: "PENDING", code: "SCHEMA_INVENTORY_NOT_CONVERGED" });
    expect(evaluateReadiness(expectation, { ...admitted(), schema: { lineage: "LEGACY", versions } }, now)).toEqual({ state: "REJECTED", code: "LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED" });
  });

  it("returns one deterministic code for stale or mismatched evidence", () => {
    expect(evaluateReadiness(expectation, { ...admitted(), commerce: { ...runtime, sourceCommit: "c".repeat(40) } }, now)).toEqual({ state: "PENDING", code: "COMMERCE_SOURCE_COMMIT_MISMATCH" });
    expect(evaluateReadiness(expectation, { ...admitted(), worker: { ...runtime, lastSuccessfulSweepAt: "2026-09-18T23:00:00.000Z" } }, now)).toEqual({ state: "PENDING", code: "WORKER_SWEEP_STALE" });
    expect(evaluateReadiness({ ...expectation, schemaInventory: "0001_launch_baseline.sql" }, admitted(), now)).toEqual({ state: "REJECTED", code: "EXPECTED_SCHEMA_INVENTORY_INVALID" });
  });

  it("separates malformed evidence from evidence that has simply not converged", () => {
    // Waiting cannot repair a timestamp or commit that does not parse, so a
    // read-only convergence loop must be told to stop rather than keep polling.
    expect(evaluateReadiness(expectation, { ...admitted(), commerce: { ...runtime, sourceCommit: "not-a-commit" } }, now))
      .toEqual({ state: "REJECTED", code: "COMMERCE_SOURCE_COMMIT_INVALID" });
    expect(evaluateReadiness(expectation, { ...admitted(), commerce: { ...runtime, heartbeatAt: "yesterday" } }, now))
      .toEqual({ state: "REJECTED", code: "COMMERCE_HEARTBEAT_INVALID" });
    expect(evaluateReadiness(expectation, { ...admitted(), worker: { ...runtime, lastSuccessfulSweepAt: "soon" } }, now))
      .toEqual({ state: "REJECTED", code: "WORKER_SWEEP_INVALID" });
    // The same unit, one field later, is ordinary convergence again.
    expect(evaluateReadiness(expectation, { ...admitted(), commerce: { ...runtime, heartbeatAt: "2026-09-18T23:00:00.000Z" } }, now))
      .toEqual({ state: "PENDING", code: "COMMERCE_HEARTBEAT_STALE" });
  });

  it("judges an unsupported database before it waits on any runtime evidence", () => {
    // An unsupported lineage is a property of the database, not a deploy that
    // has yet to converge; it must never read as "still waiting for the worker".
    expect(evaluateReadiness(expectation, { commerce: undefined, worker: undefined, schema: { lineage: "LEGACY", versions }, legal: undefined }, now))
      .toEqual({ state: "REJECTED", code: "LEGACY_PRELAUNCH_DATABASE_NOT_SUPPORTED" });
    expect(evaluateReadiness(expectation, { commerce: undefined, worker: undefined, schema: { lineage: "UNKNOWN", versions }, legal: undefined }, now))
      .toEqual({ state: "REJECTED", code: "UNKNOWN_SCHEMA_LINEAGE" });
  });
});
