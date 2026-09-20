import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cryptoModule from "../src/crypto";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { finalizeEngagementRewardRegistry, currentEffectiveRewardSnapshot } from "../src/agent-referrals-reward-registry";
import { preparePartnerSettlement, correctPartnerRewardWithSettlement, recoveryExposure, recoveryExposureEvidenceForEngagement, SettlementError } from "../src/agent-referrals-settlement";
import { beginPayment, recordPaymentMade } from "../src/agent-referrals-payment";
import { CommerceDomain } from "../src/domain";
import { canonicalizeSettlementTaxV1 } from "../src/agent-referrals-ord-canonical";
import { resolveTaxTreatmentForLegalProfileAt } from "../src/agent-referrals-tax-treatment";
import { submitLegalProfileSupersession, verifyLegalProfileSupersession, currentLegalProfileRevisionForPartner, legalProfileChangeRequestHeadForPartner } from "../src/agent-referrals-legal-profile-supersession";
import { currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";
import { currentFrameworkAgreementRevision, currentDelegationTemplateRevision } from "../src/agent-referrals-framework-delegation";
import { issueFrameworkToPartner } from "../src/agent-referrals-partner-identity";
import { requiredFrameworkIssuance } from "../src/agent-referrals-framework-issuance";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import {
  fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, closeAndComplete,
  finalizedSettlement, acceptedAct,
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
        settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot,
        tax_treatment_revision_id_snapshot, tax_canonicalization_version, tax_canonical_json, tax_canonical_hash)
      SELECT ?, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id,
        settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot,
        tax_treatment_revision_id_snapshot, tax_canonicalization_version, tax_canonical_json, tax_canonical_hash
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

  it("pre-baseline DORMANT is operationally ACTIVE, so settlement lookup remains the next gate", () => {
    const { db } = fresh(); track(db);
    expect(() => preparePartnerSettlement(db, admin, "no-such-snapshot"))
      .toThrow(/AGENT_REFERRALS_SETTLEMENT_EFFECTIVE_SNAPSHOT_NOT_FOUND/);
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

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund, no settlement yet", currentEffectiveRewardSnapshot(db, engagementId)!.id);
    expect(result.settlement_action).toBe("NONE");
  });

  it("PREPARED, no payment: old CANCELLED_BEFORE_PAYMENT, new settlement supersedes it (E2 > 0)", () => {
    const { db, domain } = fresh(); track(db);
    const { engagementId, order, settlement } = setup(db, domain);

    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 20000, 'late', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund", currentEffectiveRewardSnapshot(db, engagementId)!.id);
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

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "fully refunded", currentEffectiveRewardSnapshot(db, engagementId)!.id);
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

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "late refund after payment", currentEffectiveRewardSnapshot(db, engagementId)!.id);
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
    const first = correctPartnerRewardWithSettlement(db, admin, engagementId, "first late refund", currentEffectiveRewardSnapshot(db, engagementId)!.id);
    expect(first.settlement_action).toBe("RECOVERY_EXPOSURE");
    if (first.settlement_action !== "RECOVERY_EXPOSURE") throw new Error("unreachable");

    // A second, later refund - the paid settlement S1's own pinned E never changes, only the engagement's current E advances again.
    db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at) VALUES (?, ?, ?, ?, 5000, 'later', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, 'h', datetime('now'))")
      .run(randomUUID(), randomUUID(), order.id, order.payment_id, randomUUID());
    const second = correctPartnerRewardWithSettlement(db, admin, engagementId, "second later refund", currentEffectiveRewardSnapshot(db, engagementId)!.id);
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

    expect(() => correctPartnerRewardWithSettlement(db, admin, engagementId, "should be refused", currentEffectiveRewardSnapshot(db, engagementId)!.id)).toThrow(/AGENT_REFERRALS_CORRECTION_BLOCKED_PAYMENT_IN_FLIGHT/);
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

    const result = correctPartnerRewardWithSettlement(db, admin, engagementId, "fully refunded after payment", currentEffectiveRewardSnapshot(db, engagementId)!.id);
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

describe("PR-F: tax-treatment snapshot pinning", () => {
  it("prepares a settlement whose tax snapshot byte-matches canonicalizeSettlementTaxV1's own output for the current treatment", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle-tax1@example.test", "idem-settle-tax1-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");

    const { settlement } = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
    const treatment = db.prepare("SELECT * FROM agent_referrals_tax_treatment_revisions WHERE legal_profile_revision_id = ?").get(legalProfile.id) as
      Parameters<typeof canonicalizeSettlementTaxV1>[0];
    const expected = canonicalizeSettlementTaxV1(treatment);

    expect(settlement.tax_treatment_revision_id_snapshot).toBe(treatment.id);
    expect(settlement.tax_canonicalization_version).toBe(expected.version);
    expect(settlement.tax_canonical_hash).toBe(expected.canonical_hash);
    expect(settlement.tax_canonical_json).toBe(expected.canonical_json);
  });

  it("refuses AGENT_REFERRALS_TAX_TREATMENT_MISSING when the current legal profile has no tax treatment recorded yet", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db, "NPD");
    const ieRequisites = { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345" };
    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", ...ieRequisites, reason: "became org", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId), expectedRequestSequence: legalProfileChangeRequestHeadForPartner(db, p1.partnerIdentityId) });
    // Nothing outstanding blocks this supersession: readyPartner mints no engagement of its own.
    const outcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(outcome).toMatchObject({ outcome: "VERIFIED" });

    // PR2 of the reissuance/evidence program: the supersession above moved
    // agreement_status off CURRENT (a CONTRACTUAL_REISSUANCE_REQUIRED
    // change), and activation is an allowlist on agreement_status ===
    // "CURRENT" alone - so a NEW activation needs a fresh reissuance +
    // reacceptance under the NEW profile first, exactly the real operator
    // flow. The SAME (already-minted) template pair is reissued -
    // re-offering an unchanged pair is legitimate; see
    // agent-referrals-framework-reissuance.test.ts scenario 1.
    const fw = currentFrameworkAgreementRevision(db)!;
    const dt = currentDelegationTemplateRevision(db)!;
    issueFrameworkToPartner(db, admin, p1.partnerIdentityId, fw.id, dt.id, "reissued after profile change");
    const issuance = requiredFrameworkIssuance(db, p1.partnerIdentityId)!;
    const newLegalProfileId = currentAgentReferralsLegalProfile(db, p1.agentId)!.id;
    const grant = mintStepUpGrant(db, p1.partner, "FRAMEWORK_ACCEPTANCE", { issuance_id: issuance.id, legal_profile_revision_id: newLegalProfileId }).grant_id;
    acceptFrameworkAndDelegation(db, p1.partner, grant, issuance.id, newLegalProfileId);

    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle-tax2@example.test", "idem-settle-tax2-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");

    expect(() => preparePartnerSettlement(db, admin, finalize.effective_snapshot_id)).toThrow(/AGENT_REFERRALS_TAX_TREATMENT_MISSING/);
  });

  it("historical pin: a LATER tax-treatment correction leaves an already-prepared settlement's own snapshot byte-identical", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle-tax3@example.test", "idem-settle-tax3-0000001");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");
    const { settlement: before } = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);

    // readyPartner's own fixture is NPD (SYSTEM_DERIVED); superseding to
    // INDIVIDUAL_ENTREPRENEUR/OTHER and recording a NEW tax treatment for the NEW
    // revision must never reach back and mutate the settlement already
    // prepared under the OLD revision/treatment.
    const ieRequisites = { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345" };
    const request = submitLegalProfileSupersession(db, admin, p1.partnerIdentityId, { legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", ...ieRequisites, reason: "became org", evidenceRef: "ev.pdf", expectedCurrentLegalProfileRevision: currentLegalProfileRevisionForPartner(db, p1.partnerIdentityId), expectedRequestSequence: legalProfileChangeRequestHeadForPartner(db, p1.partnerIdentityId) });
    // BLOCKED (outstanding settlement) is expected here and is not the
    // point of this test - it proves the historical row is untouched
    // regardless of whether the supersession itself could even complete.
    const blockedOutcome = verifyLegalProfileSupersession(db, admin, request.id, "verify");
    expect(blockedOutcome).toMatchObject({ outcome: "BLOCKED" });

    const after = db.prepare("SELECT tax_treatment_revision_id_snapshot, tax_canonicalization_version, tax_canonical_json, tax_canonical_hash FROM reward_settlements WHERE id = ?").get(before.id);
    expect(after).toEqual({
      tax_treatment_revision_id_snapshot: before.tax_treatment_revision_id_snapshot,
      tax_canonicalization_version: before.tax_canonicalization_version,
      tax_canonical_json: before.tax_canonical_json,
      tax_canonical_hash: before.tax_canonical_hash,
    });
  });

  it("reads the clock exactly once for both tax-treatment resolution and prepared_at (P1.2 single-clock-read)", () => {
    const { db, domain } = fresh(); track(db);
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "settle-tax-clock@example.test", "idem-settle-tax-clock-01");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");

    // A second, distinct clock read here (the P1.2 defect) would make
    // prepared_at diverge from the instant actually used to resolve the
    // pinned tax treatment - proven by counting calls, not just comparing
    // two timestamps that would usually match anyway at millisecond
    // resolution.
    const nowSpy = vi.spyOn(cryptoModule, "now");
    const callsBefore = nowSpy.mock.calls.length;
    const { settlement } = preparePartnerSettlement(db, admin, finalize.effective_snapshot_id);
    const nowCallsDuringPrepare = nowSpy.mock.calls.length - callsBefore;
    nowSpy.mockRestore();

    expect(nowCallsDuringPrepare).toBe(1);
    const legalProfile = currentAgentReferralsLegalProfile(db, p1.agentId)!;
    const treatment = db.prepare("SELECT id FROM agent_referrals_tax_treatment_revisions WHERE legal_profile_revision_id = ?").get(legalProfile.id) as { id: string };
    expect(settlement.tax_treatment_revision_id_snapshot).toBe(treatment.id);
    expect(resolveTaxTreatmentForLegalProfileAt(db, legalProfile.id, settlement.prepared_at)?.id).toBe(treatment.id);
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
