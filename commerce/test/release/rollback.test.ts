import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryReleaseAuthorityStore, type PreDeploySnapshot } from "../../src/release/deploy-session";
import { ReleaseOrchestrator, type ReleasePorts } from "../../src/release/orchestrator";
import { withSurface } from "../support/deploy-snapshot";

const target = "a".repeat(40);
const now = new Date("2026-09-20T00:00:00.000Z");
/** Deliberately not one uniform SHA: a rollback restores a vector, not a commit. */
const before: PreDeploySnapshot = { runtime: { frontend: "b".repeat(40), admin: "c".repeat(40), commerce: "b".repeat(40), worker: "d".repeat(40) }, controlPlane: { productionDeployRefSha: "b".repeat(40) } };
const partial = withSurface(before, "commerce", target);
const stranded = (options: { restoresTo?: PreDeploySnapshot; restoreFails?: string } = {}) => {
  const restored: unknown[] = [];
  const queue: PreDeploySnapshot[] = [partial, options.restoresTo ?? before];
  let last = partial;
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => now);
  const ports: ReleasePorts = {
    sessions, clock: () => now,
    topology: { async observe() { last = queue.shift() ?? last; return last; } },
    evidence: { async read() { return { schema: { lineage: "SUPPORTED", versions: [] } }; } },
    deployment: { async assertRecoverable() { throw new Error("unused"); }, async assertPredecessorRetained() { throw new Error("unused"); }, async deploy() { throw new Error("unused"); } },
    recovery: {
      async restorePreDeployTopology(topology) {
        restored.push(topology);
        if (options.restoreFails) throw new Error(options.restoreFails);
      },
    },
  };
  const session = sessions.acquireFenced({
    id: "stranded", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
  }, before);
  sessions.beginDeploying(session.id, "owner");
  return { store, sessions, restored, orchestrator: new ReleaseOrchestrator(ports) };
};

describe("rollback after a partial cutover", () => {
  it("restores the exact vector and the archived database, then reopens sales", async () => {
    const { store, restored, orchestrator } = stranded();

    const outcome = await orchestrator.rollback("stranded", "owner");

    expect(outcome).toMatchObject({ kind: "ROLLED_BACK" });
    expect(outcome.session).toMatchObject({ state: "ROLLED_BACK", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
    // Not "deploy the old SHA": each surface goes back to what it was actually
    // serving, which here is deliberately not one uniform commit.
    expect(restored).toEqual([before]);
    expect(store.deploymentGate()).toEqual({ closed: false, deploymentSessionId: null });
  });

  it("does not believe the driver: a topology that did not come back is not a rollback", async () => {
    const stillPartial = withSurface(before, "worker", target);
    const { store, orchestrator } = stranded({ restoresTo: stillPartial });

    await expect(orchestrator.rollback("stranded", "owner")).rejects.toThrow("ROLLBACK_TOPOLOGY_NOT_CONVERGED");
    expect(store.deploymentGate().closed).toBe(true);
  });

  it("stays in recovery when the restore itself fails", async () => {
    const { store, orchestrator } = stranded({ restoreFails: "ARCHIVE_DIGEST_MISMATCH" });

    const outcome = await orchestrator.rollback("stranded", "owner");

    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "ROLLBACK_FAILED:ARCHIVE_DIGEST_MISMATCH" });
    expect(store.deploymentGate().closed).toBe(true);
  });

  it("refuses outright once external effects are committed", async () => {
    const { sessions, restored, orchestrator } = stranded();
    sessions.observeTopology("stranded", "owner", { runtime: { frontend: target, admin: target, commerce: target, worker: target }, controlPlane: { productionDeployRefSha: target } });
    sessions.armExternalEffects("stranded", "owner");

    await expect(orchestrator.rollback("stranded", "owner")).rejects.toThrow("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    // The driver is never even asked: fix-forward is the only direction left.
    expect(restored).toEqual([]);
  });

  it("refuses a cutover session outright and points at the reverse handoff", async () => {
    // Reversing a cutover replaces commerce.sqlite. Settling the session in the
    // database being discarded would either be impossible or land in one the
    // restored predecessor will never read.
    const store = new InMemoryReleaseAuthorityStore();
    const sessions = new DeploySessions(store, () => now);
    const ports: ReleasePorts = {
      sessions, clock: () => now,
      topology: { async observe() { return partial; } },
      evidence: { async read() { return { schema: { lineage: "SUPPORTED", versions: [] } }; } },
      deployment: { async assertRecoverable() { throw new Error("unused"); }, async assertPredecessorRetained() { throw new Error("unused"); }, async deploy() { throw new Error("unused"); } },
      recovery: { async restorePreDeployTopology() { throw new Error("must not be called"); } },
    };
    sessions.acquireFenced({
      id: "cutover", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
      adoptedCutoverId: "cutover-1", predecessorDatabaseRef: "prelaunch.sqlite", predecessorDatabaseSha256: "e".repeat(64),
    }, before);
    sessions.beginDeploying("cutover", "owner");

    await expect(new ReleaseOrchestrator(ports).rollback("cutover", "owner"))
      .rejects.toThrow("CROSS_LINEAGE_ROLLBACK_REQUIRES_REVERSE_HANDOFF");
  });
});
