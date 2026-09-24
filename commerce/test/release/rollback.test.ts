import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryReleaseAuthorityStore, type PreDeploySnapshot } from "../../src/release/deploy-session";
import { ReleaseOrchestrator, type ReleasePorts } from "../../src/release/orchestrator";
import { withSurface } from "../support/deploy-snapshot";
import { TopologyReadError } from "../../src/release/topology-reader";
import type { ConvergencePolicy } from "../../src/release/convergence";

const target = "a".repeat(40);
const now = new Date("2026-09-20T00:00:00.000Z");
/** Deliberately not one uniform SHA: a rollback restores a vector, not a commit. */
const before: PreDeploySnapshot = { runtime: { frontend: "b".repeat(40), admin: "c".repeat(40), commerce: "b".repeat(40), worker: "d".repeat(40) }, controlPlane: { productionDeployRefSha: "b".repeat(40) } };
const partial = withSurface(before, "commerce", target);
const stranded = (options: {
  restoresTo?: PreDeploySnapshot; restoreFails?: string;
  /** What production answers, in order; an error is a read that failed. */
  observations?: (PreDeploySnapshot | Error)[];
  convergence?: ConvergencePolicy;
} = {}) => {
  const restored: unknown[] = [];
  const queue: (PreDeploySnapshot | Error)[] = options.observations ?? [partial, options.restoresTo ?? before];
  let last: PreDeploySnapshot = partial;
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => now);
  const ports: ReleasePorts = {
    sessions, clock: () => now,
    topology: {
      async observe() {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        last = next ?? last;
        return last;
      },
    },
    convergence: options.convergence,
    evidence: { async read() { return { schema: { lineage: "SUPPORTED", versions: [] } }; } },
    deployment: { async assertRecoverable() { throw new Error("unused"); }, async assertRecoverySourceAvailable() { throw new Error("unused"); }, async deploy() { throw new Error("unused"); } },
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

    // The pointer has already moved back, so this is recovery - reported as
    // such, never as an exception a caller would read as "refused before
    // mutation" (exit 20).
    const outcome = await orchestrator.rollback("stranded", "owner");
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "ROLLBACK_NOT_CONVERGED" });
    expect(store.get("stranded")?.state).toBe("RECOVERY_REQUIRED");
    expect(store.deploymentGate().closed).toBe(true);
  });

  it("rolls back a target whose runtime cannot even be observed", async () => {
    // The usual reason to roll back is that the new release did not come up.
    // Refusing because it cannot be observed would leave production fenced on
    // exactly the failure rollback exists for.
    const { store, restored, orchestrator } = stranded({
      observations: [new TopologyReadError("TOPOLOGY_UNIT_NOT_RUNNING", "COMMERCE"), before],
    });
    const outcome = await orchestrator.rollback("stranded", "owner");
    expect(outcome).toMatchObject({ kind: "ROLLED_BACK" });
    expect(restored).toEqual([before]);
    expect(store.deploymentGate().closed).toBe(false);
  });

  it("waits for the restored predecessor instead of racing it", async () => {
    let slept = 0;
    const { store, orchestrator } = stranded({
      observations: [partial, new TopologyReadError("TOPOLOGY_UNIT_NOT_RUNNING", "WORKER"), partial, before],
      convergence: { deadlineMs: 60_000, intervalMs: 5_000, sleep: async () => { slept += 1; } },
    });
    const outcome = await orchestrator.rollback("stranded", "owner");
    expect(outcome).toMatchObject({ kind: "ROLLED_BACK" });
    expect(slept).toBe(2);
    expect(store.deploymentGate().closed).toBe(false);
  });

  it("still refuses a rollback it does not own, even when nothing can be observed", async () => {
    const { store, orchestrator } = stranded({ observations: [new TopologyReadError("TOPOLOGY_UNIT_NOT_RUNNING", "COMMERCE")] });
    await expect(orchestrator.rollback("stranded", "someone-else")).rejects.toThrow("DEPLOY_SESSION_NOT_OWNER");
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

  it("refuses the launch session outright, before observing or writing anything", async () => {
    // Reversing a cutover replaces commerce.sqlite. Settling the session in the
    // database being discarded would either be impossible or land in one the
    // restored predecessor will never read.
    const store = new InMemoryReleaseAuthorityStore();
    const sessions = new DeploySessions(store, () => now);
    const ports: ReleasePorts = {
      sessions, clock: () => now,
      topology: { async observe() { return partial; } },
      evidence: { async read() { return { schema: { lineage: "SUPPORTED", versions: [] } }; } },
      deployment: { async assertRecoverable() { throw new Error("unused"); }, async assertRecoverySourceAvailable() { throw new Error("unused"); }, async deploy() { throw new Error("unused"); } },
      recovery: { async restorePreDeployTopology() { throw new Error("must not be called"); } },
    };
    // Nothing creates an adopted session any more; this is the launch session
    // as production recorded it.
    store.acquire({
      id: "cutover", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
      state: "FENCED", rollbackAuthority: "OLD_LINEAGE_ALLOWED", mutationObserved: false,
      createdAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      launch: true,
      preDeployTopology: before,
    });
    sessions.beginDeploying("cutover", "owner");
    const recorded = store.get("cutover");

    await expect(new ReleaseOrchestrator(ports).rollback("cutover", "owner"))
      .rejects.toThrow("LAUNCH_SESSION_NOT_ROLLBACKABLE");
    // Refused before anything is observed or written.
    expect(store.get("cutover")).toEqual(recorded);
  });
});
