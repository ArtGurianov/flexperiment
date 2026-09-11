import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { scryptSync } from "node:crypto";
import { admin, fresh } from "./support/agent-referrals-settlement-fixtures";
import { MockProvider } from "../src/provider";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-agent-referrals-invite-rotation";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-agent-referrals-invite-rotation";

const { createApp } = await import("../src/api");
const ADMIN_ORIGIN = "https://admin.flexperiment.ru";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, rotatePartnerInvite, inviteCapabilityHeadId } from "../src/agent-referrals-partner-identity";

/**
 * PR-C3: the last rollout blocker C2 left open, and the contract was written
 * red before any of it existed.
 *
 * C2 parked /partners/:id/invite/reissue as SPECIAL_RECOVERY because its raw
 * token is never persisted, so no idempotency mechanism can re-serve the
 * original after a lost response. Writing this file first found the real
 * defect was simpler and worse than "recovery is undefined": the ORDINARY
 * reissue read whatever was live and superseded it, so a retried reissue
 * minted a third capability and destroyed the second, whose raw token nobody
 * held either. Exactly one capability was live at every instant, so 0044's
 * partial unique index was satisfied and nothing looked wrong.
 *
 * One invariant fixes it - a rotation must NAME the capability it replaces -
 * and recovery is then a REASON on that one operation, not a second
 * mechanism. A lost response cannot be replayed; it can only be rotated past
 * deliberately, against whatever is live after an authoritative refresh.
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

const liveIds = (db: Database.Database, partnerIdentityId: string) =>
  (db.prepare(`SELECT id FROM partner_invite_capabilities
    WHERE partner_identity_id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND superseded_by_id IS NULL`)
    .all(partnerIdentityId) as { id: string }[]).map((row) => row.id);

const countCapabilities = (db: Database.Database, partnerIdentityId: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(partnerIdentityId) as { n: number }).n;

const rotate = (
  db: Database.Database, partnerIdentityId: string, expected: string,
  rotationReason: "MANUAL_REISSUE" | "LOST_RESPONSE_RECOVERY", reason: string,
) => rotatePartnerInvite(db, admin, partnerIdentityId, expected, rotationReason, reason);

const expectStale = (run: () => unknown) => {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect((thrown as { code?: string } | undefined)?.code, `expected a stale refusal, got ${String(thrown)}`)
    .toBe("AGENT_REFERRALS_INVITE_CAPABILITY_STALE");
};

describe("invite rotation is predecessor-bound, and recovery is a reason on it", () => {
  it("1. a retried rotation is refused, and the capability its first attempt created stays live", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const t2 = rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "operator reissue");
    expect(t2.invite_id).not.toBe(t1);

    // The response was lost; the old request arrives again.
    expectStale(() => rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "operator reissue"));

    expect(liveIds(db, partnerIdentityId)).toEqual([t2.invite_id]);
    expect(countCapabilities(db, partnerIdentityId)).toBe(2);
  });

  it("2. after that ambiguity, an explicit recovery against the CURRENT capability issues the next one", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);
    const t2 = rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "operator reissue");

    // The operator refreshes: the live capability is T2. The recovery is
    // authored against THAT, never against the T1 the lost request named -
    // otherwise predecessor binding would be fiction.
    expect(inviteCapabilityHeadId(db, partnerIdentityId)).toBe(t2.invite_id);
    const t3 = rotate(db, partnerIdentityId, t2.invite_id, "LOST_RESPONSE_RECOVERY", "response was lost");

    expect(liveIds(db, partnerIdentityId)).toEqual([t3.invite_id]);
    expect(countCapabilities(db, partnerIdentityId)).toBe(3);
    expect((db.prepare("SELECT superseded_by_id FROM partner_invite_capabilities WHERE id = ?").get(t2.invite_id) as { superseded_by_id: string | null }).superseded_by_id).toBe(t3.invite_id);
  });

  it("3. a duplicate recovery, still pinned to the same predecessor, does not supersede the first one's capability", () => {
    // The case that forces the design. Without the pin this is T1 -> T2 ->
    // T3: one capability live throughout, nothing structurally wrong, and
    // the operator handed T2 finds it already destroyed.
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const t2 = rotate(db, partnerIdentityId, t1, "LOST_RESPONSE_RECOVERY", "response lost");
    expectStale(() => rotate(db, partnerIdentityId, t1, "LOST_RESPONSE_RECOVERY", "response lost"));

    expect(liveIds(db, partnerIdentityId)).toEqual([t2.invite_id]);
    expect(countCapabilities(db, partnerIdentityId)).toBe(2);
  });

  it("4. a fault mid-rotation leaves exactly one live capability - the predecessor, untouched", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    // Real fault injection rather than a production seam: a trigger that
    // aborts the INSERT. The supersede UPDATE has already run inside the
    // rotation's transaction by then, which is exactly the window under
    // test - so what this asserts is the rollback, not the error.
    db.exec(`CREATE TRIGGER __fault_on_invite_mint BEFORE INSERT ON partner_invite_capabilities
      BEGIN SELECT RAISE(ABORT, 'SIMULATED_MINT_FAULT'); END;`);
    expect(() => rotate(db, partnerIdentityId, t1, "LOST_RESPONSE_RECOVERY", "response lost")).toThrow(/SIMULATED_MINT_FAULT/);
    db.exec("DROP TRIGGER __fault_on_invite_mint");

    expect(liveIds(db, partnerIdentityId)).toEqual([t1]);
    expect((db.prepare("SELECT superseded_by_id FROM partner_invite_capabilities WHERE id = ?").get(t1) as { superseded_by_id: string | null }).superseded_by_id).toBeNull();
    expect(countCapabilities(db, partnerIdentityId)).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE partner_identity_id = ? AND event_kind = 'INVITE_ROTATED'").get(partnerIdentityId) as { n: number }).n).toBe(0);
  });

  it("the audit trail tells a recovery apart from a deliberate reissue - by reason, in one stream", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const t2 = rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "operator decided to reissue");
    const t3 = rotate(db, partnerIdentityId, t2.invite_id, "LOST_RESPONSE_RECOVERY", "response lost");

    const rotations = (db.prepare("SELECT details_json FROM partner_identity_events WHERE partner_identity_id = ? AND event_kind = 'INVITE_ROTATED' ORDER BY rowid").all(partnerIdentityId) as { details_json: string }[])
      .map((event) => JSON.parse(event.details_json) as Record<string, unknown>);
    expect(rotations).toHaveLength(2);
    expect(rotations[0]).toMatchObject({ invite_id: t2.invite_id, superseded_invite_id: t1, rotation_reason: "MANUAL_REISSUE" });
    expect(rotations[1]).toMatchObject({ invite_id: t3.invite_id, superseded_invite_id: t2.invite_id, rotation_reason: "LOST_RESPONSE_RECOVERY" });
  });

  it("the raw token lives only in the response - never in the row, never in the audit trail", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const rotated = rotate(db, partnerIdentityId, t1, "LOST_RESPONSE_RECOVERY", "response lost");
    expect(rotated.raw_invite_token.length).toBeGreaterThan(16);

    expect(JSON.stringify(db.prepare("SELECT * FROM partner_invite_capabilities WHERE partner_identity_id = ?").all(partnerIdentityId)))
      .not.toContain(rotated.raw_invite_token);
    expect(JSON.stringify(db.prepare("SELECT details_json FROM partner_identity_events WHERE partner_identity_id = ?").all(partnerIdentityId)))
      .not.toContain(rotated.raw_invite_token);
  });

  /**
   * Review round 2, P1. The pin was "the capability that is usable right
   * now", which is CYCLIC: revoking or consuming returns it to null, a mint
   * gives it a value, revoking returns it to null again. requireObservedVersion's
   * own contract forbids exactly that - a pin must be monotone, or A -> B -> A
   * restores the value a stale retry was authored against.
   *
   * The first version of this file encoded the defect's premise as expected
   * behaviour: it asserted that after a revoke nothing was live, then let a
   * rotation pin that absence.
   *
   * The fix needs no new counter. 0044 already carries the monotone axis -
   * superseded_by_id IS NULL is the mint-chain HEAD, and a row once
   * superseded is never un-superseded. consumed_at/revoked_at answer "is
   * this token usable"; superseded_by_id answers "which capability is last
   * in the chain". Two different questions that were being conflated.
   */
  it("the pin is the mint-chain head, not usability: a revoke does not let a stale rotation through", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);
    db.prepare("UPDATE partner_invite_capabilities SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(t1);

    // The head does not move when a capability is revoked - only when one is
    // superseded by the next mint.
    expect(inviteCapabilityHeadId(db, partnerIdentityId)).toBe(t1);

    const t2 = rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "reissue after revocation");
    // A: the response is lost. B: an ordinary, legal revocation of T2, which
    // under the old pin returned the aggregate to null - exactly the value A
    // was authored against.
    db.prepare("UPDATE partner_invite_capabilities SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").run(t2.invite_id);

    expectStale(() => rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "reissue after revocation"));

    expect(inviteCapabilityHeadId(db, partnerIdentityId)).toBe(t2.invite_id);
    expect(countCapabilities(db, partnerIdentityId)).toBe(2);
  });

  it("the same holds for consumption, which also used to return the old pin to null", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);

    const t2 = rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "reissue");
    db.prepare("UPDATE partner_invite_capabilities SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?").run(t2.invite_id);

    expectStale(() => rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "reissue"));

    expect(inviteCapabilityHeadId(db, partnerIdentityId)).toBe(t2.invite_id);
    expect(countCapabilities(db, partnerIdentityId)).toBe(2);
  });

  it("at most one chain head per partner, structurally", () => {
    const { db } = fresh();
    open.push(db);
    const { partnerIdentityId, inviteId: t1 } = invitedPartner(db);
    rotate(db, partnerIdentityId, t1, "MANUAL_REISSUE", "reissue");

    // 0057's partial unique index, not merely the application's discipline.
    expect(() => db.prepare(`INSERT INTO partner_invite_capabilities(id, partner_identity_id, purpose, verifier_hash, expires_at, created_by_admin_id)
      VALUES (?, ?, 'ONBOARDING', ?, ?, 'admin-1')`)
      .run(randomUUID(), partnerIdentityId, randomUUID(), new Date(Date.now() + 3600_000).toISOString()))
      .toThrow(/UNIQUE constraint failed/);
  });
});

/**
 * The HTTP boundary, where `rotation_reason` is a required, machine-semantic
 * field with no default. A server-chosen MANUAL_REISSUE would put the
 * business meaning of the command back where the caller cannot see it - and
 * the whole point of collapsing recovery into a reason is that the reason IS
 * the semantics.
 */
describe("POST /partners/:id/invite/reissue: rotation_reason is required and explicit", () => {
  const post = (app: ReturnType<typeof createApp>, cookie: string, partnerIdentityId: string, body: Record<string, unknown>) =>
    app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/partners/${partnerIdentityId}/invite/reissue`, {
      method: "POST", headers: { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

  const httpFixture = async () => {
    const { db } = fresh();
    open.push(db);
    const app = createApp(db, new MockProvider());
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST", headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }),
    });
    const { partnerIdentityId, inviteId } = invitedPartner(db);
    return { db, app, cookie: login.headers.get("set-cookie")!, partnerIdentityId, inviteId };
  };

  it.each([
    ["missing", {}],
    ["an unknown value", { rotation_reason: "BECAUSE_I_SAID_SO" }],
    // Deliberately: the human `reason` text must never be inferred from.
    ["prose that merely mentions a lost response", { reason: "the response was lost" }],
  ])("refuses %s with 422, and the live capability is untouched", async (_label, partial) => {
    const { db, app, cookie, partnerIdentityId, inviteId } = await httpFixture();

    const response = await post(app, cookie, partnerIdentityId, { expected_invite_capability_head_id: inviteId, reason: "rotate", ...partial });
    expect(response.status).toBe(422);

    expect(liveIds(db, partnerIdentityId)).toEqual([inviteId]);
    expect(countCapabilities(db, partnerIdentityId)).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE partner_identity_id = ? AND event_kind = 'INVITE_ROTATED'").get(partnerIdentityId) as { n: number }).n).toBe(0);
  });

  it.each(["MANUAL_REISSUE", "LOST_RESPONSE_RECOVERY"] as const)("accepts %s through the same primitive, recording it verbatim", async (rotationReason) => {
    const { db, app, cookie, partnerIdentityId, inviteId } = await httpFixture();

    const response = await post(app, cookie, partnerIdentityId, {
      expected_invite_capability_head_id: inviteId, rotation_reason: rotationReason, reason: "operator action",
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { invite_id: string; raw_invite_token: string };

    // Same rotation, same event kind - only the recorded intent differs.
    const events = db.prepare("SELECT event_kind, details_json FROM partner_identity_events WHERE partner_identity_id = ? AND event_kind = 'INVITE_ROTATED'").all(partnerIdentityId) as { event_kind: string; details_json: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].details_json)).toMatchObject({
      invite_id: payload.invite_id, superseded_invite_id: inviteId, rotation_reason: rotationReason,
    });
    expect(liveIds(db, partnerIdentityId)).toEqual([payload.invite_id]);
  });
});
