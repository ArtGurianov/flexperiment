import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryDeploySessionStore, type PreDeployTopology } from "../../src/release/deploy-session";
import { ReleaseOrchestrator, type ReleasePorts } from "../../src/release/orchestrator";
import type { ReleaseReadinessEvidence, ReleaseReadinessExpectation } from "../../src/release/readiness";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import type { CertificationCapability } from "../../src/release/sales-gate";

const target = "a".repeat(40);
const old = "b".repeat(40);
const now = new Date("2026-09-20T00:00:00.000Z");
const versions = ["0001_launch_baseline.sql"];
const topology = (sha: string): PreDeployTopology => ({ frontend: sha, admin: sha, commerce: sha, worker: sha });

const expectation: ReleaseReadinessExpectation = {
  sourceCommit: target,
  schemaInventory: schemaInventoryExpectation(versions),
  legalVersion: "2026-09-20.1",
  legalManifestSha256: "e".repeat(64),
};

const admittedEvidence = (): ReleaseReadinessEvidence => {
  const runtime = { sourceCommit: target, startedAt: "2026-09-19T23:59:00.000Z", heartbeatAt: "2026-09-19T23:59:50.000Z" };
  return {
    commerce: runtime,
    worker: { ...runtime, lastSuccessfulSweepAt: "2026-09-19T23:59:50.000Z" },
    schema: { lineage: "SUPPORTED", versions },
    legal: { version: expectation.legalVersion, manifestSha256: expectation.legalManifestSha256 },
  };
};

/** Records what the orchestrator actually did, in order. */
const harness = (options: {
  topologies: PreDeployTopology[];
  deployFails?: string;
  certifyFails?: string;
  evidence?: ReleaseReadinessEvidence;
} ) => {
  const log: string[] = [];
  const queue = [...options.topologies];
  let last = queue[0];
  const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => now);
  const ports: ReleasePorts = {
    sessions,
    clock: () => now,
    topology: {
      async observe() { last = queue.shift() ?? last; log.push(`observe:${last.commerce}`); return last; },
    },
    evidence: { async read() { log.push("readiness"); return options.evidence ?? admittedEvidence(); } },
    fence: {
      async close() { log.push("fence-close"); },
      async open() { log.push("fence-open"); },
    },
    deployment: {
      async deploy(sha) { log.push(`deploy:${sha}`); if (options.deployFails) throw new Error(options.deployFails); },
    },
    certification: {
      async issueCapability(sessionId): Promise<CertificationCapability> {
        log.push("capability-issued");
        return { id: "cap", deploymentSessionId: sessionId, expiresAt: "2026-09-20T00:15:00.000Z" };
      },
      async certify() { log.push("certify"); if (options.certifyFails) throw new Error(options.certifyFails); },
    },
  };
  return { log, ports, orchestrator: new ReleaseOrchestrator(ports) };
};

const request = { ownerId: "owner", targetSha: target, expectation } as const;

describe("maintenance cutover ordering", () => {
  it("fences before deploying and arms only after convergence and readiness", async () => {
    const { log, orchestrator } = harness({ topologies: [topology(old), topology(target)] });
    const outcome = await orchestrator.runMaintenanceCutover({ ...request, mode: "MAINTENANCE_CUTOVER" });

    expect(outcome.kind).toBe("SUCCEEDED");
    // The whole contract, read top to bottom: nothing can be certified before
    // the fence is up, the target is proved and readiness has admitted it.
    expect(log).toEqual([
      `observe:${old}`,
      "fence-close",
      `deploy:${target}`,
      `observe:${target}`,
      "readiness",
      "capability-issued",
      "certify",
      "fence-open",
    ]);
    expect(outcome.session).toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
  });

  it("safe-aborts and reopens sales when the build fails before any surface moves", async () => {
    const { log, orchestrator } = harness({ topologies: [topology(old), topology(old)], deployFails: "IMAGE_BUILD_FAILED" });
    const outcome = await orchestrator.runMaintenanceCutover({ ...request, mode: "MAINTENANCE_CUTOVER" });

    expect(outcome).toMatchObject({ kind: "SAFE_ABORTED", code: "IMAGE_BUILD_FAILED" });
    expect(outcome.session).toMatchObject({ state: "SAFE_ABORTED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
    expect(log.at(-1)).toBe("fence-open");
    expect(log).not.toContain("capability-issued");
  });

  it("keeps sales closed and never certifies when only some surfaces moved", async () => {
    const partial = { ...topology(old), frontend: target };
    const { log, orchestrator } = harness({ topologies: [topology(old), partial, partial] });
    const outcome = await orchestrator.runMaintenanceCutover({ ...request, mode: "MAINTENANCE_CUTOVER" });

    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "TARGET_TOPOLOGY_NOT_CONVERGED" });
    expect(outcome.session).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "OLD_LINEAGE_ALLOWED", mutationObserved: true });
    expect(log).not.toContain("fence-open");
    expect(log).not.toContain("capability-issued");
  });

  it("refuses to arm when readiness has not admitted, even on a converged topology", async () => {
    const stale = admittedEvidence();
    const { log, orchestrator } = harness({
      topologies: [topology(old), topology(target), topology(target)],
      evidence: { ...stale, worker: undefined },
    });
    const outcome = await orchestrator.runMaintenanceCutover({ ...request, mode: "MAINTENANCE_CUTOVER" });

    // Converged is not admitted: an unproved worker is exactly the case a
    // readiness check exists for, and it must stop the release short of money.
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "READINESS_PENDING:WORKER_RUNTIME_EVIDENCE_MISSING" });
    expect(log).not.toContain("capability-issued");
    expect(log).not.toContain("fence-open");
  });

  it("leaves sales closed for recovery when certification fails past the boundary", async () => {
    const { log, orchestrator } = harness({ topologies: [topology(old), topology(target)], certifyFails: "REFUND_NOT_OBSERVED" });
    const outcome = await orchestrator.runMaintenanceCutover({ ...request, mode: "MAINTENANCE_CUTOVER" });

    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "CERTIFICATION_FAILED:REFUND_NOT_OBSERVED" });
    // Past the boundary the archived database can no longer account for what
    // may have happened, so the only exit is forward and sales stay shut.
    expect(outcome.session).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(log).not.toContain("fence-open");
  });
});

describe("rolling release ordering", () => {
  it("never touches the sales fence, arms nothing and certifies nothing", async () => {
    const { log, orchestrator } = harness({ topologies: [topology(old), topology(target)] });
    const outcome = await orchestrator.runRolling({ ...request, mode: "ROLLING_SAFE" });

    expect(outcome.kind).toBe("SUCCEEDED");
    expect(outcome.session).toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
    expect(log).toEqual([`observe:${old}`, `deploy:${target}`, `observe:${target}`, "readiness"]);
  });

  it("refuses a cutover request on the rolling path and the reverse", async () => {
    const { orchestrator } = harness({ topologies: [topology(old)] });
    await expect(orchestrator.runRolling({ ...request, mode: "MAINTENANCE_CUTOVER" }))
      .rejects.toThrow("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    await expect(orchestrator.runMaintenanceCutover({ ...request, mode: "ROLLING_SAFE" }))
      .rejects.toThrow("CUTOVER_REQUIRES_MAINTENANCE_CUTOVER");
  });
});
