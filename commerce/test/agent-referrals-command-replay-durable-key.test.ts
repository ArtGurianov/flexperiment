import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate } from "./support/agent-referrals-settlement-fixtures";
import { recordNpdStatusCheckIdempotent } from "../src/agent-referrals-npd";
import { placeLegalHoldNamed } from "../src/agent-referrals-identity-retention";
import { activateEngagementIdempotent } from "../src/agent-referrals-engagement";
import { setPartnerPayoutDestinationIdempotent, revokePartnerPayoutDestinationIdempotent, currentPayoutProfile } from "../src/agent-referrals-payout-profile";
import { reportDistributionByPartnerIdempotent } from "../src/agent-referrals-distribution";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";

/**
 * PR-C2 step 2b: the invariants durable command identity has to satisfy, for
 * the nine commands where an identical body can be a legitimate SECOND
 * command and only a caller-supplied key separates that from a retry.
 *
 * A tenth was in this list when it was written. Placing a legal hold turned
 * out not to need a key at all: 0044's partial unique index on
 * released_at IS NULL already refuses a second ACTIVE hold, so it needed a
 * NAME, not an identity. The matrix found that, not the review.
 *
 * The point of each case is what does NOT happen: no second durable fact, no
 * second lock, no second revision.
 */

const key = () => `k-${randomUUID()}`;
const codeOf = (fn: () => unknown): string => {
  try { fn(); return "NO_THROW"; } catch (error) { return (error as { code?: string }).code ?? "UNKNOWN"; }
};

describe("durable command identity: same key replays, new key commands", () => {
  it("admin: a retry after the world moved on returns the original response and appends no second check", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const k1 = key();

    const first = recordNpdStatusCheckIdempotent(db, admin, k1, p1.partnerIdentityId, "ACTIVE", "fns-1");
    expect(first.replayed).toBe(false);

    // The world moves on between the lost response and the retry: another
    // check lands, so the sequence the retry would otherwise compute has
    // changed. A replay must be unaffected by that.
    recordNpdStatusCheckIdempotent(db, admin, key(), p1.partnerIdentityId, "INACTIVE", "fns-2");

    const replay = recordNpdStatusCheckIdempotent(db, admin, k1, p1.partnerIdentityId, "ACTIVE", "fns-1");
    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    expect(db.prepare("SELECT COUNT(*) AS n FROM npd_status_checks WHERE partner_identity_id = ?").get(p1.partnerIdentityId)).toEqual({ n: 2 });
  });

  it("admin: the same key with a different body is a conflict, and writes nothing", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const k1 = key();
    recordNpdStatusCheckIdempotent(db, admin, k1, p1.partnerIdentityId, "ACTIVE", "fns-1");

    expect(codeOf(() => recordNpdStatusCheckIdempotent(db, admin, k1, p1.partnerIdentityId, "INACTIVE", "fns-1"))).toBe("IDEMPOTENCY_CONFLICT");
    expect(db.prepare("SELECT COUNT(*) AS n FROM npd_status_checks WHERE partner_identity_id = ?").get(p1.partnerIdentityId)).toEqual({ n: 1 });
  });

  it("admin: a NEW key with the same body is a genuine second command - which is the whole reason these need a key", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    // Two NPD checks with the same status are the normal case: the payment
    // guard consumes their freshness, not their value.
    recordNpdStatusCheckIdempotent(db, admin, key(), p1.partnerIdentityId, "ACTIVE", "fns-1");
    recordNpdStatusCheckIdempotent(db, admin, key(), p1.partnerIdentityId, "ACTIVE", "fns-1");
    expect(db.prepare("SELECT COUNT(*) AS n FROM npd_status_checks WHERE partner_identity_id = ?").get(p1.partnerIdentityId)).toEqual({ n: 2 });
  });

  it("admin: a legal hold needs a NAME, not a key - the partial unique index already refuses a second active hold", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    placeLegalHoldNamed(db, admin, p1.partnerIdentityId, "tax audit");
    // Was a raw SqliteError, i.e. a 500 for "already on hold".
    expect(codeOf(() => placeLegalHoldNamed(db, admin, p1.partnerIdentityId, "tax audit"))).toBe("AGENT_REFERRALS_LEGAL_HOLD_ALREADY_ACTIVE");
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_legal_holds WHERE partner_identity_id = ?").get(p1.partnerIdentityId)).toEqual({ n: 1 });
  });

  it("admin: activation replays to the original activation event instead of churning the promo authority", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000));
    const revisionId = (db.prepare("SELECT id FROM engagement_revisions WHERE engagement_id = ? ORDER BY revision DESC LIMIT 1").get(engagementId) as { id: string }).id;
    const k1 = key();

    const first = activateEngagementIdempotent(db, admin, k1, engagementId, revisionId);
    const replay = activateEngagementIdempotent(db, admin, k1, engagementId, revisionId);

    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(first.response);
    // The live authorization the first call minted is still live: the old
    // path revoked it and minted a replacement on every retry.
    expect(db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(first.response.promo_authorization_id))
      .toEqual({ revoked_at: null });
  });

  it("partner: payout - the scenario the whole mechanism exists for", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const grantFor = (supersedes: string | null) =>
      mintStepUpGrant(db, p1.partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: supersedes }).grant_id;
    const k1 = key();
    // readyPartner already established a destination, so the fixture's own
    // revision is what a grant has to supersede.
    const seeded = currentPayoutProfile(db, p1.partnerIdentityId)!;

    const first = setPartnerPayoutDestinationIdempotent(db, p1.partner, k1, {
      step_up_grant_id: grantFor(seeded.id), destination_kind: "BANK_CARD", destination_plaintext: "5555444433332222", destination_last4: "2222",
    });
    const r1 = first.response;
    expect(r1.revision).toBe(seeded.revision + 1);

    // The response was lost; the UI's authoritative refresh has already
    // observed R1. The retry carries a FRESH grant - the first is spent -
    // and that grant is legitimately bound to R1, which is exactly why a
    // step-up grant is not replay protection.
    const replay = setPartnerPayoutDestinationIdempotent(db, p1.partner, k1, {
      step_up_grant_id: grantFor(r1.id), destination_kind: "BANK_CARD", destination_plaintext: "5555444433332222", destination_last4: "2222",
    });

    expect(replay.replayed).toBe(true);
    expect(replay.response).toEqual(r1);
    // No R+1: the retry's grant, though legitimately bound to R1, was never
    // consumed, because the replay resolved before any current-revision read.
    expect(currentPayoutProfile(db, p1.partnerIdentityId)!.revision).toBe(r1.revision);
    expect(db.prepare("SELECT COUNT(*) AS n FROM payout_profile_revisions WHERE partner_identity_id = ?").get(p1.partnerIdentityId)).toEqual({ n: r1.revision });
  });

  it("partner: revoking replays too, and a different body under the same key conflicts", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const grantFor = (supersedes: string | null) =>
      mintStepUpGrant(db, p1.partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: supersedes }).grant_id;
    const seeded = currentPayoutProfile(db, p1.partnerIdentityId)!;
    const set = setPartnerPayoutDestinationIdempotent(db, p1.partner, key(), {
      step_up_grant_id: grantFor(seeded.id), destination_kind: "BANK_CARD", destination_plaintext: "5555444433332222", destination_last4: "2222",
    });
    const k1 = key();
    const revoked = revokePartnerPayoutDestinationIdempotent(db, p1.partner, k1, grantFor(set.response.id));
    const replay = revokePartnerPayoutDestinationIdempotent(db, p1.partner, k1, grantFor(revoked.response.id));
    expect(replay.replayed).toBe(true);
    expect(currentPayoutProfile(db, p1.partnerIdentityId)!.kind).toBe("REVOKED");
    expect(db.prepare("SELECT COUNT(*) AS n FROM payout_profile_revisions WHERE partner_identity_id = ?").get(p1.partnerIdentityId)).toEqual({ n: 3 });
  });

  it("partner: two partners using the SAME raw key are completely independent namespaces", () => {
    const { db } = fresh();
    const a = readyPartner(db);
    const b = readyPartner(db);
    const shared = "the-same-raw-key-both-partners-picked";
    const occurrenceA = seedOccurrence(db, a.cityId);
    const occurrenceB = seedOccurrence(db, b.cityId);
    const engagementA = offerAcceptActivate(db, a.partner, a.partnerIdentityId, occurrenceA, nearTermTerms(1000));
    const engagementB = offerAcceptActivate(db, b.partner, b.partnerIdentityId, occurrenceB, nearTermTerms(1000));
    const report = {
      channel_key: "telegram", resource_kind: "channel" as const, resource_identifier: "@ch",
      distribution_resource_url: "https://t.me/ch/1", published_at: new Date().toISOString(), ended_at: null, evidence_ref: "ev",
    };

    const fromA = reportDistributionByPartnerIdempotent(db, a.partner, shared, engagementA, report);
    const fromB = reportDistributionByPartnerIdempotent(db, b.partner, shared, engagementB, report);

    expect(fromA.replayed).toBe(false);
    expect(fromB.replayed).toBe(false);
    expect(fromB.response.distribution_id).not.toBe(fromA.response.distribution_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_command_idempotency WHERE key_hash IS NOT NULL").get()).toEqual({ n: 2 });
  });

  it("both realms refuse a key that is too short to be a command identity", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    expect(codeOf(() => recordNpdStatusCheckIdempotent(db, admin, "short", p1.partnerIdentityId, "ACTIVE", "ev"))).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(codeOf(() => revokePartnerPayoutDestinationIdempotent(db, p1.partner, "tiny", "grant"))).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("the stored record is immutable and undeletable - a replay cannot be edited into a different answer", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    setPartnerPayoutDestinationIdempotent(db, p1.partner, key(), {
      step_up_grant_id: mintStepUpGrant(db, p1.partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: currentPayoutProfile(db, p1.partnerIdentityId)!.id }).grant_id,
      destination_kind: "BANK_CARD", destination_plaintext: "5555444433332222", destination_last4: "2222",
    });
    expect(() => db.prepare("UPDATE partner_command_idempotency SET response_json = '{}'").run()).toThrow(/PARTNER_COMMAND_IDEMPOTENCY_IMMUTABLE/);
    expect(() => db.prepare("DELETE FROM partner_command_idempotency").run()).toThrow(/PARTNER_COMMAND_IDEMPOTENCY_IMMUTABLE/);
  });

  it("a stored response cannot cache a failure: the table only admits 2xx", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    expect(() => db.prepare(`INSERT INTO partner_command_idempotency(partner_identity_id, command, key_hash, request_hash, contract_version, response_status, response_json)
      VALUES (?, 'partner.payout.set', 'h', 'r', 'p1', 409, '{}')`).run(p1.partnerIdentityId)).toThrow();
  });
});
