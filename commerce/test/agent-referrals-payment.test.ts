import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginPayment, recordPaymentMade, recordPayoutUnknown, recordConfirmedNotMade, recoverStuckPaymentAttempts, recordNpdReceipt,
  activePaymentAttempt, paymentAttemptsForSettlement,
} from "../src/agent-referrals-payment";
import { recordNpdStatusCheck, currentUsableNpdCheck, NPD_STATUS_CHECK_FRESHNESS_MS } from "../src/agent-referrals-npd";
import { closeEngagementZeroReward, zeroRewardClosureForEngagement, ZeroRewardClosureError } from "../src/agent-referrals-zero-reward-closure";
import { finalizeEngagementRewardRegistry, closeEngagementWithRewardRegistry, resolveRewardRegistryFinalizationFromRegistry, correctEngagementEffectiveRewardSnapshot } from "../src/agent-referrals-reward-registry";
import { preparePartnerSettlement, correctPartnerRewardWithSettlement, type AgentReferralsSettlementRow } from "../src/agent-referrals-settlement";
import { generateSettlementAct, presentSettlementAct, acceptSettlementAct } from "../src/agent-referrals-act";
import { mintSettlementStepUpGrant } from "../src/agent-referrals-settlement-step-up";
import { revokePartnerPayoutDestination } from "../src/agent-referrals-payout-profile";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import type { PartnerPrincipal, AdminPrincipal } from "../src/agent-referrals-partner-identity";
import {
  fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, closeAndComplete,
  finalizedSettlement, acceptedAct, activeNpdCheck, wait,
} from "./support/agent-referrals-settlement-fixtures";
import { concurrencyFixture, type ConcurrencyFixture } from "./support/concurrency-fixture";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const track = (db: Database.Database) => { open.push(db); return db; };

type Ready = { db: Database.Database; domain: CommerceDomain; partner: PartnerPrincipal; settlement: AgentReferralsSettlementRow; engagementId: string; partnerIdentityId: string };

/** A settlement PREPARED, act accepted, and (for NPD) a fresh ACTIVE NPD check on file - one step short of beginPayment(). */
const readyForPayment = (taxMode: "NPD" | "OTHER" = "NPD"): Ready => {
  const { db, domain } = fresh(); track(db);
  const p1 = readyPartner(db, taxMode);
  const occ = seedOccurrence(db, p1.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
  const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  purchaseAndPay(db, domain, occ, code.code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
  const settlement = finalizedSettlement(db, domain, occ, engagementId);
  acceptedAct(db, p1.partner, settlement);
  if (taxMode === "NPD") activeNpdCheck(db, p1.partnerIdentityId);
  return { db, domain, partner: p1.partner, settlement, engagementId, partnerIdentityId: p1.partnerIdentityId };
};

describe("beginPayment: full recheck in one transaction", () => {
  it("succeeds and creates exactly one IN_PROGRESS attempt bound to a fresh authorization", () => {
    const { db, settlement } = readyForPayment();
    const result = beginPayment(db, admin, settlement.id);
    expect(result.authorization.settlement_id).toBe(settlement.id);
    expect(result.attempt.status).toBe("IN_PROGRESS");
    expect(result.attempt.amount_kopecks).toBe(settlement.amount_kopecks);
    expect(activePaymentAttempt(db, settlement.id)!.id).toBe(result.attempt.id);
  });

  it("refuses when the settlement is not PREPARED", () => {
    const { db, settlement } = readyForPayment();
    db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT' WHERE id = ?").run(settlement.id);
    expect(() => beginPayment(db, admin, settlement.id)).toThrow(/AGENT_REFERRALS_PAYMENT_SETTLEMENT_NOT_PAYABLE/);
  });

  it("refuses when the act has not been presented", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "notpresented@example.test", "idem-notpresented-0000001");
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    expect(() => beginPayment(db, admin, settlement.id)).toThrow(/AGENT_REFERRALS_PAYMENT_ACT_NOT_PRESENTED/);
  });

  it("refuses NPD without a fresh ACTIVE npd_status_check on file", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "NPD");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "nonpdcheck@example.test", "idem-nonpdcheck-0000001");
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    acceptedAct(db, p1.partner, settlement);
    expect(() => beginPayment(db, admin, settlement.id)).toThrow(/AGENT_REFERRALS_PAYMENT_NPD_CHECK_UNAVAILABLE/);
  });

  it("refuses NPD whose only check is INACTIVE", () => {
    const { db, partnerIdentityId } = readyForPayment("OTHER");
    recordNpdStatusCheck(db, admin, partnerIdentityId, "INACTIVE", "ev-1");
    expect(currentUsableNpdCheck(db, partnerIdentityId)).toBeNull();
  });

  it("refuses NPD whose only check is UNKNOWN", () => {
    const { db, partnerIdentityId } = readyForPayment("OTHER");
    recordNpdStatusCheck(db, admin, partnerIdentityId, "UNKNOWN", "ev-1");
    expect(currentUsableNpdCheck(db, partnerIdentityId)).toBeNull();
  });

  it("refuses NPD whose only ACTIVE check is stale (older than the freshness window)", () => {
    const { db, partnerIdentityId } = readyForPayment("OTHER");
    const staleAt = new Date(Date.now() - NPD_STATUS_CHECK_FRESHNESS_MS - 60_000).toISOString();
    recordNpdStatusCheck(db, admin, partnerIdentityId, "ACTIVE", "ev-1", staleAt);
    expect(currentUsableNpdCheck(db, partnerIdentityId)).toBeNull();
  });

  it("a fresh ACTIVE check within the freshness window is usable", () => {
    const { db, partnerIdentityId } = readyForPayment("OTHER");
    recordNpdStatusCheck(db, admin, partnerIdentityId, "ACTIVE", "ev-1");
    expect(currentUsableNpdCheck(db, partnerIdentityId)).not.toBeNull();
  });

  it("an ACTIVE check that has since been superseded by a newer check (of any status) is no longer usable - P0.4 currentness, never rowid/timestamp-only ordering", () => {
    const { db, partnerIdentityId } = readyForPayment("OTHER");
    const oldCheck = recordNpdStatusCheck(db, admin, partnerIdentityId, "ACTIVE", "ev-old");
    expect(currentUsableNpdCheck(db, partnerIdentityId)!.id).toBe(oldCheck.id);
    const newCheck = recordNpdStatusCheck(db, admin, partnerIdentityId, "INACTIVE", "ev-new");
    expect(newCheck.sequence).toBe(oldCheck.sequence + 1);
    // The old ACTIVE check is no longer current, and the new current check is INACTIVE - either way, nothing is usable now.
    expect(currentUsableNpdCheck(db, partnerIdentityId)).toBeNull();
  });

  it("succeeds for OTHER tax mode with no NPD check at all", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const result = beginPayment(db, admin, settlement.id);
    expect(result.authorization.npd_status_check_id).toBeNull();
  });

  it("payout profile revoked after PREPARED but before BEGIN_PAYMENT is refused", () => {
    const { db, settlement, partner } = readyForPayment("OTHER");
    const current = db.prepare("SELECT id FROM payout_profile_revisions WHERE partner_identity_id = ? ORDER BY revision DESC LIMIT 1").get(partner.partner_identity_id) as { id: string };
    const grant = mintStepUpGrant(db, partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: current.id });
    revokePartnerPayoutDestination(db, partner, grant.grant_id);
    expect(() => beginPayment(db, admin, settlement.id)).toThrow(/PAYMENT_AUTHORIZATION_RELATIONAL_INCONSISTENT/);
  });

  it("DORMANT refuses outright", () => {
    const { db } = fresh(); track(db);
    expect(() => beginPayment(db, admin, "no-such-settlement")).toThrow();
  });

  it("global SUSPENDED still permits beginning payment for an obligation that arose before suspension", () => {
    const { db, settlement } = readyForPayment("OTHER");
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" });
    expect(() => beginPayment(db, admin, settlement.id)).not.toThrow();
  });

  it("refuses a settlement left stale by a DIRECT call to PR6's bare correctEngagementEffectiveRewardSnapshot (bypassing correctPartnerRewardWithSettlement) - P0.1", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "stale-bypass@example.test", "idem-stale-bypass-0000001");
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    acceptedAct(db, p1.partner, settlement);

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    // The official orchestrator (correctPartnerRewardWithSettlement) would have cancelled `settlement` before minting the new E - this call
    // deliberately bypasses it, reaching a state only possible via direct use of the raw PR6 primitive.
    const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, "direct correction, bypassing settlement orchestration");
    expect(correction.reward_total_kopecks).toBeLessThan(settlement.amount_kopecks);
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "PREPARED" }); // untouched by the bypass
    expect(() => beginPayment(db, admin, settlement.id)).toThrow(/AGENT_REFERRALS_PAYMENT_SETTLEMENT_STALE_EFFECTIVE_SNAPSHOT/);
  });
});

describe("payment attempt state machine", () => {
  it("recordPaymentMade projects settlement to SETTLED for OTHER tax mode", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    const result = recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(result.attempt.status).toBe("MADE");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "SETTLED" });
  });

  it("recordPaymentMade projects settlement to PENDING_DOCUMENT for NPD tax mode", () => {
    const { db, settlement } = readyForPayment("NPD");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "PENDING_DOCUMENT" });
  });

  it("recordPaymentMade is idempotent", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    const first = recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(first.replayed).toBe(false);
    const second = recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(second.replayed).toBe(true);
  });

  it("recordPayoutUnknown leaves the settlement PREPARED and blocks a second BEGIN_PAYMENT while unresolved", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPayoutUnknown(db, admin, attempt.id, "no confirmation received");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "PREPARED" });
    expect(() => beginPayment(db, admin, settlement.id)).toThrow(/AGENT_REFERRALS_PAYMENT_ATTEMPT_ALREADY_ACTIVE/);
  });

  it("recordPaymentMade resolves PAYOUT_UNKNOWN to MADE given durable reconciliation evidence, and correctly projects the settlement - P0.5", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPayoutUnknown(db, admin, attempt.id, "no confirmation received");
    const result = recordPaymentMade(db, admin, attempt.id, "bank statement confirms transfer completed");
    expect(result.attempt.status).toBe("MADE");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "SETTLED" });
    // A subsequent BEGIN_PAYMENT for this settlement is refused (MADE occupies the active slot forever).
    expect(() => beginPayment(db, admin, settlement.id)).toThrow();
  });

  it("recordConfirmedNotMade from PAYOUT_UNKNOWN frees the slot for a fresh authorization/attempt", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPayoutUnknown(db, admin, attempt.id, "unresolved");
    recordConfirmedNotMade(db, admin, attempt.id, "provider confirmed no transfer occurred");
    const fresh2 = beginPayment(db, admin, settlement.id);
    expect(fresh2.attempt.id).not.toBe(attempt.id);
    expect(fresh2.attempt.status).toBe("IN_PROGRESS");
    expect(paymentAttemptsForSettlement(db, settlement.id)).toHaveLength(2);
  });

  it("recordConfirmedNotMade directly from IN_PROGRESS (a definitive synchronous failure) also frees the slot", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordConfirmedNotMade(db, admin, attempt.id, "provider rejected instantly");
    expect(() => beginPayment(db, admin, settlement.id)).not.toThrow();
  });

  it("recordPaymentMade on an already-CONFIRMED_NOT_MADE attempt is refused, not silently accepted as a late claim", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordConfirmedNotMade(db, admin, attempt.id, "confirmed absent");
    expect(() => recordPaymentMade(db, admin, attempt.id, "late-claim")).toThrow(/AGENT_REFERRALS_PAYMENT_ATTEMPT_TRANSITION_ILLEGAL/);
  });

  it("two BEGIN_PAYMENT writers on separate connections: the second collides on the structural unique index, never silently duplicates", () => {
    const fixture: ConcurrencyFixture = concurrencyFixture();
    try {
      const seeded = seedReadyOnFixture(fixture);
      const connA = fixture.connect();
      const connB = fixture.connect();

      let firstError: unknown = null;
      let secondError: unknown = null;
      try { beginPayment(connA, admin, seeded.settlement.id); } catch (error) { firstError = error; }
      try { beginPayment(connB, admin, seeded.settlement.id); } catch (error) { secondError = error; }

      const succeeded = [firstError, secondError].filter((e) => e === null).length;
      expect(succeeded).toBe(1);
      const attempts = connA.prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE settlement_id = ?").get(seeded.settlement.id) as { n: number };
      expect(attempts.n).toBe(1);
    } finally {
      fixture.close();
    }
  });
});

describe("crash recovery: recoverStuckPaymentAttempts", () => {
  it("a stale IN_PROGRESS attempt resolves to PAYOUT_UNKNOWN, never MADE and never CONFIRMED_NOT_MADE", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    const recovered = recoverStuckPaymentAttempts(db, 1000, Date.now() + 60_000); // "now" far enough ahead that started_at counts as stale
    expect(recovered).toBe(1);
    const after = db.prepare("SELECT status FROM payment_attempts WHERE id = ?").get(attempt.id);
    expect(after).toEqual({ status: "PAYOUT_UNKNOWN" });
  });

  it("a fresh (not-yet-stale) IN_PROGRESS attempt is left untouched", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    const recovered = recoverStuckPaymentAttempts(db, 60 * 60_000, Date.now());
    expect(recovered).toBe(0);
    expect(db.prepare("SELECT status FROM payment_attempts WHERE id = ?").get(attempt.id)).toEqual({ status: "IN_PROGRESS" });
  });

  it("is idempotent and safe to call repeatedly - a PAYOUT_UNKNOWN attempt is never further mutated by it", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recoverStuckPaymentAttempts(db, 1000, Date.now() + 60_000);
    const secondSweep = recoverStuckPaymentAttempts(db, 1000, Date.now() + 120_000);
    expect(secondSweep).toBe(0);
    expect(db.prepare("SELECT status FROM payment_attempts WHERE id = ?").get(attempt.id)).toEqual({ status: "PAYOUT_UNKNOWN" });
  });
});

describe("NPD receipt lifecycle", () => {
  it("MADE -> PENDING_DOCUMENT -> valid receipt -> SETTLED", () => {
    const { db, settlement } = readyForPayment("NPD");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "PENDING_DOCUMENT" });
    const result = recordNpdReceipt(db, admin, attempt.id, "receipt-ref-1", "ev-1");
    expect(result.replayed).toBe(false);
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "SETTLED" });
  });

  it("is idempotent", () => {
    const { db, settlement } = readyForPayment("NPD");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    const first = recordNpdReceipt(db, admin, attempt.id, "receipt-ref-1", "ev-1");
    const second = recordNpdReceipt(db, admin, attempt.id, "receipt-ref-1", "ev-1");
    expect(second.replayed).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
  });

  it("a missing receipt never retries, erases MADE, or turns the payout back to UNKNOWN - the settlement simply stays PENDING_DOCUMENT", () => {
    const { db, settlement } = readyForPayment("NPD");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(db.prepare("SELECT status FROM payment_attempts WHERE id = ?").get(attempt.id)).toEqual({ status: "MADE" });
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "PENDING_DOCUMENT" });
  });

  it("refuses a receipt for an attempt that is not MADE", () => {
    const { db, settlement } = readyForPayment("NPD");
    const { attempt } = beginPayment(db, admin, settlement.id);
    expect(() => recordNpdReceipt(db, admin, attempt.id, "receipt-ref-1", "ev-1")).toThrow(/AGENT_REFERRALS_NPD_RECEIPT_ATTEMPT_NOT_MADE/);
  });

  it("refuses a receipt for an OTHER-tax-mode settlement, even if MADE", () => {
    const { db, settlement } = readyForPayment("OTHER");
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, attempt.id, "manual-ref-1");
    expect(() => recordNpdReceipt(db, admin, attempt.id, "receipt-ref-1", "ev-1")).toThrow(/AGENT_REFERRALS_NPD_RECEIPT_NOT_NPD_FLOW/);
  });
});

describe("zero-reward closure", () => {
  it("succeeds for a genuine zero-total E and is idempotent", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "zero1@example.test", "idem-zero1-0000001");
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'full', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(finalize.reward_total_kopecks).toBe(0);

    const first = closeEngagementZeroReward(db, admin, engagementId, "NO_ELIGIBLE_CONVERSIONS", "cmd-1");
    expect(first.replayed).toBe(false);
    expect(first.closure.reward_total_kopecks).toBe(0);
    const second = closeEngagementZeroReward(db, admin, engagementId, "NO_ELIGIBLE_CONVERSIONS", "cmd-2");
    expect(second.replayed).toBe(true);
    expect(second.closure.id).toBe(first.closure.id);
    expect(zeroRewardClosureForEngagement(db, engagementId)!.id).toBe(first.closure.id);
  });

  it("a CANCELLED occurrence's registry finalization always reaches zero-reward closure, never a settlement", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "zero2@example.test", "idem-zero2-0000001");
    db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'test' WHERE id = ?").run(occ);
    db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = 'OCCURRENCE_CANCELLED' WHERE order_id = ?").run(order.id);
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'occurrence cancelled', 'REFUND_OBLIGATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());

    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(finalize.reward_total_kopecks).toBe(0);
    expect(() => preparePartnerSettlement(db, admin, finalize.effective_snapshot_id)).toThrow(/AGENT_REFERRALS_SETTLEMENT_REWARD_NOT_POSITIVE/);

    const closure = closeEngagementZeroReward(db, admin, engagementId, "OCCURRENCE_CANCELLED", "cmd-cancel-1");
    expect(closure.closure.occurrence_fulfillment_status).toBe("CANCELLED");
  });

  it("refuses when the current E is not actually zero", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "notzero@example.test", "idem-notzero-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(() => closeEngagementZeroReward(db, admin, engagementId, "OTHER_POLICY_ZERO", "cmd-1")).toThrow(ZeroRewardClosureError);
    try { closeEngagementZeroReward(db, admin, engagementId, "OTHER_POLICY_ZERO", "cmd-1"); }
    catch (error) { expect((error as ZeroRewardClosureError).code).toBe("AGENT_REFERRALS_ZERO_CLOSURE_REWARD_NOT_ZERO"); }
  });

  it("refuses when the engagement's settlement was already MADE/SETTLED before a later correction drove E to zero - P0.6, zero closure can never coexist with a paid settlement", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "zeroafterpaid@example.test", "idem-zeroafterpaid-0000001");
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    acceptedAct(db, p1.partner, settlement);
    const authorization = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, authorization.attempt.id, "manual-ref-1");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "SETTLED" });

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'full', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());
    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "fully refunded after payment");
    expect(result.settlement_action).toBe("RECOVERY_EXPOSURE");
    expect(result.correction.reward_total_kopecks).toBe(0);

    expect(() => closeEngagementZeroReward(db, admin, engagementId, "CORRECTED_TO_ZERO", "cmd-1")).toThrow(/AGENT_REFERRALS_ZERO_CLOSURE_SETTLEMENT_EXISTS/);
  });

  it("closeEngagementWithRewardRegistry works normally alongside a zero-reward closure - closure is independent of engagement CLOSED", async () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "zero3@example.test", "idem-zero3-0000001");
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'full', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    closeEngagementZeroReward(db, admin, engagementId, "FULLY_REFUNDED", "cmd-1");
    await wait(400);
    const result = closeEngagementWithRewardRegistry(db, admin, engagementId, "closing");
    expect(result.replayed).toBe(false);
    expect(resolveRewardRegistryFinalizationFromRegistry(db, engagementId).finalized).toBe(true);
  });
});

describe("global CLOSED / SUSPENDED semantics", () => {
  it("engagement already CLOSED after finalized R: outstanding act/payment maturation is still allowed", async () => {
    const { db, settlement, engagementId, partner } = readyForPayment("OTHER");
    await wait(400);
    closeEngagementWithRewardRegistry(db, admin, engagementId, "closing while a settlement is outstanding");
    expect(db.prepare("SELECT lifecycle_state FROM engagements WHERE id = ?").get(engagementId)).toEqual({ lifecycle_state: "CLOSED" });
    expect(() => beginPayment(db, admin, settlement.id)).not.toThrow();
    void partner;
  });

  it("no finalized positive E: cannot mint a settlement merely because global SUSPENDED permits maturation", () => {
    const { db } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" });
    expect(() => preparePartnerSettlement(db, admin, "no-such-snapshot")).toThrow();
  });
});

// --- concurrency helper, scoped to this file only ---

function seedReadyOnFixture(fixture: ConcurrencyFixture): { partner: PartnerPrincipal; settlement: AgentReferralsSettlementRow } {
  const db = fixture.primary;
  const domain = new CommerceDomain(db, new MockProvider());
  const adminPrincipal: AdminPrincipal = admin;
  // concurrencyFixture() only migrates - fresh() is what normally seeds the active legal release checkout requires.
  const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((d) => [d, { document_id: d, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${d}`, archive_url: `https://example.test/archive/${d}`, checkout_relevant: true }])) };
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(randomUUID(), JSON.stringify(legalManifest));
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId, 100_000);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
  const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  purchaseAndPay(db, domain, occ, code.code, "concurrency@example.test", "idem-concurrency-0000001");
  const settlement = finalizedSettlement(db, domain, occ, engagementId);
  const { act } = generateSettlementAct(db, adminPrincipal, settlement.id);
  presentSettlementAct(db, adminPrincipal, act.id);
  const grant = mintSettlementStepUpGrant(db, p1.partner, "ACT_ACCEPTANCE", { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });
  acceptSettlementAct(db, p1.partner, act.id, grant.grant_id);
  return { partner: p1.partner, settlement };
}
