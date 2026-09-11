import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, finalizedSettlement, acceptedAct, purchaseAndPay } from "./support/agent-referrals-settlement-fixtures";
import { offerEngagement } from "../src/agent-referrals-engagement";
import { generateSettlementAct, presentSettlementAct } from "../src/agent-referrals-act";
import { placeLegalHoldIdempotent, releaseLegalHold } from "../src/agent-referrals-identity-retention";
import { beginPaymentIdempotent, recordConfirmedNotMade, paymentAttemptsForSettlement } from "../src/agent-referrals-payment";
import { revokeCreativeAuthorization, mintCreativeRevision, authorizeCreative } from "../src/agent-referrals-creative";
import { provisionPartnerOwner } from "../src/agent-referrals-partner-identity";

/**
 * PR-C2: the other two closed classifications, in the same
 * A -> B* -> retry A shape the STALE_BOUND suite uses.
 *
 *   DURABLE_KEY            - the retry must return the ORIGINAL response,
 *                            byte for byte, and write nothing new
 *   MONOTONIC_REPLAY_SAFE  - no legal B* can restore the precondition, so
 *                            the retry is refused (or replayed) by
 *                            construction, with no pin to supply
 *
 * The same three generic assertions apply to both: no B-created row
 * overwritten, no new A-derived row after B, the current authority still
 * B's.
 */

const expectCode = (run: () => unknown, code: string) => {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect((thrown as { code?: string } | undefined)?.code, `expected ${code}, got ${String(thrown)}`).toBe(code);
};

/** A settlement PREPARED with an accepted act - one step short of beginPayment(), mirroring agent-referrals-payment.test.ts's own readyForPayment. */
const readyForPayment = () => {
  const { db, domain } = fresh();
  const p1 = readyPartner(db, "OTHER");
  const occurrenceId = seedOccurrence(db, p1.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000, "PERCENT", 5000));
  const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  purchaseAndPay(db, domain, occurrenceId, code.code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  const settlement = finalizedSettlement(db, domain, occurrenceId, engagementId);
  acceptedAct(db, p1.partner, settlement);
  return { db, settlement };
};

describe("DURABLE_KEY: the retry replays, even though an identical body would otherwise be a legal second command", () => {
  it("legal hold: place -> release -> retried place returns the ORIGINAL hold instead of creating a second one", () => {
    // This classification moved twice. 0044's partial unique index on
    // released_at IS NULL refuses a CONCURRENT second hold, and under the
    // weak obligation that read as a proof - but a release is entirely
    // ordinary work, and after it placing another hold is legal. Only the
    // command key separates the retry from a deliberate re-hold.
    const { db } = fresh();
    const p1 = readyPartner(db);
    const key = randomUUID();

    const a = placeLegalHoldIdempotent(db, admin, key, p1.partnerIdentityId, "A: under investigation");
    expect(a.replayed).toBe(false);
    releaseLegalHold(db, admin, a.response.hold_id, "B: cleared");

    const retried = placeLegalHoldIdempotent(db, admin, key, p1.partnerIdentityId, "A: under investigation");
    expect(retried.replayed).toBe(true);
    expect(retried.response).toEqual(a.response);                                  // byte-identical original

    const holds = db.prepare("SELECT id, released_reason FROM partner_identity_legal_holds WHERE partner_identity_id = ?").all(p1.partnerIdentityId) as { id: string; released_reason: string | null }[];
    expect(holds.map((h) => h.id)).toEqual([a.response.hold_id]);                  // 2: no second hold
    expect(holds[0].released_reason).toBe("B: cleared");                           // 1: B's write intact
    expect(db.prepare("SELECT 1 FROM partner_identity_legal_holds WHERE partner_identity_id = ? AND released_at IS NULL").get(p1.partnerIdentityId)).toBeUndefined(); // 3

    // A DIFFERENT key is a deliberate second hold and is allowed through -
    // the key separates intent from retry, it does not freeze the command.
    const deliberate = placeLegalHoldIdempotent(db, admin, randomUUID(), p1.partnerIdentityId, "genuinely on hold again");
    expect(deliberate.replayed).toBe(false);
    expect(deliberate.response.hold_id).not.toBe(a.response.hold_id);
  });

  it("payments/begin: a failed attempt frees the active-attempt index, and the retry does not start a second payment", () => {
    const { db, settlement } = readyForPayment();
    const key = randomUUID();

    const a = beginPaymentIdempotent(db, admin, key, settlement.id);
    expect(a.replayed).toBe(false);
    // B: the payout did not go through. This frees
    // payment_attempts_active_unique - the index the old classification
    // leaned on.
    recordConfirmedNotMade(db, admin, a.response.attempt.id, "B: bank refused");

    const retried = beginPaymentIdempotent(db, admin, key, settlement.id);
    expect(retried.replayed).toBe(true);
    expect(retried.response.attempt.id).toBe(a.response.attempt.id);

    const attempts = paymentAttemptsForSettlement(db, settlement.id);
    expect(attempts.map((x) => x.id)).toEqual([a.response.attempt.id]);            // 2: no second attempt
    expect(attempts[0].status).toBe("CONFIRMED_NOT_MADE");                         // 1 and 3: B's outcome stands
    expect((db.prepare("SELECT COUNT(*) AS n FROM payment_authorizations WHERE settlement_id = ?").get(settlement.id) as { n: number }).n).toBe(1);

    // And paying again under a NEW key is legal - which is exactly why this
    // command needed a key rather than a state gate.
    const second = beginPaymentIdempotent(db, admin, randomUUID(), settlement.id);
    expect(second.replayed).toBe(false);
    expect(second.response.attempt.id).not.toBe(a.response.attempt.id);
  });
});

describe("MONOTONIC_REPLAY_SAFE: no legal B* restores the precondition, so no pin is needed", () => {
  it("engagement offer: an engagement is never deleted, so ALREADY_EXISTS cannot be re-opened", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const terms = nearTermTerms(1000);
    offerEngagement(db, admin, p1.partnerIdentityId, occurrenceId, terms, "A: offer");

    // There is no B* to try: nothing in the domain removes an engagement,
    // so the (partner, occurrence) uniqueness this refusal rests on can
    // never be re-opened.
    expectCode(
      () => offerEngagement(db, admin, p1.partnerIdentityId, occurrenceId, terms, "A: offer"),
      "AGENT_REFERRALS_ENGAGEMENT_ALREADY_EXISTS",
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM engagements WHERE partner_identity_id = ? AND occurrence_id = ?").get(p1.partnerIdentityId, occurrenceId) as { n: number }).n).toBe(1);
  });

  it("creative authorization revoke: revoked_at is one-way for the row id the command names", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occurrenceId = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occurrenceId, nearTermTerms(1000));
    const creative = mintCreativeRevision(db, admin, engagementId, {
      format_kind: "post", media_ref: "m1", copy_text: "c", cta_text: "cta",
      mandatory_labeling_text: "Реклама", creative_target_url: "https://example.test/x",
    }, null);
    const authorization = authorizeCreative(db, admin, engagementId, creative.id, null);

    revokeCreativeAuthorization(db, admin, authorization.id, "A: revoked");
    // B*: a NEW authorization for the same creative. The engagement has a
    // live authorization again - but A named a specific row id, and that
    // row stays revoked whatever happens around it.
    const b = authorizeCreative(db, admin, engagementId, creative.id, authorization.id);
    expect(b.id).not.toBe(authorization.id);

    expectCode(() => revokeCreativeAuthorization(db, admin, authorization.id, "A: revoked"), "AGENT_REFERRALS_CREATIVE_AUTHORIZATION_ALREADY_REVOKED");

    expect(db.prepare("SELECT revoked_reason FROM engagement_creative_authorizations WHERE id = ?").get(authorization.id))
      .toEqual({ revoked_reason: "A: revoked" });                                  // 1: unchanged by the retry
    expect(db.prepare("SELECT revoked_at FROM engagement_creative_authorizations WHERE id = ?").get(b.id)).toEqual({ revoked_at: null }); // 3: B's row still live
  });

  it("act generation and presentation: one-way transitions replay rather than repeat", () => {
    const { db, settlement } = readyForPayment();

    // One act per settlement, forever - the retry returns the same row.
    const existing = generateSettlementAct(db, admin, settlement.id);
    expect(existing.replayed).toBe(true); // acceptedAct() already generated it
    expect((db.prepare("SELECT COUNT(*) AS n FROM settlement_acts WHERE settlement_id = ?").get(settlement.id) as { n: number }).n).toBe(1);

    // presented_at is one-way, and a retry must not rewrite the instant.
    const retried = presentSettlementAct(db, admin, existing.act.id);
    expect(retried.replayed).toBe(true);
    expect(retried.act.presented_at).toBe(existing.act.presented_at);
  });

  it("partner provisioning: a provisioned identity is never un-provisioned", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    expectCode(
      () => provisionPartnerOwner(db, admin, p1.agentId, "p@example.test", "retry"),
      "AGENT_REFERRALS_PARTNER_ALREADY_PROVISIONED",
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM partner_identities WHERE agent_id = ?").get(p1.agentId) as { n: number }).n).toBe(1);
  });
});
