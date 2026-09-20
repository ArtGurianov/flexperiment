import { describe, expect, it } from "vitest";
import { DeploySessions, type PreDeployTopology } from "../../src/release/deploy-session";
import { releaseAuthorityStores } from "../support/release-authority-stores";

const target = "a".repeat(40);
const old = "b".repeat(40);
const changed = "c".repeat(40);
const topology = (sha: string): PreDeployTopology => ({ frontend: sha, admin: sha, commerce: sha, worker: sha });

describe.each(releaseAuthorityStores)("deploy sessions (%s)", (_name, makeStore) => {
  it("safe-aborts only when every surface remains exactly at its pre-deploy topology", () => {
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "safe", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(session.state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    expect(sessions.classifyFailure(session.id, "owner", topology(old))).toMatchObject({ state: "SAFE_ABORTED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
  });

  it("requires recovery after one changed surface, and rolling back to the old topology is still legal", () => {
    // A half-switched topology is recoverable: nothing outside this system has
    // happened yet, so the archived database is still a truthful destination.
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "recovery", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(session.state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    const partial = { ...topology(old), frontend: changed };
    expect(sessions.classifyFailure(session.id, "owner", partial))
      .toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "OLD_LINEAGE_ALLOWED", mutationObserved: true });
    expect(sessions.completeRollback(session.id, "owner", topology(old)))
      .toMatchObject({ state: "ROLLED_BACK", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
  });

  it("never offers a safe abort again once any surface was observed to move", () => {
    // Restoring the old topology by hand does not turn a mutation into a
    // deploy that never touched production.
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "no-safe-abort", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(session.state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    sessions.observeTopology(session.id, "owner", { ...topology(old), commerce: changed });
    expect(sessions.classifyFailure(session.id, "owner", topology(old)))
      .toMatchObject({ state: "RECOVERY_REQUIRED", mutationObserved: true });
  });

  it("converging on the target is not an external effect and keeps the old lineage available", () => {
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "converged", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(session.state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    // Every surface is on the target, and the archived database is still a
    // truthful destination: nothing has left this system yet.
    expect(sessions.observeTopology(session.id, "owner", topology(target)))
      .toMatchObject({ state: "DEPLOYING", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
    expect(sessions.completeRollback(session.id, "owner", topology(old))).toMatchObject({ state: "ROLLED_BACK" });
  });

  it("refuses to close a maintenance cutover that never armed its irreversible boundary", () => {
    // SUCCEEDED is terminal and a terminal session can arm nothing, so closing
    // on convergence alone would make the certification ordering unrecordable.
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "unarmed", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(session.state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    expect(() => sessions.completeTarget(session.id, "owner", topology(target)))
      .toThrow("MAINTENANCE_CUTOVER_EXTERNAL_EFFECTS_NOT_ARMED");
    sessions.observeTopology(session.id, "owner", topology(target));
    sessions.armExternalEffects(session.id, "owner");
    expect(sessions.completeTarget(session.id, "owner", topology(target)))
      .toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
  });

  it("lets a rolling release close on convergence alone - it crosses no external boundary", () => {
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireRolling({ id: "rolling-complete", ownerId: "owner", mode: "ROLLING_SAFE", targetSha: target }, topology(old));
    expect(sessions.completeTarget(session.id, "owner", topology(target)))
      .toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
  });

  it("spends rollback authority when external effects are armed, and never returns it", () => {
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "external", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(session.state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    sessions.classifyFailure(session.id, "owner", { ...topology(old), worker: changed });
    // Recovery went forward: every surface now serves the target, which is what
    // makes arming certification on this session meaningful at all.
    expect(() => sessions.armExternalEffects(session.id, "owner")).toThrow("TARGET_TOPOLOGY_NOT_OBSERVED");
    sessions.observeTopology(session.id, "owner", topology(target));

    // Arming happens BEFORE the ruble leaves, so a crash mid-payment can never
    // find a session that still calls the archived database truthful.
    expect(sessions.armExternalEffects(session.id, "owner")).toMatchObject({ rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(sessions.armExternalEffects(session.id, "owner")).toMatchObject({ rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(() => sessions.completeRollback(session.id, "owner", topology(old))).toThrow("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    // Forward is the only way out.
    expect(sessions.completeTarget(session.id, "owner", topology(target)))
      .toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
  });

  it("does not close sales for rolling releases and transfers expired ownership without changing state", () => {
    let clock = new Date("2026-09-19T00:00:00.000Z");
    const store = makeStore();
    const sessions = new DeploySessions(store, () => clock, 1_000);
    expect(() => sessions.acquireFenced({ id: "not-rolling", ownerId: "first", mode: "ROLLING_SAFE", targetSha: target }, topology(old)))
      .toThrow("ROLLING_SAFE_DOES_NOT_FENCE_SALES");
    const session = sessions.acquireRolling({ id: "rolling", ownerId: "first", mode: "ROLLING_SAFE", targetSha: target }, topology(old));
    clock = new Date("2026-09-19T00:00:02.000Z");
    expect(sessions.takeOverExpiredLease(session.id, "second")).toMatchObject({ state: "DEPLOYING", ownerId: "second" });
  });

  it("admits one deployment session at a time, whatever its mode", () => {
    // Production has one topology. A workflow concurrency group is an
    // operational guard a takeover or a hand-run script can step around; this
    // is the authority, and it has to stay right when they do.
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-20T00:00:00.000Z"));
    sessions.acquireFenced({ id: "first", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));

    expect(() => sessions.acquireFenced({ id: "second", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old)))
      .toThrow("DEPLOY_SESSION_ALREADY_ACTIVE");
    expect(() => sessions.acquireRolling({ id: "third", ownerId: "owner", mode: "ROLLING_SAFE", targetSha: target }, topology(old)))
      .toThrow("DEPLOY_SESSION_ALREADY_ACTIVE");
  });

  it("refuses a maintenance session while a rolling one is still in flight", () => {
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-20T00:00:00.000Z"));
    sessions.acquireRolling({ id: "rolling-first", ownerId: "owner", mode: "ROLLING_SAFE", targetSha: target }, topology(old));

    expect(store.deploymentGate()).toEqual({ closed: false, deploymentSessionId: null });
    expect(() => sessions.acquireFenced({ id: "cutover", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old)))
      .toThrow("DEPLOY_SESSION_ALREADY_ACTIVE");
  });

  it("lets only the session that closed the gate reopen it", () => {
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-20T00:00:00.000Z"));
    const owner = sessions.acquireFenced({ id: "owner-session", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    expect(store.deploymentGate()).toEqual({ closed: true, deploymentSessionId: owner.id });

    // A settle aimed at any other session cannot release the gate on its
    // behalf, whatever state it claims to be in. An id nobody acquired is
    // refused as missing rather than as inactive - the two are different
    // things to be told, and only one of them is true here.
    expect(() => store.settle("someone-else", "owner", new Date("2026-09-20T00:00:00.000Z"), ["DEPLOYING"], "SUCCEEDED"))
      .toThrow("DEPLOY_SESSION_NOT_FOUND");
    expect(store.deploymentGate().closed).toBe(true);
  });

  it("makes a terminal state unreachable except through settle", () => {
    // Otherwise a caller reaches SUCCEEDED through ordinary progress and the
    // gate is never released at all - the exact state settle exists to prevent.
    const store = makeStore();
    const sessions = new DeploySessions(store, () => new Date("2026-09-20T00:00:00.000Z"));
    const session = sessions.acquireFenced({ id: "terminal-bypass", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    sessions.beginDeploying(session.id, "owner");

    expect(() => store.transitionNonTerminal(session.id, "owner", new Date("2026-09-20T00:00:00.000Z"), ["DEPLOYING"], { state: "SUCCEEDED" }))
      .toThrow("TERMINAL_STATE_REQUIRES_SETTLE");
    expect(store.deploymentGate()).toEqual({ closed: true, deploymentSessionId: session.id });
  });

  it("refuses a session whose initial state contradicts its own mode", () => {
    // The gate follows from the mode, so a maintenance session that starts
    // unfenced, or a rolling one that starts fenced, has no coherent meaning.
    const store = makeStore();
    const blank = {
      id: "mismatched", ownerId: "owner", targetSha: target, rollbackAuthority: "OLD_LINEAGE_ALLOWED" as const,
      mutationObserved: false, createdAt: "2026-09-20T00:00:00.000Z", leaseExpiresAt: "2026-09-20T00:05:00.000Z",
      preDeployTopology: topology(old),
    };
    expect(() => store.acquire({ ...blank, mode: "MAINTENANCE_CUTOVER", state: "DEPLOYING" }))
      .toThrow("DEPLOY_SESSION_INITIAL_STATE_INVALID");
    expect(() => store.acquire({ ...blank, mode: "ROLLING_SAFE", state: "FENCED" }))
      .toThrow("DEPLOY_SESSION_INITIAL_STATE_INVALID");
    expect(store.deploymentGate()).toEqual({ closed: false, deploymentSessionId: null });
  });

  it("settles ownership inside the write, so two runners cannot both win a takeover", () => {
    // Reading the lease and then acting on it is two steps, and both readers
    // pass the read. Production SQL makes this one guarded UPDATE whose
    // changes === 1 is the only proof, so the contract demands it here too.
    let clock = new Date("2026-09-20T00:00:00.000Z");
    const store = makeStore();
    const sessions = new DeploySessions(store, () => clock, 60_000);
    const session = sessions.acquireFenced({ id: "contended", ownerId: "first", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    clock = new Date(clock.getTime() + 120_000);

    expect(sessions.takeOverExpiredLease(session.id, "second").ownerId).toBe("second");
    // The lease is live again, so the loser of the race is refused rather than
    // silently becoming a second owner of the same production topology.
    expect(() => sessions.takeOverExpiredLease(session.id, "third")).toThrow("DEPLOY_SESSION_LEASE_NOT_EXPIRED");
  });

  it("refuses a write from the runner whose lease was taken away", () => {
    let clock = new Date("2026-09-20T00:00:00.000Z");
    const store = makeStore();
    const sessions = new DeploySessions(store, () => clock, 60_000);
    const session = sessions.acquireFenced({ id: "displaced", ownerId: "first", mode: "MAINTENANCE_CUTOVER", targetSha: target }, topology(old));
    sessions.beginDeploying(session.id, "first");
    clock = new Date(clock.getTime() + 120_000);
    sessions.takeOverExpiredLease(session.id, "second");

    // The displaced runner may still be alive and mid-sequence. Every mutation
    // it attempts has to fail, not just the ones a caller remembered to guard.
    expect(() => sessions.observeTopology(session.id, "first", topology(old))).toThrow("DEPLOY_SESSION_NOT_OWNER");
    expect(() => sessions.armExternalEffects(session.id, "first")).toThrow("DEPLOY_SESSION_NOT_OWNER");
    expect(() => sessions.completeTarget(session.id, "first", topology(target))).toThrow("DEPLOY_SESSION_NOT_OWNER");
  });
});
