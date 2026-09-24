import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { DeploySessions, type ReleaseAuthorityStore } from "../../src/release/deploy-session";
import { SqliteReleaseAuthorityStore } from "../../src/release/deploy-session-store";
import { releaseAuthorityStores } from "../support/release-authority-stores";
import { snapshot } from "../support/deploy-snapshot";

/**
 * Carrying an armed session forward, at the release authority.
 *
 * The session's own target stays frozen; each forward revision is appended,
 * chained, and only by the session's live owner, and only while the session is
 * armed, stuck and fenced. Every reader that decides something about a target
 * reads the binding, not the frozen original.
 */

const predecessor = "a".repeat(40);
const original = "b".repeat(40);
const forward = "c".repeat(40);
const further = "d".repeat(40);
const now = new Date("2026-09-24T12:00:00.000Z");

/** Attempt 5's session: armed, fenced, in recovery, on its original target. */
const armedAndStuck = (store: ReleaseAuthorityStore, clock = () => now) => {
  const sessions = new DeploySessions(store, clock, 5 * 60_000);
  const session = sessions.acquireFenced(
    { id: "armed", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: original, candidateId: original },
    snapshot(predecessor),
  );
  sessions.beginDeploying(session.id, "owner");
  sessions.observeTopology(session.id, "owner", snapshot(original));
  sessions.armExternalEffects(session.id, "owner");
  sessions.enterRecoveryRequired(session.id, "owner");
  return sessions;
};

const input = (targetSha = forward) => ({ targetSha, candidateId: targetSha, ciEvidence: `{"sha":"${targetSha}"}` });

describe.each(releaseAuthorityStores)("forward revisions of an armed session (%s)", (_name, makeStore) => {
  it("appends a chained revision and moves the binding, leaving the original target frozen", () => {
    const sessions = armedAndStuck(makeStore());
    expect(sessions.binding("armed")).toEqual({ revision: 0, targetSha: original, candidateId: original });

    const first = sessions.appendForwardTarget("armed", "owner", input());
    expect(first).toMatchObject({ revision: 1, fromSha: original, targetSha: forward, candidateId: forward });
    const second = sessions.appendForwardTarget("armed", "owner", input(further));
    expect(second).toMatchObject({ revision: 2, fromSha: forward, targetSha: further });

    expect(sessions.binding("armed")).toEqual({ revision: 2, targetSha: further, candidateId: further });
    expect(sessions.read("armed")).toMatchObject({ targetSha: original, candidateId: original });
    expect(sessions.forwardTargets("armed").map((target) => target.revision)).toEqual([1, 2]);
  });

  it("refuses a caller that does not own the session, or whose lease has lapsed", () => {
    const store = makeStore();
    let clock = now;
    const sessions = armedAndStuck(store, () => clock);
    expect(() => sessions.appendForwardTarget("armed", "someone-else", input())).toThrow("DEPLOY_SESSION_NOT_OWNER");
    clock = new Date(now.getTime() + 6 * 60_000);
    expect(() => sessions.appendForwardTarget("armed", "owner", input())).toThrow("DEPLOY_SESSION_LEASE_EXPIRED");
    expect(sessions.forwardTargets("armed")).toEqual([]);
  });

  it("refuses a session that could still roll back, or is not stuck", () => {
    const sessions = new DeploySessions(makeStore(), () => now, 5 * 60_000);
    sessions.acquireFenced(
      { id: "unarmed", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: original, candidateId: original },
      snapshot(predecessor),
    );
    sessions.beginDeploying("unarmed", "owner");
    // DEPLOYING, not stuck.
    expect(() => sessions.appendForwardTarget("unarmed", "owner", input())).toThrow(/DEPLOY_SESSION_TRANSITION_INVALID|FORWARD_TARGET_SESSION_STATE/);
    sessions.enterRecoveryRequired("unarmed", "owner");
    // Stuck, but the old lineage is still a legal destination.
    expect(() => sessions.appendForwardTarget("unarmed", "owner", input())).toThrow("FORWARD_TARGET_SESSION_NOT_ARMED");
    expect(sessions.forwardTargets("unarmed")).toEqual([]);
  });

  it("refuses a revision to the release it is already on", () => {
    const sessions = armedAndStuck(makeStore());
    expect(() => sessions.appendForwardTarget("armed", "owner", input(original))).toThrow("FORWARD_TARGET_IS_CURRENT");
    sessions.appendForwardTarget("armed", "owner", input());
    expect(() => sessions.appendForwardTarget("armed", "owner", input())).toThrow("FORWARD_TARGET_IS_CURRENT");
  });

  it("arms and settles against the current binding, not the frozen original", () => {
    const sessions = armedAndStuck(makeStore());
    sessions.appendForwardTarget("armed", "owner", input());

    // The runtime still on the original: not the target any more.
    sessions.observeTopology("armed", "owner", snapshot(original));
    expect(() => sessions.armExternalEffects("armed", "owner")).toThrow("TARGET_TOPOLOGY_NOT_OBSERVED");
    expect(() => sessions.completeTarget("armed", "owner", snapshot(original))).toThrow("TARGET_TOPOLOGY_NOT_CONVERGED");

    // On the forward target: armed (already), and settles.
    sessions.observeTopology("armed", "owner", snapshot(forward));
    expect(sessions.armExternalEffects("armed", "owner").rollbackAuthority).toBe("NEW_LINEAGE_ONLY");
    expect(sessions.completeTarget("armed", "owner", snapshot(forward)).state).toBe("SUCCEEDED");
  });
});

describe("the schema's own backstop for forward revisions", () => {
  const sqlite = () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return { db, sessions: armedAndStuck(new SqliteReleaseAuthorityStore(db)) };
  };
  const insert = (db: Database.Database, revision: number, from: string, to: string) =>
    db.prepare(`INSERT INTO deploy_session_forward_targets(session_id, revision, from_sha, target_sha, candidate_id, ci_evidence)
      VALUES ('armed', ?, ?, ?, ?, '{}')`).run(revision, from, to, to);

  it("refuses a gap or a broken chain, whoever writes", () => {
    const { db } = sqlite();
    expect(() => insert(db, 2, original, forward)).toThrow("FORWARD_TARGET_CHAIN_BROKEN");
    expect(() => insert(db, 1, predecessor, forward)).toThrow("FORWARD_TARGET_CHAIN_BROKEN");
    insert(db, 1, original, forward);
    expect(() => insert(db, 2, original, further)).toThrow("FORWARD_TARGET_CHAIN_BROKEN");
  });

  it("never rewrites or removes a revision", () => {
    const { db, sessions } = sqlite();
    sessions.appendForwardTarget("armed", "owner", input());
    expect(() => db.prepare("UPDATE deploy_session_forward_targets SET target_sha = ?").run(further)).toThrow("FORWARD_TARGET_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM deploy_session_forward_targets").run()).toThrow("FORWARD_TARGET_IMMUTABLE");
  });

  it("refuses a revision for a session that is not armed and stuck, whoever writes", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    const sessions = new DeploySessions(new SqliteReleaseAuthorityStore(db), () => now);
    sessions.acquireFenced(
      { id: "armed", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: original, candidateId: original },
      snapshot(predecessor),
    );
    expect(() => insert(db, 1, original, forward)).toThrow("FORWARD_TARGET_SESSION_NOT_SUPERSEDABLE");
  });
});
