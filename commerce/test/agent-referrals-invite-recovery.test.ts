import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { admin, fresh } from "./support/agent-referrals-settlement-fixtures";
import { randomUUID } from "node:crypto";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, reissuePartnerInvite } from "../src/agent-referrals-partner-identity";

/**
 * PR-C3: the last rollout blocker C2 left open.
 *
 * /partners/:id/invite/reissue returns a raw token that is never persisted,
 * so no idempotency mechanism can re-serve the original after a lost
 * response - which is why C2 classified it SPECIAL_RECOVERY rather than
 * proving it. The answer is not a key but a NAMED recovery command, and the
 * contract it has to meet is written here BEFORE the implementation.
 *
 * Written red on purpose, and in the order that forces the design: the
 * duplicate-recovery case comes first, because it is the one that cannot be
 * satisfied without predecessor binding.
 */

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const invitedPartner = (db: Database.Database) => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`)
    .run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const provisioned = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  return { partnerIdentityId: provisioned.partner_identity_id, inviteId: provisioned.invite_id };
};

const liveCapabilities = (db: Database.Database, partnerIdentityId: string) =>
  db.prepare(`SELECT id FROM partner_invite_capabilities
    WHERE partner_identity_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND superseded_by_id IS NULL`)
    .all(partnerIdentityId) as { id: string }[];

describe("invite recovery: an explicit, predecessor-bound command", () => {
  /**
   * FIRST, because it is the case that forces the design. Without
   * predecessor binding, two recovery calls for the SAME lost response give
   * T1 -> T2 -> T3: at every instant exactly one capability is live, so the
   * partial unique index is satisfied and nothing looks wrong - but the
   * operator who was handed T2 finds it already destroyed by the second
   * recovery. "Exactly one live" is not the invariant; "recovery is bound to
   * the capability whose response was lost" is.
   */
  it("a second recovery pinned to the SAME predecessor does not supersede the first recovery's capability", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const first = recoverPartnerInvite(db, admin, partnerIdentityId, t1, "response lost");
    expect(first.invite_id).not.toBe(t1);

    // The same recovery command, retried or issued concurrently by a second
    // operator working from the same stale view.
    let thrown: unknown;
    try { recoverPartnerInvite(db, admin, partnerIdentityId, t1, "response lost"); } catch (error) { thrown = error; }
    expect((thrown as { code?: string } | undefined)?.code).toBe("AGENT_REFERRALS_INVITE_RECOVERY_PREDECESSOR_MISMATCH");

    // T2 is untouched and still the only live capability - no T3.
    expect(liveCapabilities(db, partnerIdentityId).map((row) => row.id)).toEqual([first.invite_id]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(partnerIdentityId) as { n: number }).n).toBe(2);
  });

  it("lost-response recovery: T1 is superseded BY T2, and exactly one capability is live afterwards", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const recovered = recoverPartnerInvite(db, admin, partnerIdentityId, t1, "response lost");

    const rows = db.prepare("SELECT id, superseded_by_id FROM partner_invite_capabilities WHERE partner_identity_id = ? ORDER BY created_at, rowid").all(partnerIdentityId) as { id: string; superseded_by_id: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(t1);
    expect(rows[0].superseded_by_id).toBe(recovered.invite_id);   // T2 explicitly supersedes T1
    expect(rows[1].superseded_by_id).toBeNull();
    expect(liveCapabilities(db, partnerIdentityId).map((row) => row.id)).toEqual([recovered.invite_id]);
  });

  it("the raw token exists only in the response - the database keeps a hash", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const recovered = recoverPartnerInvite(db, admin, partnerIdentityId, t1, "response lost");
    expect(recovered.raw_invite_token.length).toBeGreaterThan(16);

    const stored = db.prepare("SELECT verifier_hash FROM partner_invite_capabilities WHERE id = ?").get(recovered.invite_id) as { verifier_hash: string };
    expect(stored.verifier_hash).not.toBe(recovered.raw_invite_token);
    const dump = JSON.stringify(db.prepare("SELECT * FROM partner_invite_capabilities WHERE partner_identity_id = ?").all(partnerIdentityId));
    expect(dump).not.toContain(recovered.raw_invite_token);
    // Nor may it leak through the audit trail.
    const events = JSON.stringify(db.prepare("SELECT details_json FROM partner_identity_events WHERE partner_identity_id = ?").all(partnerIdentityId));
    expect(events).not.toContain(recovered.raw_invite_token);
  });

  it("durable evidence distinguishes a recovery from an ordinary operator reissue", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const recovered = recoverPartnerInvite(db, admin, partnerIdentityId, t1, "response lost");
    const events = db.prepare("SELECT event_kind, details_json FROM partner_identity_events WHERE partner_identity_id = ? ORDER BY rowid").all(partnerIdentityId) as { event_kind: string; details_json: string }[];
    const recovery = events.find((event) => event.event_kind === "INVITE_RECOVERED");
    expect(recovery, "a recovery must not be indistinguishable from INVITE_REISSUED").toBeTruthy();

    const details = JSON.parse(recovery!.details_json) as Record<string, unknown>;
    expect(details.superseded_invite_id).toBe(t1);
    expect(details.invite_id).toBe(recovered.invite_id);
    expect(details.recovery_reason).toBe("LOST_RESPONSE_RECOVERY");
  });

  // NOTE while this file is still red: this case currently passes for the
  // WRONG reason - recoverPartnerInvite is undefined, so toThrow() catches a
  // ReferenceError. It only becomes meaningful once the command exists, and
  // must be re-verified by falsification then.
  it("atomicity: a fault between supersede and mint leaves T1 live - never zero live, never two", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    // The mint fails inside the command's own transaction. Whatever the
    // cause, the outcome may only be "nothing happened".
    expect(() => recoverPartnerInvite(db, admin, partnerIdentityId, t1, "response lost", () => {
      throw new Error("simulated fault after supersede, before mint");
    })).toThrow();

    expect(liveCapabilities(db, partnerIdentityId).map((row) => row.id)).toEqual([t1]);
    expect((db.prepare("SELECT superseded_by_id FROM partner_invite_capabilities WHERE id = ?").get(t1) as { superseded_by_id: string | null }).superseded_by_id).toBeNull();
  });

  /**
   * The finding that changes this PR's scope, demonstrated rather than
   * asserted: ORDINARY reissue has the same defect recovery is being built
   * to fix, and C2 never caught it because the route was parked as
   * SPECIAL_RECOVERY and never re-examined once that label was applied.
   */
  it("ORDINARY reissue is not replay-safe either: a retried reissue destroys the capability its own first attempt created", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const a = reissuePartnerInvite(db, admin, partnerIdentityId, "operator reissue");
    expect(a.invite_id).not.toBe(t1);

    // The response was lost. The operator repeats the same command.
    const retry = reissuePartnerInvite(db, admin, partnerIdentityId, "operator reissue");

    // Today this succeeds and T2 - a capability the first attempt created,
    // whose raw token nobody holds - is destroyed by the retry.
    expect(retry.invite_id, "a retried reissue must not mint a third capability").toBe(a.invite_id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(partnerIdentityId) as { n: number }).n).toBe(2);
  });
});
