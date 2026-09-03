import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AgentReferralsSuspensionPolicyError } from "../src/agent-referrals-suspension-policy";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { finalizeEngagementRewardRegistry, currentEffectiveRewardSnapshot } from "../src/agent-referrals-reward-registry";
import { preparePartnerSettlement, correctPartnerRewardWithSettlement, recoveryExposure, recoveryExposureEvidenceForEngagement, SettlementError } from "../src/agent-referrals-settlement";
import { beginPayment, recordPaymentMade } from "../src/agent-referrals-payment";
import { CommerceDomain } from "../src/domain";
import {
  fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, closeAndComplete,
  finalizedSettlement, acceptedAct, seedLegacyReferralReward,
} from "./support/agent-referrals-settlement-fixtures";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const track = (db: Database.Database) => { open.push(db); return db; };

describe("preparePartnerSettlement: F10, the amount is derived, never supplied", () => {
  it("mints a PREPARED AGENT_REFERRALS settlement whose amount is exactly the pinned E's own total", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle1@example.test", "idem-settle1-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");

    const { settlement, replayed } = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    expect(replayed).toBe(false);
    expect(settlement.amount_kopecks).toBe(finalize.reward_total_kopecks);
    expect(settlement.settlement_flow).toBe("AGENT_REFERRALS");
    expect(settlement.status).toBe("PREPARED");
    expect(settlement.engagement_id).toBe(engagementId);
  });

  it("is idempotent: a second call for the same E returns the same settlement, never a second row", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle2@example.test", "idem-settle2-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");

    const first = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    const second = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    expect(second.replayed).toBe(true);
    expect(second.settlement.id).toBe(first.settlement.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM reward_settlements WHERE effective_reward_snapshot_id = ?").get(finalize.effective_snapshot_id)).toEqual({ n: 1 });
  });

  it("two concurrent preparePartnerSettlement calls for the same E: the second raw insert collides on the migration's own partial UNIQUE index", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle3@example.test", "idem-settle3-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    // A raw second attempt bypassing the application-level replay check entirely.
    expect(() => db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id,
        settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot)
      SELECT ?, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id,
        settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot
      FROM reward_settlements WHERE effective_reward_snapshot_id = ?`).run(randomUUID(), finalize.effective_snapshot_id)).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a zero-total E outright - never mints a settlement for it", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "settlezero@example.test", "idem-settlezero-0000001");
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'full', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(finalize.reward_total_kopecks).toBe(0);
    expect(() => preparePartnerSettlement(db, admin, finalize.effective_snapshot_id)).toThrow(/AGENT_REFERRALS_SETTLEMENT_REWARD_NOT_POSITIVE/);
  });

  it("global SUSPENDED still permits preparing a settlement for an obligation that arose before suspension", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settlesuspend@example.test", "idem-settlesuspend-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" });
    expect(() => preparePartnerSettlement(db, admin, finalize.effective_snapshot_id)).not.toThrow();
  });

  it("DORMANT refuses outright", () => {
    const { db } = fresh(); track(db);
    expect(() => preparePartnerSettlement(db, admin, "no-such-snapshot")).toThrow(AgentReferralsSuspensionPolicyError);
  });
});

describe("F9 partition: legacy rewardBalance() reads only LEGACY authority, across all four sources", () => {
  it("same agent + same occurrence: LEGACY reward, ENGAGEMENT_SCOPED reward, and an AGENT_REFERRALS settlement never leak into each other", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 4000)); // 10% discount, 40% reward
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "f9partition@example.test", "idem-f9partition-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    expect(finalize.reward_total_kopecks).toBe(36_000); // 40% of net captured (100_000 * 0.9 = 90_000)

    const prepared = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    expect(prepared.settlement.amount_kopecks).toBe(36_000);

    // A genuinely LEGACY referral_rewards row for the SAME agent_id/occurrence_id pair.
    seedLegacyReferralReward(db, p1.agentId, occ, 1000);

    const balance = domain.rewardBalance(p1.agentId, occ);
    // The legacy balance sees ONLY the 1000-side LEGACY row - never the 36_000 Agent Referrals settlement/reward.
    expect(balance.earned_total).toBe(1000);
    expect(balance.accrued_total).toBe(1000);
    expect(balance.available_to_settle).toBeLessThanOrEqual(1000);
  });
});

describe("correctPartnerRewardWithSettlement: §B-6 correction/supersession orchestration", () => {
  const setup = (db: Database.Database, domain: CommerceDomain) => {
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000)); // reward 50%
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, `${randomUUID()}@example.test`, `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    return { p1, occ, engagementId, order, settlement };
  };

  it("no settlement yet: correction runs alone, settlement_action NONE", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const order = purchaseAndPay(db, domain, occ, code.code, "corr-none@example.test", "idem-corr-none-0000001");
    closeAndComplete(db, domain, occ);
    finalizeEngagementRewardRegistry(db, admin, engagementId, "x");
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 10000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund, no settlement yet");
    expect(result.settlement_action).toBe("NONE");
  });

  it("PREPARED, no payment: old CANCELLED_BEFORE_PAYMENT, new settlement supersedes it (E2 > 0)", () => {
    const { db, domain } = fresh(); track(db);
    const { engagementId, order, settlement } = setup(db, domain);

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund");
    expect(result.settlement_action).toBe("SUPERSEDED");
    if (result.settlement_action !== "SUPERSEDED") throw new Error("unreachable");
    expect(result.cancelled_settlement_id).toBe(settlement.id);

    const oldSettlement = db.prepare("SELECT status, cancellation_reason FROM reward_settlements WHERE id = ?").get(settlement.id);
    expect(oldSettlement).toEqual({ status: "CANCELLED_BEFORE_PAYMENT", cancellation_reason: "SUPERSEDED_BY_REWARD_CORRECTION" });

    const newSettlement = db.prepare("SELECT status, amount_kopecks, supersedes_settlement_id FROM reward_settlements WHERE id = ?").get(result.new_settlement_id);
    expect(newSettlement).toMatchObject({ status: "PREPARED", supersedes_settlement_id: settlement.id });
    expect((newSettlement as { amount_kopecks: number }).amount_kopecks).toBe(result.correction.reward_total_kopecks);
    expect((newSettlement as { amount_kopecks: number }).amount_kopecks).toBeLessThan(settlement.amount_kopecks);
  });

  it("PREPARED, no payment, correction to zero: old CANCELLED_BEFORE_PAYMENT, no replacement settlement", () => {
    const { db, domain } = fresh(); track(db);
    const { engagementId, order, settlement } = setup(db, domain);
    // Refund the FULL net captured amount (order.amount_kopecks), not merely the reward amount - reward is a percentage of net captured, so only
    // refunding the entire captured amount drives it to exactly zero.
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'full', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "fully refunded");
    expect(result.settlement_action).toBe("CANCELLED_ZERO");
    expect(result.correction.reward_total_kopecks).toBe(0);
    const oldSettlement = db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id);
    expect(oldSettlement).toEqual({ status: "CANCELLED_BEFORE_PAYMENT" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM reward_settlements WHERE supersedes_settlement_id = ?").get(settlement.id)).toEqual({ n: 0 });
  });

  it("payment already MADE: old payment/settlement stay untouched, only recovery-exposure evidence is computed", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, engagementId, order, settlement } = setup(db, domain);
    const act = acceptedAct(db, p1.partner, settlement);
    const authorization = beginPayment(db, admin, settlement.id);
    void act;
    recordPaymentMade(db, admin, authorization.attempt.id, "manual-transfer-1");

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund after payment");
    expect(result.settlement_action).toBe("RECOVERY_EXPOSURE");
    if (result.settlement_action !== "RECOVERY_EXPOSURE") throw new Error("unreachable");
    expect(result.exposure.paid_net_kopecks).toBe(settlement.amount_kopecks);
    expect(result.exposure.current_effective_total_kopecks).toBe(result.correction.reward_total_kopecks);
    expect(result.exposure.exposure_kopecks).toBe(settlement.amount_kopecks - result.correction.reward_total_kopecks);

    // The original payment/settlement are untouched.
    const paid = db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id);
    expect(paid).toEqual({ status: "SETTLED" });
    expect(db.prepare("SELECT status FROM payment_attempts WHERE id = ?").get(authorization.attempt.id)).toEqual({ status: "MADE" });

    // §B-6: "immutable correction + recovery-exposure evidence" - a real, append-only row, not merely a value recoveryExposure() could recompute later.
    const evidence = recoveryExposureEvidenceForEngagement(db, engagementId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      settlement_id: settlement.id, effective_reward_snapshot_id: result.correction.effective_snapshot_id,
      paid_net_kopecks: result.exposure.paid_net_kopecks, exposure_kopecks: result.exposure.exposure_kopecks,
    });
  });

  it("a SECOND post-MADE correction produces a SECOND evidence row, pinning the new E each time, while S1 stays immutable throughout (P1.9a)", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, engagementId, order, settlement } = setup(db, domain);
    const act = acceptedAct(db, p1.partner, settlement);
    const authorization = beginPayment(db, admin, settlement.id);
    void act;
    recordPaymentMade(db, admin, authorization.attempt.id, "manual-transfer-1");

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 10000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    const first = correctPartnerRewardWithSettlement(db, admin, engagementId, "first late refund");
    expect(first.settlement_action).toBe("RECOVERY_EXPOSURE");
    if (first.settlement_action !== "RECOVERY_EXPOSURE") throw new Error("unreachable");

    // A second, later refund - the paid settlement S1's own pinned E never changes, only the engagement's current E advances again.
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 5000, 'later', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    const second = correctPartnerRewardWithSettlement(db, admin, engagementId, "second later refund");
    expect(second.settlement_action).toBe("RECOVERY_EXPOSURE");
    if (second.settlement_action !== "RECOVERY_EXPOSURE") throw new Error("unreachable");

    // created_at has only second-level resolution, so two evidence rows minted synchronously within the same
    // test can tie on it - identify each row by its own pinned E rather than assuming array order.
    const evidence = recoveryExposureEvidenceForEngagement(db, engagementId);
    expect(evidence).toHaveLength(2);
    const firstEvidence = evidence.find((e) => e.effective_reward_snapshot_id === first.correction.effective_snapshot_id);
    const secondEvidence = evidence.find((e) => e.effective_reward_snapshot_id === second.correction.effective_snapshot_id);
    expect(firstEvidence).toBeDefined();
    expect(secondEvidence).toBeDefined();
    expect(first.correction.effective_snapshot_id).not.toBe(second.correction.effective_snapshot_id);
    expect(firstEvidence!.settlement_id).toBe(settlement.id);
    expect(secondEvidence!.settlement_id).toBe(settlement.id);

    // S1 itself never moved.
    const paid = db.prepare("SELECT status, effective_reward_snapshot_id FROM reward_settlements WHERE id = ?").get(settlement.id);
    expect(paid).toEqual({ status: "SETTLED", effective_reward_snapshot_id: settlement.effective_reward_snapshot_id });
  });

  it("payment IN_PROGRESS (unsettled, not yet MADE): correction is refused outright, never cancels underneath a live attempt", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, engagementId, order, settlement } = setup(db, domain);
    acceptedAct(db, p1.partner, settlement);
    beginPayment(db, admin, settlement.id); // stays IN_PROGRESS

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());

    expect(() => correctPartnerRewardWithSettlement(db, admin, engagementId, "should be refused")).toThrow(/AGENT_REFERRALS_CORRECTION_BLOCKED_PAYMENT_IN_FLIGHT/);
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "PREPARED" });
    expect(currentEffectiveRewardSnapshot(db, engagementId)!.sequence).toBe(1); // no correction minted
  });

  it("post-recovery: recoveryExposure() reduces via actual settlement_recoveries, never below zero, and never over-recovers", () => {
    const { db, domain } = fresh(); track(db);
    const { p1, engagementId, order, settlement } = setup(db, domain);
    acceptedAct(db, p1.partner, settlement);
    const authorization = beginPayment(db, admin, settlement.id);
    recordPaymentMade(db, admin, authorization.attempt.id, "manual-transfer-1");
    // Refund the FULL net captured amount so the correction lands at exactly zero (reward is a percentage of net captured, not of the paid amount).
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, ?, 'full', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, order.amount_kopecks, randomUUID());

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "fully refunded after payment");
    expect(result.settlement_action).toBe("RECOVERY_EXPOSURE");
    if (result.settlement_action !== "RECOVERY_EXPOSURE") throw new Error("unreachable");
    expect(result.exposure.exposure_kopecks).toBe(settlement.amount_kopecks); // paid_net (full amount) - current (0)

    domain.addSettlementRecovery(settlement.id, { amount_recovered_kopecks: Math.floor(settlement.amount_kopecks / 2), recovered_at: new Date().toISOString(), method: "bank_transfer", evidence_reference: "rec-1" }, "idem-recover-1");
    const afterPartial = recoveryExposure(db, engagementId);
    expect(afterPartial.exposure_kopecks).toBe(settlement.amount_kopecks - Math.floor(settlement.amount_kopecks / 2));

    domain.addSettlementRecovery(settlement.id, { amount_recovered_kopecks: Math.ceil(settlement.amount_kopecks / 2), recovered_at: new Date().toISOString(), method: "bank_transfer", evidence_reference: "rec-2" }, "idem-recover-2");
    const afterFull = recoveryExposure(db, engagementId);
    expect(afterFull.exposure_kopecks).toBe(0);

    expect(() => domain.addSettlementRecovery(settlement.id, { amount_recovered_kopecks: 1, recovered_at: new Date().toISOString(), method: "bank_transfer", evidence_reference: "rec-3" }, "idem-recover-3"))
      .toThrow(/SETTLEMENT_RECOVERY_EXCEEDS_REMAINING/);
  });
});

describe("legacy settlement regression: genuinely unchanged behavior", () => {
  it("legacy prepareSettlement() (caller-supplied amount) still works exactly as before, and the row lands settlement_flow = 'LEGACY'", () => {
    const { db, domain } = fresh(); track(db);
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, ?, 'Legacy', 'Legacy Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000, datetime('now'))`).run(agentId, `legacy-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address, fulfillment_status, sales_status, completed_at)
      VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1', 'COMPLETED', 'CLOSED', CURRENT_TIMESTAMP)`).run(occurrenceId, cityId);
    seedLegacyReferralReward(db, agentId, occurrenceId, 5000);

    const settlement = domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 5000, method: "bank_transfer" }, "idem-legacy-prepare-1", "admin-1");
    expect(settlement.status).toBe("PREPARED");
    // Nullable, no default (0047) - a legacy-flow row stays NULL forever, never backfilled to a literal 'LEGACY', mirroring 0046's reward_authority_kind.
    expect(settlement.settlement_flow).toBeNull();

    domain.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "idem-legacy-made-1");
    const afterMade = db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id);
    expect(afterMade).toEqual({ status: "PENDING_DOCUMENT" });

    domain.completeSettlementDocuments(String(settlement.id), { document_reference: "doc-1" }, "idem-legacy-docs-1");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "SETTLED" });
  });

  it("legacy CANCELLED_BEFORE_PAYMENT still works exactly as before", () => {
    const { db, domain } = fresh(); track(db);
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, ?, 'Legacy', 'Legacy Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000, datetime('now'))`).run(agentId, `legacy2-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city2-${cityId.slice(0, 8)}`);
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address, fulfillment_status, sales_status, completed_at)
      VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1', 'COMPLETED', 'CLOSED', CURRENT_TIMESTAMP)`).run(occurrenceId, cityId);
    seedLegacyReferralReward(db, agentId, occurrenceId, 3000);

    const settlement = domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 3000, method: "bank_transfer" }, "idem-legacy-cancel-1", "admin-1");
    domain.cancelSettlementBeforePayment(String(settlement.id), { confirmation_text: `NOT PAID ${settlement.id}`, reason: "changed mind" }, "idem-legacy-cancel-2");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlement.id)).toEqual({ status: "CANCELLED_BEFORE_PAYMENT" });
  });

  it("legacy recoveries still work exactly as before", () => {
    const { db, domain } = fresh(); track(db);
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, ?, 'Legacy', 'Legacy Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000, datetime('now'))`).run(agentId, `legacy3-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city3-${cityId.slice(0, 8)}`);
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address, fulfillment_status, sales_status, completed_at)
      VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1', 'COMPLETED', 'CLOSED', CURRENT_TIMESTAMP)`).run(occurrenceId, cityId);
    seedLegacyReferralReward(db, agentId, occurrenceId, 5000);
    const settlement = domain.prepareSettlement({ agent_id: agentId, occurrence_id: occurrenceId, amount_kopecks: 5000, method: "bank_transfer" }, "idem-legacy-recover-1", "admin-1");
    domain.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "idem-legacy-recover-2");
    const recovery = domain.addSettlementRecovery(String(settlement.id), { amount_recovered_kopecks: 1000, recovered_at: new Date().toISOString(), method: "bank_transfer", evidence_reference: "ev-1" }, "idem-legacy-recover-3");
    expect(recovery.amount_recovered_kopecks).toBe(1000);
  });

  it("historical settlement_flow NULL reads as LEGACY - a pre-0047 row is unaffected by the new legacy-transition filters", () => {
    const { db, domain } = fresh(); track(db);
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, ?, 'Legacy', 'Legacy Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000, datetime('now'))`).run(agentId, `legacy4-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city4-${cityId.slice(0, 8)}`);
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address, fulfillment_status, sales_status, completed_at)
      VALUES (?, ?, 'FLEXPERIMENT', '2020-10-01T10:00:00.000Z', '2020-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1', 'COMPLETED', 'CLOSED', CURRENT_TIMESTAMP)`).run(occurrenceId, cityId);
    // The migration itself backfills historical NULL to 'LEGACY' via ALTER TABLE's own default (0047), so no row in a post-migration database can
    // actually be NULL - this test proves the FILTER still matches a genuinely 'LEGACY'-flow row exactly as it would a truly historical one.
    const settlementId = randomUUID();
    db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id, settlement_flow)
      VALUES (?, ?, ?, 4000, 'bank_transfer', 'PREPARED', 'SELF_EMPLOYED', datetime('now'), 'admin-1', 'LEGACY')`).run(settlementId, agentId, occurrenceId);
    domain.markSettlementPaymentMade(settlementId, "I confirm the money was transferred", "idem-legacy-historical-1");
    expect(db.prepare("SELECT status FROM reward_settlements WHERE id = ?").get(settlementId)).toEqual({ status: "PENDING_DOCUMENT" });
  });
});

describe("SettlementError surfaces its own code", () => {
  it("preparePartnerSettlement for a nonexistent snapshot throws AGENT_REFERRALS_SETTLEMENT_EFFECTIVE_SNAPSHOT_NOT_FOUND", () => {
    const { db } = fresh(); track(db);
    readyPartner(db);
    try {
      preparePartnerSettlement(db, admin, "no-such-snapshot");
      throw new Error("expected to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SettlementError);
      expect((error as SettlementError).code).toBe("AGENT_REFERRALS_SETTLEMENT_EFFECTIVE_SNAPSHOT_NOT_FOUND");
    }
  });
});
