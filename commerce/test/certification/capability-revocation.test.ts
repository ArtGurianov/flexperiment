import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { capabilityBearerDefect, issueCapability } from "../../src/certification/capability";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import { DeploySessions } from "../../src/release/deploy-session";
import { SqliteReleaseAuthorityStore } from "../../src/release/deploy-session-store";
import { testSecret } from "../support/certification-secret";
import { snapshot } from "../support/deploy-snapshot";

/**
 * Revoking a capability early, only when carrying its session forward.
 *
 * `retired_at` already means "never usable again": every bearer check refuses
 * it on any runtime, and the live slot stops counting it. What changes is who
 * may set it before expiry - nobody, except a forward supersession of an
 * armed, stuck, fenced session, for a capability of its current binding. These
 * are the schema's own rules, so they hold against any writer, not just the
 * store.
 */

const predecessor = "a".repeat(40);
const original = "b".repeat(40);
const forward = "c".repeat(40);
const SESSION = "armed";

let db: Database.Database;
let sessions: DeploySessions;
let capabilities: SqliteCertificationCapabilityStore;

const issue = (releaseSha = original, runId = "run", ttlMs = 4 * 60 * 60_000) => {
  new SqliteCertificationRunStore(db).create({ runId, revision: 1, releaseSha, phase: "NEW", direction: "NORMAL", startedAt: new Date().toISOString() });
  return issueCapability(capabilities, { runId, deploymentSessionId: SESSION, releaseSha, maxAmountKopecks: 100, ttlMs }, new Date(), testSecret());
};

const revokeRaw = (id: string, reason: string | null) =>
  db.prepare(`UPDATE certification_capabilities SET retired_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), retirement_reason = ? WHERE id = ?`).run(reason, id);

/** Attempt 5's session: armed, then stuck. */
const armAndStick = () => {
  sessions.observeTopology(SESSION, "owner", snapshot(original));
  sessions.armExternalEffects(SESSION, "owner");
  sessions.enterRecoveryRequired(SESSION, "owner");
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  sessions = new DeploySessions(new SqliteReleaseAuthorityStore(db), () => new Date(), 5 * 60_000);
  sessions.acquireFenced({ id: SESSION, ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: original, candidateId: original }, snapshot(predecessor));
  sessions.beginDeploying(SESSION, "owner");
  capabilities = new SqliteCertificationCapabilityStore(db);
});

describe("early revocation by forward supersession", () => {
  it("retires a live, unspent capability of the current binding at once, and every bearer check then refuses it", () => {
    armAndStick();
    const { capability, nonce } = issue();
    capabilities.revokeForForwardSupersession(capability.id, SESSION);

    const revoked = capabilities.get(capability.id)!;
    expect(revoked).toMatchObject({ retirementReason: "FORWARD_SUPERSESSION", consumedAt: null });
    expect(revoked.retiredAt).not.toBeNull();
    expect(capabilityBearerDefect(revoked, { capabilityId: capability.id, runId: "run", nonce },
      { deploymentSessionId: SESSION, runtimeReleaseSha: original }, { runId: "run", releaseSha: original }, new Date()))
      .toBe("CERTIFICATION_CAPABILITY_RETIRED");
    // The slot is free: the next revision can be issued its own.
    expect(() => issue(forward, "run-r1")).not.toThrow();
  });

  it("refuses while the session could still roll back, or is not stuck", () => {
    // DEPLOYING, OLD_LINEAGE_ALLOWED.
    const { capability } = issue();
    expect(() => revokeRaw(capability.id, "FORWARD_SUPERSESSION")).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
    sessions.enterRecoveryRequired(SESSION, "owner");
    // Stuck, but not armed.
    expect(() => revokeRaw(capability.id, "FORWARD_SUPERSESSION")).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
    expect(capabilities.get(capability.id)?.retiredAt).toBeNull();
  });

  it("refuses a capability that is not of the session's current binding", () => {
    armAndStick();
    const { capability } = issue(original);
    // The session is carried to `forward`: `original`'s capability is no
    // longer the current binding's, so it is not this reason's to end.
    sessions.appendForwardTarget(SESSION, "owner", { targetSha: forward, candidateId: forward, ciEvidence: "{}" });
    expect(() => revokeRaw(capability.id, "FORWARD_SUPERSESSION")).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("never retires a spent capability", () => {
    armAndStick();
    const { capability } = issue();
    capabilities.spend(capability.id, new Date());
    expect(() => capabilities.revokeForForwardSupersession(capability.id, SESSION)).toThrow("CERTIFICATION_CAPABILITY_NOT_REVOCABLE");
    expect(() => revokeRaw(capability.id, "FORWARD_SUPERSESSION")).toThrow(/CERTIFICATION_CAPABILITY/);
  });

  it("stamps with the database's clock, never a caller's", () => {
    armAndStick();
    const { capability } = issue();
    expect(() => db.prepare("UPDATE certification_capabilities SET retired_at = '2026-01-01T00:00:00.000Z', retirement_reason = 'FORWARD_SUPERSESSION' WHERE id = ?").run(capability.id))
      .toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });
});

describe("natural retirement is unchanged", () => {
  it("refuses replacement, or a writer stating no reason, before expiry", () => {
    armAndStick();
    const { capability } = issue();
    expect(() => revokeRaw(capability.id, "EXPIRED_REPLACED")).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
    expect(() => revokeRaw(capability.id, null)).toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_PREMATURE");
  });

  it("records EXPIRED_REPLACED when an expired capability is replaced", () => {
    const { capability } = issueCapability(capabilities, { runId: (new SqliteCertificationRunStore(db).create({ runId: "old", revision: 1, releaseSha: original, phase: "NEW", direction: "NORMAL", startedAt: "2020-01-01T00:00:00.000Z" })).runId, deploymentSessionId: SESSION, releaseSha: original, maxAmountKopecks: 100, ttlMs: 60_000 }, new Date("2020-01-01T00:00:00.000Z"), testSecret());
    issue(original, "new");
    expect(capabilities.get(capability.id)).toMatchObject({ retirementReason: "EXPIRED_REPLACED" });
  });
});

describe("the retirement reason is part of the ending", () => {
  it("cannot be set without retiring, or changed afterwards", () => {
    armAndStick();
    const { capability } = issue();
    expect(() => db.prepare("UPDATE certification_capabilities SET retirement_reason = 'FORWARD_SUPERSESSION' WHERE id = ?").run(capability.id))
      .toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_REASON_IMMUTABLE");
    capabilities.revokeForForwardSupersession(capability.id, SESSION);
    expect(() => db.prepare("UPDATE certification_capabilities SET retirement_reason = 'EXPIRED_REPLACED' WHERE id = ?").run(capability.id))
      .toThrow("CERTIFICATION_CAPABILITY_RETIREMENT_REASON_IMMUTABLE");
  });
});

describe("revocation and the forward revision commit together", () => {
  it("rolls the revocation back when the revision's transaction fails", () => {
    armAndStick();
    const { capability } = issue();
    expect(() => sessions.appendForwardTarget(SESSION, "owner", { targetSha: forward, candidateId: forward, ciEvidence: "{}" }, () => {
      capabilities.revokeForForwardSupersession(capability.id, SESSION);
      throw new Error("PROCESS_DIED_MID_COMMIT");
    })).toThrow("PROCESS_DIED_MID_COMMIT");
    expect(capabilities.get(capability.id)?.retiredAt).toBeNull();
    expect(sessions.forwardTargets(SESSION)).toEqual([]);
  });

  it("commits both when it succeeds", () => {
    armAndStick();
    const { capability } = issue();
    sessions.appendForwardTarget(SESSION, "owner", { targetSha: forward, candidateId: forward, ciEvidence: "{}" }, () => {
      capabilities.revokeForForwardSupersession(capability.id, SESSION);
    });
    expect(capabilities.get(capability.id)?.retirementReason).toBe("FORWARD_SUPERSESSION");
    expect(sessions.binding(SESSION)).toMatchObject({ revision: 1, targetSha: forward });
  });
});
