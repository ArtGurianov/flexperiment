import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryReleaseAuthorityStore, type PreDeploySnapshot } from "../../src/release/deploy-session";
import { ReleaseOrchestrator, type ReleasePorts } from "../../src/release/orchestrator";
import { schemaInventoryExpectation } from "../../src/release/expectation";
import { withSurface } from "../support/deploy-snapshot";

const target = "a".repeat(40);
const old = "b".repeat(40);
const topology = (sha: string): PreDeploySnapshot => ({ runtime: { frontend: sha, admin: sha, commerce: sha, worker: sha }, controlPlane: { productionDeployRefSha: sha } });
const versions = ["0001_launch_baseline.sql"];
const expectation = {
  schemaInventory: schemaInventoryExpectation(versions),
  legalVersion: "2026-09-20.1", legalManifestSha256: "e".repeat(64),
};
const candidate = { id: "candidate-1", sha: target, releaseClass: "MAINTENANCE_REQUIRED" as const, expectation };

/** A dead runner leaves a session mid-flight; a new one picks it up later. */
const abandoned = (options: { at: string; observes: PreDeploySnapshot | PreDeploySnapshot[]; afterDeploy?: boolean; deploys?: boolean }) => {
  const queue = Array.isArray(options.observes) ? [...options.observes] : [];
  let last = Array.isArray(options.observes) ? queue[0] : options.observes;
  const log: string[] = [];
  let clock = new Date("2026-09-20T00:00:00.000Z");
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => clock, 60_000);
  const ports: ReleasePorts = {
    sessions, clock: () => clock,
    topology: { async observe() { if (queue.length) last = queue.shift()!; log.push(`observe:${last.runtime.commerce}`); return last; } },
    candidates: { get: (id) => (id === candidate.id ? candidate : undefined) },
    evidence: {
      async read() {
        log.push("readiness");
        const runtime = { sourceCommit: target, startedAt: "2026-09-19T23:59:00.000Z", heartbeatAt: clock.toISOString() };
        return {
          commerce: runtime, worker: { ...runtime, lastSuccessfulSweepAt: clock.toISOString() },
          schema: { lineage: "SUPPORTED" as const, versions },
          legal: { version: expectation.legalVersion, manifestSha256: expectation.legalManifestSha256 },
        };
      },
    },
    deployment: {
      async assertRecoverable() { log.push("recoverable"); },
      async assertRecoverySourceAvailable() { log.push("retained"); },
      async deploy() {
        log.push("deploy");
        if (!options.deploys) throw new Error("the dead runner already tried");
      },
    },
    certification: {
      async issueCapability(id) { log.push("capability"); return { id: "cap", runId: "run", deploymentSessionId: id, releaseSha: target, maxAmountKopecks: 100, nonceDigest: "digest", expiresAt: "2026-09-21T00:00:00.000Z" }; },
      async preflight() { log.push("preflight"); },
      async certify() { log.push("certify"); },
    },
  };
  const session = sessions.acquireFenced({ id: options.at, ownerId: "dead-runner", mode: "MAINTENANCE_CUTOVER", targetSha: target, candidateId: candidate.id }, topology(old));
  if (options.afterDeploy) sessions.beginDeploying(session.id, "dead-runner");
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  return { store, sessions, session, advance, log, ports, orchestrator: new ReleaseOrchestrator(ports) };
};

describe("takeover after a runner dies", () => {
  it("resumes a runner that died after fencing but before deploying", async () => {
    // The gap between closing the gate and starting the deploy is an ordinary
    // crash point, and the session sits in FENCED when it happens.
    const { store, session, advance, orchestrator } = abandoned({ at: "fenced", observes: topology(old) });
    advance(120_000);

    const resumed = await orchestrator.resume("fenced", "new-runner");

    expect(resumed.plan).toEqual({ kind: "RETRY_DEPLOY" });
    expect(store.deploymentGate()).toEqual({ closed: true, deploymentSessionId: session.id });
  });

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
    const partial = withSurface(topology(old), "commerce", target);
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

describe("continuing a session that was taken over", () => {
  it("carries a converged session through readiness to the operator handoff", async () => {
    const { advance, log, orchestrator } = abandoned({ at: "pickup", observes: topology(target), afterDeploy: true });
    advance(120_000);
    const resumed = await orchestrator.resume("pickup", "new-runner");
    expect(resumed.plan).toEqual({ kind: "PROVE_READINESS" });

    const outcome = await orchestrator.continueSession("pickup", "new-runner", "PROVE_READINESS");

    // The same ordering the live path uses, not a copy of it: no second deploy,
    // readiness before the capability, and the attended step still ahead.
    expect(outcome).toMatchObject({ kind: "AWAITING_OPERATOR" });
    expect(log).not.toContain("deploy");
    expect(log.indexOf("readiness")).toBeLessThan(log.indexOf("capability"));
    expect(log).not.toContain("certify");
    // A resumed session that has not been certified is still rollback-legal.
    expect(outcome.session.rollbackAuthority).toBe("OLD_LINEAGE_ALLOWED");
  });

  it("re-fires the deployment only when the topology still says nothing moved", async () => {
    const { advance, log, orchestrator } = abandoned({
      at: "retry", observes: [topology(old), topology(old), topology(target), topology(target)], deploys: true,
    });
    advance(120_000);
    await orchestrator.resume("retry", "new-runner");

    const outcome = await orchestrator.continueSession("retry", "new-runner", "RETRY_DEPLOY");

    expect(outcome).toMatchObject({ kind: "AWAITING_OPERATOR" });
    expect(log.filter((entry) => entry === "deploy")).toHaveLength(1);
  });

  it("refuses a plan that production has since outgrown", async () => {
    // Minutes pass between a recovery workflow reading a plan and acting on it.
    // A plan is a statement about production when it was made, not a promise.
    const { advance, log, orchestrator } = abandoned({
      at: "stale", observes: [topology(old), topology(target)], afterDeploy: true,
    });
    advance(120_000);
    const resumed = await orchestrator.resume("stale", "new-runner");
    expect(resumed.plan).toEqual({ kind: "RETRY_DEPLOY" });

    // By the time the caller acts, every surface is already on the target.
    await expect(orchestrator.continueSession("stale", "new-runner", "RETRY_DEPLOY"))
      .rejects.toThrow("RESUME_PLAN_STALE:PROVE_READINESS");
    expect(log).not.toContain("deploy");
  });

  it("refuses to continue a session whose candidate no longer names its target", async () => {
    // The identity is settled before anything is observed or recorded. A
    // candidate republished at a different commit, or a session pointed at a
    // candidate it does not belong to, would otherwise be carried forward as
    // though it were the release that was originally fenced for.
    const { advance, log, orchestrator, ports, sessions } = abandoned({ at: "mismatch", observes: topology(target), afterDeploy: true });
    advance(120_000);
    await orchestrator.resume("mismatch", "new-runner");
    log.length = 0;

    const moved = { ...candidate, sha: old };
    const rebound = new ReleaseOrchestrator({ ...ports, candidates: { get: () => moved } });

    await expect(rebound.continueSession("mismatch", "new-runner", "PROVE_READINESS"))
      .rejects.toThrow("CANDIDATE_SESSION_MISMATCH");
    // Not one observation recorded, let alone a deploy: the refusal lands
    // before the session is touched at all.
    expect(log).toEqual([]);
    expect(sessions.read("mismatch")?.state).toBe("DEPLOYING");
  });

  it("will not choose a direction for a session that needs one", async () => {
    const partial = withSurface(topology(old), "commerce", target);
    const { advance, orchestrator } = abandoned({ at: "undecided", observes: partial, afterDeploy: true });
    advance(120_000);
    await orchestrator.resume("undecided", "new-runner");

    await expect(orchestrator.continueSession("undecided", "new-runner", "FIX_FORWARD_OR_ROLLBACK"))
      .rejects.toThrow("FIX_FORWARD_DIRECTION_REQUIRED");
  });

  it("will not carry an armed session forward: that is forward-deploy's, never resume's", async () => {
    const { sessions, advance, log, orchestrator } = abandoned({ at: "armed", observes: topology(target), afterDeploy: true });
    sessions.observeTopology("armed", "dead-runner", topology(target));
    sessions.armExternalEffects("armed", "dead-runner");
    advance(120_000);
    await orchestrator.resume("armed", "new-runner");
    const before = log.length;

    await expect(orchestrator.continueSession("armed", "new-runner", "FIX_FORWARD_ONLY"))
      .rejects.toThrow("FIX_FORWARD_DIRECTION_REQUIRED");
    // No deploy, no readiness, no capability: finishing an armed cutover again
    // would issue a second capability for a run that already started.
    expect(log.slice(before).filter((entry) => !entry.startsWith("observe"))).toEqual([]);
  });
});

