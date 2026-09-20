import { describe, expect, it } from "vitest";
import { DeploySessions, InMemoryDeploySessionStore, type PreDeployTopology } from "../../src/release/deploy-session";

const target = "a".repeat(40);
const old = "b".repeat(40);
const changed = "c".repeat(40);
const topology = (sha: string): PreDeployTopology => ({ frontend: sha, admin: sha, commerce: sha, worker: sha });

describe("deploy sessions", () => {
  it("safe-aborts only when every surface remains exactly at its pre-deploy topology", () => {
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "safe", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    expect(sessions.fence(session.id, "owner", topology(old)).state).toBe("FENCED");
    sessions.beginDeploying(session.id, "owner");
    expect(sessions.classifyFailure(session.id, "owner", topology(old))).toMatchObject({ state: "SAFE_ABORTED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
  });

  it("requires recovery after one changed surface, and rolling back to the old topology is still legal", () => {
    // A half-switched topology is recoverable: nothing outside this system has
    // happened yet, so the archived database is still a truthful destination.
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "recovery", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
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
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "no-safe-abort", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
    sessions.beginDeploying(session.id, "owner");
    sessions.observeTopology(session.id, "owner", { ...topology(old), commerce: changed });
    expect(sessions.classifyFailure(session.id, "owner", topology(old)))
      .toMatchObject({ state: "RECOVERY_REQUIRED", mutationObserved: true });
  });

  it("converging on the target is not an external effect and keeps the old lineage available", () => {
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "converged", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
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
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "unarmed", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
    sessions.beginDeploying(session.id, "owner");
    expect(() => sessions.completeTarget(session.id, "owner", topology(target)))
      .toThrow("MAINTENANCE_CUTOVER_EXTERNAL_EFFECTS_NOT_ARMED");
    sessions.observeTopology(session.id, "owner", topology(target));
    sessions.armExternalEffects(session.id, "owner");
    expect(sessions.completeTarget(session.id, "owner", topology(target)))
      .toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
  });

  it("lets a rolling release close on convergence alone - it crosses no external boundary", () => {
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "rolling-complete", ownerId: "owner", mode: "ROLLING_SAFE", targetSha: target });
    sessions.beginDeploying(session.id, "owner", topology(old));
    expect(sessions.completeTarget(session.id, "owner", topology(target)))
      .toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
  });

  it("spends rollback authority when external effects are armed, and never returns it", () => {
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "external", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
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
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => clock, 1_000);
    const session = sessions.acquire({ id: "rolling", ownerId: "first", mode: "ROLLING_SAFE", targetSha: target });
    expect(() => sessions.fence(session.id, "first", topology(old))).toThrow("ROLLING_SAFE_DOES_NOT_FENCE_SALES");
    sessions.beginDeploying(session.id, "first", topology(old));
    clock = new Date("2026-09-19T00:00:02.000Z");
    expect(sessions.takeOverExpiredLease(session.id, "second")).toMatchObject({ state: "DEPLOYING", ownerId: "second" });
  });
});
