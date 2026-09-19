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

  it("requires recovery after one changed surface and permanently removes old-lineage rollback authority", () => {
    const sessions = new DeploySessions(new InMemoryDeploySessionStore(), () => new Date("2026-09-19T00:00:00.000Z"));
    const session = sessions.acquire({ id: "recovery", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target });
    sessions.fence(session.id, "owner", topology(old));
    sessions.beginDeploying(session.id, "owner");
    const partial = { ...topology(old), frontend: changed };
    expect(sessions.classifyFailure(session.id, "owner", partial)).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(sessions.classifyFailure(session.id, "owner", topology(old))).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
    expect(() => sessions.completeRollback(session.id, "owner", topology(old))).toThrow("OLD_LINEAGE_ROLLBACK_FORBIDDEN");
    expect(sessions.completeTarget(session.id, "owner", topology(target))).toMatchObject({ state: "SUCCEEDED", rollbackAuthority: "NEW_LINEAGE_ONLY" });
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
