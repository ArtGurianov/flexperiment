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
    expect(sessions.completeTarget(session.id, "owner", topology(target)))
      .toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "OLD_LINEAGE_ALLOWED" });
  });

  it("spends rollback authority only on a durable external effect, and never returns it", () => {
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "external", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
    sessions.beginDeploying(session.id, "owner");
    sessions.classifyFailure(session.id, "owner", { ...topology(old), worker: changed });

    // A real payment has now been taken against the new lineage.
    expect(sessions.commitExternalEffects(session.id, "owner")).toMatchObject({ rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(sessions.commitExternalEffects(session.id, "owner")).toMatchObject({ rollbackAuthority: "NEW_LINEAGE_ONLY" });
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
