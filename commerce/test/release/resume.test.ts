import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryReleaseAuthorityStore, type PreDeployTopology } from "../../src/release/deploy-session";
import { ReleaseOrchestrator, type ReleasePorts } from "../../src/release/orchestrator";
import { schemaInventoryExpectation } from "../../src/release/expectation";

const target = "a".repeat(40);
const old = "b".repeat(40);
const topology = (sha: string): PreDeployTopology => ({ frontend: sha, admin: sha, commerce: sha, worker: sha });
const versions = ["0001_launch_baseline.sql"];
const expectation = {
  sourceCommit: target, schemaInventory: schemaInventoryExpectation(versions),
  legalVersion: "2026-09-20.1", legalManifestSha256: "e".repeat(64),
};

/** A dead runner leaves a session mid-flight; a new one picks it up later. */
const abandoned = (options: { at: string; observes: PreDeployTopology; afterDeploy?: boolean }) => {
  let clock = new Date("2026-09-20T00:00:00.000Z");
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => clock, 60_000);
  const ports: ReleasePorts = {
    sessions, clock: () => clock,
    topology: { async observe() { return options.observes; } },
    evidence: { async read() { return { schema: { lineage: "SUPPORTED", versions } }; } },
    deployment: { async deploy() { throw new Error("the dead runner already tried"); } },
  };
  const session = sessions.acquireFenced({ id: options.at, ownerId: "dead-runner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
  if (options.afterDeploy) sessions.beginDeploying(session.id, "dead-runner");
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { store, sessions, session, advance, orchestrator: new ReleaseOrchestrator(ports) };
};

describe("takeover after a runner dies", () => {
  it("refuses to take a session whose owner is still alive", async () => {
    const { orchestrator } = abandoned({ at: "live", observes: topology(old), afterDeploy: true });
    // A live lease is a live deploy. Stealing it puts two runners on one
    // production topology, which is worse than waiting.
    await expect(orchestrator.resume("live", "new-runner")).rejects.toThrow("DEPLOY_SESSION_LEASE_NOT_EXPIRED");
  });

  it("moves ownership without touching the gate the dead runner closed", async () => {
    const { store, session, advance, orchestrator } = abandoned({ at: "gate", observes: topology(old), afterDeploy: true });
    expect(store.deploymentGate()).toEqual({ closed: true, deploymentSessionId: session.id });

    advance(120_000);
    const resumed = await orchestrator.resume("gate", "new-runner");

    expect(resumed.session.ownerId).toBe("new-runner");
    expect(resumed.plan).toEqual({ kind: "RETRY_DEPLOY" });
    // An expired clock is not a statement about production: sales stay shut.
    expect(store.deploymentGate()).toEqual({ closed: true, deploymentSessionId: session.id });
  });

  it("does not re-fire a deploy that already converged", async () => {
    const { advance, orchestrator } = abandoned({ at: "converged", observes: topology(target), afterDeploy: true });
    advance(120_000);

    const resumed = await orchestrator.resume("converged", "new-runner");
    expect(resumed.plan).toEqual({ kind: "PROVE_READINESS" });
  });

  it("records a partial topology as recovery before telling the caller anything", async () => {
    const partial = { ...topology(old), commerce: target };
    const { store, advance, orchestrator } = abandoned({ at: "partial", observes: partial, afterDeploy: true });
    advance(120_000);

    const resumed = await orchestrator.resume("partial", "new-runner");

    expect(resumed.plan).toEqual({ kind: "FIX_FORWARD_OR_ROLLBACK" });
    // Written down durably, so the next crash finds the conclusion already made.
    expect(resumed.session).toMatchObject({ state: "RECOVERY_REQUIRED", mutationObserved: true });
    expect(store.deploymentGate().closed).toBe(true);
  });

  it("offers only fix-forward once external effects are committed", async () => {
    const { sessions, advance, orchestrator } = abandoned({ at: "armed", observes: topology(target), afterDeploy: true });
    sessions.observeTopology("armed", "dead-runner", topology(target));
    sessions.armExternalEffects("armed", "dead-runner");
    advance(120_000);

    const resumed = await orchestrator.resume("armed", "new-runner");
    // The archived database can no longer account for what happened, so a
    // takeover inherits a one-way situation whatever the topology says.
    expect(resumed.plan).toEqual({ kind: "FIX_FORWARD_ONLY" });
  });
});
