import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryReleaseAuthorityStore, type PreDeployTopology } from "../../src/release/deploy-session";
import { ReleaseOrchestrator, type ReleasePorts } from "../../src/release/orchestrator";
import type { ReleaseReadinessEvidence, ReleaseReadinessExpectation } from "../../src/release/readiness";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import type { CertificationCapability } from "../../src/certification/capability";

const target = "a".repeat(40);
const old = "b".repeat(40);
const now = new Date("2026-09-20T00:00:00.000Z");
const versions = ["0001_launch_baseline.sql"];
const topology = (sha: string): PreDeployTopology => ({ frontend: sha, admin: sha, commerce: sha, worker: sha });

const candidateFor = (releaseClass: "LAUNCH_BASELINE" | "ROLLING_COMPATIBLE" | "MAINTENANCE_REQUIRED") => ({
  id: `candidate-${releaseClass}`, sha: target, releaseClass, expectation,
});

const expectation: Omit<ReleaseReadinessExpectation, "sourceCommit"> = {
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
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => now);
  const ports: ReleasePorts = {
    sessions,
    clock: () => now,
    topology: {
      async observe() { last = queue.shift() ?? last; log.push(`observe:${last.commerce}`); return last; },
    },
    evidence: { async read() { log.push("readiness"); return options.evidence ?? admittedEvidence(); } },
    deployment: {
      async deploy(sha) { log.push(`deploy:${sha}`); if (options.deployFails) throw new Error(options.deployFails); },
    },
    certification: {
      async issueCapability(sessionId): Promise<CertificationCapability> {
        log.push("capability-issued");
        return { id: "cap", runId: "run", deploymentSessionId: sessionId, releaseSha: target, maxAmountKopecks: 100, nonce: "nonce", expiresAt: "2026-09-20T00:15:00.000Z" };
      },
      async certify() { log.push("certify"); if (options.certifyFails) throw new Error(options.certifyFails); },
    },
  };
  return { log, ports, store, orchestrator: new ReleaseOrchestrator(ports) };
};

const cutoverRequest = { ownerId: "owner", candidate: candidateFor("LAUNCH_BASELINE") } as const;
const rollingRequest = { ownerId: "owner", candidate: candidateFor("ROLLING_COMPATIBLE") } as const;

describe("maintenance cutover ordering", () => {
  it("fences before deploying and arms only after convergence and readiness", async () => {
    const { log, store, orchestrator } = harness({ topologies: [topology(old), topology(target), topology(target)] });
    const outcome = await orchestrator.runMaintenanceCutover(cutoverRequest);

    expect(outcome.kind).toBe("SUCCEEDED");
    // The whole contract, read top to bottom: nothing can be certified before
    // the fence is up, the target is proved and readiness has admitted it.
    expect(log).toEqual([
      `observe:${old}`,
      `deploy:${target}`,
      `observe:${target}`,
      "readiness",
      "capability-issued",
      "certify",
      `observe:${target}`,
    ]);
    expect(outcome.session).toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
    // Settling the session and reopening the gate is one operation, so a
    // terminal session can never coexist with sales still shut.
    expect(store.deploymentGate().closed).toBe(false);
  });

  it("safe-aborts and reopens sales when the build fails before any surface moves", async () => {
    const { log, store, orchestrator } = harness({ topologies: [topology(old), topology(old)], deployFails: "IMAGE_BUILD_FAILED" });
    const outcome = await orchestrator.runMaintenanceCutover(cutoverRequest);

    expect(outcome).toMatchObject({ kind: "SAFE_ABORTED", code: "IMAGE_BUILD_FAILED" });
    expect(outcome.session).toMatchObject({ state: "SAFE_ABORTED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
    expect(store.deploymentGate().closed).toBe(false);
    expect(log).not.toContain("capability-issued");
  });

  it("keeps sales closed and never certifies when only some surfaces moved", async () => {
    const partial = { ...topology(old), frontend: target };
    const { log, store, orchestrator } = harness({ topologies: [topology(old), partial, partial] });
    const outcome = await orchestrator.runMaintenanceCutover(cutoverRequest);

    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "TARGET_TOPOLOGY_NOT_CONVERGED" });
    expect(outcome.session).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "OLD_LINEAGE_ALLOWED", mutationObserved: true });
    expect(store.deploymentGate().closed).toBe(true);
    expect(log).not.toContain("capability-issued");
  });

  it("refuses to arm when readiness has not admitted, even on a converged topology", async () => {
    const stale = admittedEvidence();
    const { log, store, orchestrator } = harness({
      topologies: [topology(old), topology(target), topology(target)],
      evidence: { ...stale, worker: undefined },
    });
    const outcome = await orchestrator.runMaintenanceCutover(cutoverRequest);

    // Converged is not admitted: an unproved worker is exactly the case a
    // readiness check exists for, and it must stop the release short of money.
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "READINESS_PENDING:WORKER_RUNTIME_EVIDENCE_MISSING" });
    expect(log).not.toContain("capability-issued");
    expect(store.deploymentGate().closed).toBe(true);
  });

  it("leaves sales closed for recovery when certification fails past the boundary", async () => {
    const { log, store, orchestrator } = harness({ topologies: [topology(old), topology(target), topology(target)], certifyFails: "REFUND_NOT_OBSERVED" });
    const outcome = await orchestrator.runMaintenanceCutover(cutoverRequest);

    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "CERTIFICATION_FAILED:REFUND_NOT_OBSERVED" });
    // Past the boundary the archived database can no longer account for what
    // may have happened, so the only exit is forward and sales stay shut.
    expect(outcome.session).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(store.deploymentGate().closed).toBe(true);
  });
  it("re-observes the topology after certification and refuses a drifted surface", async () => {
    // A payment and a refund take real minutes. A surface that drifts during
    // them must not be closed over by the snapshot taken before arming.
    const drifted = { ...topology(target), admin: old };
    const { log, store, orchestrator } = harness({ topologies: [topology(old), topology(target), drifted, drifted] });
    const outcome = await orchestrator.runMaintenanceCutover(cutoverRequest);

    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "TARGET_TOPOLOGY_NOT_CONVERGED" });
    expect(outcome.session).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(log).toContain("certify");
    expect(store.deploymentGate().closed).toBe(true);
  });
});

describe("rolling release ordering", () => {
  it("never touches the sales fence, arms nothing and certifies nothing", async () => {
    const { log, store, orchestrator } = harness({ topologies: [topology(old), topology(target)] });
    const outcome = await orchestrator.runRolling(rollingRequest);

    expect(outcome.kind).toBe("SUCCEEDED");
    expect(outcome.session).toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
    expect(log).toEqual([`observe:${old}`, `deploy:${target}`, `observe:${target}`, "readiness"]);
  });

  it("leaves the sales fence untouched when a rolling deploy fails", async () => {
    // The rolling path never closed the gate, so it has no business opening it
    // either - the shared failure classifier must not reopen on its behalf.
    const { log, store, orchestrator } = harness({ topologies: [topology(old), topology(old)], deployFails: "IMAGE_BUILD_FAILED" });
    const outcome = await orchestrator.runRolling(rollingRequest);

    expect(outcome).toMatchObject({ kind: "SAFE_ABORTED", code: "IMAGE_BUILD_FAILED" });
    // The rolling path never closed the gate, so it must not have opened one.
    expect(store.deploymentGate().closed).toBe(false);
  });

  it("refuses a cutover request on the rolling path and the reverse", async () => {
    const { orchestrator } = harness({ topologies: [topology(old)] });
    // The mode is derived from the candidate's class, so the paths refuse each
    // other's candidates instead of trusting a flag a caller set.
    await expect(orchestrator.runRolling(cutoverRequest))
      .rejects.toThrow("ROLLING_RELEASE_REQUIRES_ROLLING_SAFE");
    await expect(orchestrator.runMaintenanceCutover(rollingRequest))
      .rejects.toThrow("CUTOVER_REQUIRES_MAINTENANCE_CUTOVER");
  });
});
