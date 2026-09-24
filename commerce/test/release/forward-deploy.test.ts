import { describe, expect, it } from "vitest";
import type { ReleaseCandidate } from "../../src/release/candidate";
import { DeploySessions, InMemoryReleaseAuthorityStore } from "../../src/release/deploy-session";
import { ForwardDeploy, type ForwardDeployPorts } from "../../src/release/forward-deploy";
import Database from "better-sqlite3";
import { migrate } from "../../src/db";
import { supersessionDefect } from "../../src/release/supersession-safety";
import { snapshot } from "../support/deploy-snapshot";

/**
 * `forward-deploy`, decided from durable state: which mode, what it refuses
 * before the first write, and where it resumes from every boundary after it.
 *
 * Real sessions over the in-memory authority; every other port records what
 * was asked of it, so the tests can say exactly what moved.
 */

const predecessor = "a".repeat(40);
const original = "b".repeat(40);
const forward = "c".repeat(40);
const later = "d".repeat(40);
const now = new Date("2026-09-24T12:00:00.000Z");

const candidate = (sha: string): ReleaseCandidate => ({
  id: sha, sha, releaseClass: "MAINTENANCE_REQUIRED",
  expectation: { schemaInventory: `inventory-sha256:${"1".repeat(64)}`, legalVersion: "2026-08-28.1", legalManifestSha256: "2".repeat(64) },
});

const world = (options: { pointer?: string; serving?: string } = {}) => {
  const store = new InMemoryReleaseAuthorityStore();
  const sessions = new DeploySessions(store, () => now, 5 * 60_000);
  sessions.acquireFenced({ id: "armed", ownerId: "deploy-a", mode: "MAINTENANCE_CUTOVER", targetSha: original, candidateId: original }, snapshot(predecessor));
  sessions.beginDeploying("armed", "deploy-a");
  sessions.observeTopology("armed", "deploy-a", snapshot(original));
  sessions.armExternalEffects("armed", "deploy-a");
  sessions.enterRecoveryRequired("armed", "deploy-a");
  sessions.yieldLease("armed", "deploy-a");

  const log: string[] = [];
  let pointer = options.pointer ?? original;
  let serving = options.serving ?? original;
  const runs = new Set<string>();
  const published = new Map([forward, later].map((sha) => [sha, candidate(sha)]));
  const state = {
    unsafe: undefined as string | undefined,
    /** When set, the safety predicate the world answers with instead of `unsafe`. */
    defect: undefined as ((sessionId: string, releaseSha: string) => string | undefined) | undefined,
    live: undefined as { id: string; releaseSha: string; expiresAt: string } | undefined,
    revokeFails: false,
    unknown: [] as string[],
    admission: async (value: ReleaseCandidate) => { log.push(`admit:${value.sha}`); return { ciEvidence: `ci:${value.sha}` }; },
    migrate: () => { log.push("migrate"); },
    deployFails: false,
  };
  const ports: ForwardDeployPorts = {
    sessions,
    gate: () => store.deploymentGate(),
    candidates: { get: (id) => published.get(id) },
    admission: { admit: (value) => state.admission(value) },
    supersessionDefect: (sessionId, releaseSha) => (state.defect ? state.defect(sessionId, releaseSha) : state.unsafe),
    liveCapability: () => state.live,
    revokeCapability: (capabilityId) => {
      if (state.revokeFails) throw new Error("CERTIFICATION_CAPABILITY_NOT_REVOCABLE");
      log.push(`revoke:${capabilityId}`);
    },
    migrate: () => state.migrate(),
    unknownMigrations: () => state.unknown,
    refs: { read: async () => pointer },
    deployment: {
      async deployFrom(from, to) {
        if (pointer !== from) throw new Error("DEPLOY_REF_LEASE_REFUSED");
        log.push(`cas:${from}->${to}`); pointer = to;
        if (state.deployFails) throw new Error("DEPLOYMENT_FAILED: commerce");
        log.push(`deploy:${to}`); serving = to;
      },
      async redeployAt(sha) { if (pointer !== sha) throw new Error("DEPLOY_REF_NOT_AT_TARGET"); log.push(`redeploy:${sha}`); serving = sha; },
    },
    topology: { observe: async () => snapshot(serving) },
    revisionRunExists: (_session, revision) => runs.has(`r${revision}`),
    finishForward: async (sessionId, request) => {
      log.push(`finish:${request.candidate.sha}`);
      runs.add(`r${sessions.binding(sessionId).revision}`);
      return { kind: "AWAITING_OPERATOR", session: sessions.read(sessionId)!, capability: {} as never };
    },
    journal: { record: (event) => log.push(`journal:${event}`) },
  };
  return { sessions, log, state, ports, runner: new ForwardDeploy(ports), pointer: () => pointer, runs };
};

describe("a new forward revision", () => {
  it("admits, migrates, commits the revision, moves the pointer from its own from_sha, and hands over", async () => {
    const { runner, sessions, log, pointer } = world();
    const outcome = await runner.run("armed", forward, "operator");

    expect(outcome.kind).toBe("AWAITING_OPERATOR");
    expect(sessions.binding("armed")).toEqual({ revision: 1, targetSha: forward, candidateId: forward });
    expect(sessions.forwardTargets("armed")[0]).toMatchObject({ fromSha: original, targetSha: forward, ciEvidence: `ci:${forward}` });
    expect(pointer()).toBe(forward);
    expect(log.filter((entry) => !entry.startsWith("journal:"))).toEqual([
      `admit:${forward}`, "migrate", `cas:${original}->${forward}`, `deploy:${forward}`, `finish:${forward}`,
    ]);
    // Still armed, still in recovery, still fenced: only certify settles it.
    expect(sessions.read("armed")).toMatchObject({ state: "RECOVERY_REQUIRED", rollbackAuthority: "NEW_LINEAGE_ONLY", targetSha: original });
  });

  it.each([
    ["admission refuses", (w: ReturnType<typeof world>) => { w.state.admission = async () => { throw new Error("FORWARD_DEPLOY_ADMISSION_REFUSED: not main"); }; }, "FORWARD_DEPLOY_ADMISSION_REFUSED"],
    ["the prior target is not safe to leave", (w: ReturnType<typeof world>) => { w.state.unsafe = "PAYMENT_UNRESOLVED:p1"; }, "FORWARD_DEPLOY_PRIOR_TARGET_NOT_SAFE"],
    ["a live capability belongs to some other release", (w: ReturnType<typeof world>) => { w.state.live = { id: "cap-other", releaseSha: later, expiresAt: "2026-09-24T16:00:00.000Z" }; }, "FORWARD_DEPLOY_CAPABILITY_STILL_LIVE"],
    ["the database carries a migration the candidate does not", (w: ReturnType<typeof world>) => { w.state.unknown = ["0005_other.sql"]; }, "FORWARD_DEPLOY_MIGRATIONS_NOT_CARRIED"],
  ])("refuses before the first durable write when %s", async (_label, arrange, code) => {
    const w = world();
    arrange(w);
    await expect(w.runner.run("armed", forward, "operator")).rejects.toThrow(code);
    expect(w.log).not.toContain("migrate");
    expect(w.sessions.forwardTargets("armed")).toEqual([]);
    expect(w.pointer()).toBe(original);
    // And it stood down: another process may claim the session at once, with
    // no clock advance, instead of waiting out a lease nobody holds.
    expect(() => w.sessions.takeOverExpiredLease("armed", "next-process")).not.toThrow();
  });

  it("refuses an unpublished candidate, and a session that is not armed and stuck", async () => {
    const w = world();
    await expect(w.runner.run("armed", "e".repeat(40), "operator")).rejects.toThrow("RELEASE_CANDIDATE_NOT_PUBLISHED");
    expect(() => w.sessions.takeOverExpiredLease("armed", "next-process")).not.toThrow();

    const store = new InMemoryReleaseAuthorityStore();
    const sessions = new DeploySessions(store, () => now);
    sessions.acquireFenced({ id: "armed", ownerId: "a", mode: "MAINTENANCE_CUTOVER", targetSha: original, candidateId: original }, snapshot(predecessor));
    const unarmed = new ForwardDeploy({ ...w.ports, sessions, gate: () => store.deploymentGate() });
    await expect(unarmed.run("armed", forward, "a")).rejects.toThrow("FORWARD_DEPLOY_SESSION_NOT_SUPERSEDABLE");
  });

  it("refuses to take a session a live runner still holds", async () => {
    const w = world();
    w.sessions.takeOverExpiredLease("armed", "someone-running");
    await expect(w.runner.run("armed", forward, "operator")).rejects.toThrow("DEPLOY_SESSION_HELD_BY_ANOTHER_RUNNER");
  });
});

describe("a live capability of the target being left", () => {
  it("is revoked inside the revision's own commit, so no wait for its TTL", async () => {
    const w = world();
    w.state.live = { id: "cap-a2", releaseSha: original, expiresAt: "2026-09-24T16:00:00.000Z" };
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
    const steps = w.log.filter((entry) => !entry.startsWith("journal:"));
    // After migration, inside the append, before the pointer moves.
    expect(steps.slice(0, 4)).toEqual([`admit:${forward}`, "migrate", "revoke:cap-a2", `cas:${original}->${forward}`]);
    expect(w.sessions.binding("armed").revision).toBe(1);
  });

  it("is not revoked, and no revision is recorded, when the commit fails", async () => {
    const w = world();
    w.state.live = { id: "cap-a2", releaseSha: original, expiresAt: "2026-09-24T16:00:00.000Z" };
    w.state.revokeFails = true;
    const outcome = await w.runner.run("armed", forward, "operator");
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: expect.stringContaining("FORWARD_DEPLOY_REVISION_NOT_COMMITTED") });
    expect(w.sessions.forwardTargets("armed")).toEqual([]);
    expect(w.pointer()).toBe(original);
  });

  it("re-proves safety inside the commit, and refuses if it changed after admission", async () => {
    const w = world();
    let checks = 0;
    w.state.defect = () => (checks++ === 0 ? undefined : "PAYMENT_UNRESOLVED:late");
    w.state.live = { id: "cap-a2", releaseSha: original, expiresAt: "2026-09-24T16:00:00.000Z" };
    const outcome = await w.runner.run("armed", forward, "operator");
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: expect.stringContaining("PAYMENT_UNRESOLVED:late") });
    expect(w.log).not.toContain("revoke:cap-a2");
    expect(w.sessions.forwardTargets("armed")).toEqual([]);
  });
});

describe("the crash seam between migration and revision", () => {
  it("reports recovery, commits nothing, and a rerun re-admits and commits", async () => {
    const w = world();
    const append = w.sessions.appendForwardTarget.bind(w.sessions);
    let crash = true;
    w.sessions.appendForwardTarget = (...args) => {
      if (crash) { crash = false; throw new Error("PROCESS_DIED"); }
      return append(...args);
    };
    const first = await w.runner.run("armed", forward, "operator");
    expect(first).toMatchObject({ kind: "RECOVERY_REQUIRED", code: expect.stringContaining("FORWARD_DEPLOY_REVISION_NOT_COMMITTED") });
    expect(w.sessions.forwardTargets("armed")).toEqual([]);
    expect(w.pointer()).toBe(original);

    // No target was committed, so the next run is a NEW revision again: full
    // admission, migrations re-applied idempotently, then the append.
    w.log.length = 0;
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
    expect(w.log.filter((entry) => !entry.startsWith("journal:"))[0]).toBe(`admit:${forward}`);
    expect(w.sessions.binding("armed").revision).toBe(1);
  });
});

describe("resuming a committed revision", () => {
  /** Revision 1 committed, then the process died before the pointer moved. */
  const committed = (options: Parameters<typeof world>[0] = {}) => {
    const w = world(options);
    w.sessions.takeOverExpiredLease("armed", "died");
    w.sessions.appendForwardTarget("armed", "died", { targetSha: forward, candidateId: forward, ciEvidence: "ci" });
    w.sessions.yieldLease("armed", "died");
    // From here on, admission must never be asked again.
    w.state.admission = async () => { throw new Error("ADMISSION_MUST_NOT_RUN_ON_RESUME"); };
    return w;
  };

  it("pointer still at from_sha: CAS from exactly there, then continue", async () => {
    const w = committed();
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
    expect(w.log).toContain(`cas:${original}->${forward}`);
    expect(w.log).not.toContain("migrate");
  });

  it("pointer already at target, runtime not yet: redeploy without moving the pointer", async () => {
    const w = committed({ pointer: forward, serving: original });
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
    expect(w.log).toContain(`redeploy:${forward}`);
    expect(w.log.some((entry) => entry.startsWith("cas:"))).toBe(false);
  });

  it("pointer and runtime already at target: straight to readiness and issuance", async () => {
    const w = committed({ pointer: forward, serving: forward });
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
    expect(w.log.filter((entry) => entry.startsWith("cas:") || entry.startsWith("redeploy:") || entry.startsWith("deploy:"))).toEqual([]);
    expect(w.log).toContain(`finish:${forward}`);
  });

  it("pointer anywhere else: never a CAS from whatever is there", async () => {
    const w = committed({ pointer: later });
    const outcome = await w.runner.run("armed", forward, "operator");
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: `FORWARD_DEPLOY_REF_DIVERGED:${later}` });
    expect(w.pointer()).toBe(later);
    expect(w.log.some((entry) => entry.startsWith("cas:") || entry.startsWith("redeploy:"))).toBe(false);
  });

  it("revision's certification run already exists: nothing to do but hand over", async () => {
    const w = committed({ pointer: forward, serving: forward });
    w.runs.add("r1");
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("ALREADY_AWAITING_OPERATOR");
    expect(w.log.some((entry) => entry.startsWith("finish:"))).toBe(false);
  });

  it("a deploy failure after the pointer moved is recovery, not a refusal", async () => {
    const w = committed();
    w.state.deployFails = true;
    const outcome = await w.runner.run("armed", forward, "operator");
    expect(outcome).toMatchObject({ kind: "RECOVERY_REQUIRED", code: "DEPLOYMENT_FAILED: commerce" });
    // The pointer moved; the next run resumes from "already at target".
    expect(w.pointer()).toBe(forward);
    w.state.deployFails = false;
    expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
    expect(w.log).toContain(`redeploy:${forward}`);
  });

  describe("a revision deployed but never certified - no -r<N> run or capability exists", () => {
    /** The real predicate, over a database holding no certification for revision 1's release. */
    const uncertified = () => {
      const w = committed({ pointer: forward, serving: forward });
      const db = new Database(":memory:");
      migrate(db);
      w.state.defect = (sessionId, releaseSha) => supersessionDefect(db, sessionId, releaseSha);
      w.state.admission = async (value) => { w.log.push(`admit:${value.sha}`); return { ciEvidence: `ci:${value.sha}` }; };
      return w;
    };

    it("refuses a newer candidate: no revision, no migration, no pointer move, and the lease stood down", async () => {
      const w = uncertified();
      await expect(w.runner.run("armed", later, "operator")).rejects.toThrow(`FORWARD_DEPLOY_PRIOR_TARGET_NOT_SAFE: CERTIFICATION_NOT_STARTED:${forward}`);
      expect(w.sessions.forwardTargets("armed").map((target) => target.revision)).toEqual([1]);
      expect(w.log).not.toContain("migrate");
      expect(w.pointer()).toBe(forward);
      expect(() => w.sessions.takeOverExpiredLease("armed", "next-process")).not.toThrow();
    });

    it("resumes it with the same candidate: readiness and its own capability, never a supersession", async () => {
      const w = uncertified();
      expect((await w.runner.run("armed", forward, "operator")).kind).toBe("AWAITING_OPERATOR");
      expect(w.log.some((entry) => entry.startsWith("admit:"))).toBe(false);
      expect(w.log).toContain(`finish:${forward}`);
      expect(w.sessions.forwardTargets("armed").map((target) => target.revision)).toEqual([1]);
    });
  });

  it("a different candidate while the committed revision stands is a NEW revision, admitted in full", async () => {
    const w = committed({ pointer: forward, serving: forward });
    w.state.admission = async (value) => { w.log.push(`admit:${value.sha}`); return { ciEvidence: `ci:${value.sha}` }; };
    expect((await w.runner.run("armed", later, "operator")).kind).toBe("AWAITING_OPERATOR");
    expect(w.log).toContain(`admit:${later}`);
    expect(w.sessions.forwardTargets("armed").map((target) => [target.revision, target.fromSha, target.targetSha])).toEqual([
      [1, original, forward], [2, forward, later],
    ]);
  });
});
