import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { agentReferralsReviewQueue } from "../src/agent-referrals-review-queue";
import { reportDistribution, claimRemoval, markRemovalUnverified } from "../src/agent-referrals-distribution";
import { mintCreativeRevision, authorizeCreative } from "../src/agent-referrals-creative";
import { generateSettlementAct } from "../src/agent-referrals-act";
import { beginPayment, recordPayoutUnknown } from "../src/agent-referrals-payment";
import { recordNpdStatusCheck } from "../src/agent-referrals-npd";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner } from "../src/agent-referrals-partner-identity";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import type { PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, finalizedSettlement, acceptedAct } from "./support/agent-referrals-settlement-fixtures";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const track = (db: Database.Database) => { open.push(db); return db; };
const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

describe("agent-referrals-review-queue.ts: live-derived operator findings, never a stored table", () => {
  it("returns every category empty (total 0, no items, not truncated) on a fresh, all-DORMANT database", () => {
    const { db } = fresh();
    track(db);
    const queue = agentReferralsReviewQueue(db, new Date().toISOString());
    for (const category of Object.values(queue)) expect(category).toEqual({ total: 0, items: [], truncated: false });
  });

  it("surfaces a distribution reported on a BLOCKED/unreviewed channel under distributions_review_required, carrying its owning engagement_id so an operator can navigate to it - the fact is persisted (§B-5e), never dropped", () => {
    const { db } = fresh();
    track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    // No policy row exists for "unreviewed-channel" - resolves REVIEW_REQUIRED by the channel-policy fallback.
    const { distribution_id: distributionId } = reportDistribution(db, admin, engagementId, {
      channel_key: "unreviewed-channel", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://example.test/x",
      published_at: "2020-01-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1",
    });
    const queue = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(queue.distributions_review_required).toEqual({ total: 1, items: [{ distribution_id: distributionId, engagement_id: engagementId }], truncated: false });
  });

  it("surfaces a distribution marked REMOVAL_UNVERIFIED under distributions_removal_overdue", () => {
    const { db } = fresh();
    track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const creative = mintCreativeRevision(db, admin, engagementId, {
      format_kind: "post", media_ref: null, copy_text: "copy", cta_text: null, mandatory_labeling_text: "Реклама", creative_target_url: "https://flexperiment.ru/city?promo=ART",
    });
    authorizeCreative(db, admin, engagementId, creative.id);
    const { distribution_id: distributionId } = reportDistribution(db, admin, engagementId, {
      channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1",
      published_at: new Date().toISOString(), ended_at: null, evidence_ref: "ev-1",
    });
    claimRemoval(db, p1.partner, distributionId, "claimed-evidence");
    markRemovalUnverified(db, admin, distributionId, "cannot confirm removal");
    const queue = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(queue.distributions_removal_overdue).toEqual({ total: 1, items: [{ distribution_id: distributionId, engagement_id: engagementId }], truncated: false });
  });

  it("surfaces an act generated but not yet presented under acts_awaiting_presentation, carrying its engagement_id and settlement_id", () => {
    const { db, domain } = fresh();
    track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "customer@example.test", `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    const { act } = generateSettlementAct(db, admin, settlement.id);
    const queue = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(queue.acts_awaiting_presentation).toEqual({ total: 1, items: [{ act_id: act.id, engagement_id: engagementId, settlement_id: settlement.id }], truncated: false });
  });

  it("surfaces a PAYOUT_UNKNOWN payment attempt under payment_attempts_payout_unknown, joined to its owning engagement_id for navigation", () => {
    const { db, domain } = fresh();
    track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "customer@example.test", `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    acceptedAct(db, p1.partner, settlement);
    const { attempt } = beginPayment(db, admin, settlement.id);
    recordPayoutUnknown(db, admin, attempt.id, "provider response ambiguous");

    const queue = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(queue.payment_attempts_payout_unknown).toEqual({ total: 1, items: [{ payment_attempt_id: attempt.id, settlement_id: settlement.id, engagement_id: engagementId }], truncated: false });
  });

  it("surfaces an accepted, undisputed NPD settlement with no fresh usable NPD check under npd_reconciliation_needed, and stops surfacing it once a fresh ACTIVE check is on file", () => {
    const { db, domain } = fresh();
    track(db);
    const p1 = readyPartner(db, "NPD");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "customer@example.test", `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    acceptedAct(db, p1.partner, settlement);

    const beforeCheck = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(beforeCheck.npd_reconciliation_needed).toEqual({ total: 1, items: [{ settlement_id: settlement.id, partner_identity_id: p1.partnerIdentityId }], truncated: false });

    recordNpdStatusCheck(db, admin, p1.partnerIdentityId, "ACTIVE", "manual-fns-check-1");
    const afterCheck = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(afterCheck.npd_reconciliation_needed).toEqual({ total: 0, items: [], truncated: false });
  });

  it("surfaces a partner stuck at PROFILE_SUBMITTED / PROFILE_VERIFIED under the two onboarding categories, and clears once the admin advances them", () => {
    const { db } = fresh();
    track(db);
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'p1', 'A', 'A Legal', 'a@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId);
    const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
    const asPartner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" };
    submitPartnerLegalProfile(db, asPartner, "INDIVIDUAL", "NPD");

    const submitted = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(submitted.partners_profile_pending_verification).toEqual({ total: 1, items: [{ partner_identity_id: partnerIdentityId }], truncated: false });
    expect(submitted.partners_framework_not_issued).toEqual({ total: 0, items: [], truncated: false });

    verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");
    const verified = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(verified.partners_profile_pending_verification).toEqual({ total: 0, items: [], truncated: false });
    expect(verified.partners_framework_not_issued).toEqual({ total: 1, items: [{ partner_identity_id: partnerIdentityId }], truncated: false });

    const fw = mintFrameworkAgreementRevision(db, clause(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES));
    const dt = mintDelegationTemplateRevision(db, clause(DELEGATION_TEMPLATE_REQUIRED_CLAUSES));
    issueFrameworkToPartner(db, admin, partnerIdentityId, fw.id, dt.id, "issued");
    const issued = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(issued.partners_framework_not_issued).toEqual({ total: 0, items: [], truncated: false });
  });

  it("round-3 fix: total is never silently capped at the item-page size, and truncated is set once the real count exceeds it", () => {
    const { db } = fresh();
    track(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    // 51 distributions on an unreviewed channel - one more than the item
    // page size (50, agent-referrals-review-queue.ts's own MAX_ITEMS_PER_CATEGORY).
    for (let i = 0; i < 51; i += 1) {
      reportDistribution(db, admin, engagementId, {
        channel_key: "unreviewed-channel", resource_kind: "channel", resource_identifier: `x-${i}`, distribution_resource_url: `https://example.test/x-${i}`,
        published_at: "2020-01-01T00:00:00.000Z", ended_at: null, evidence_ref: `ev-${i}`,
      });
    }
    const queue = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(queue.distributions_review_required.total).toBe(51);
    expect(queue.distributions_review_required.items).toHaveLength(50);
    expect(queue.distributions_review_required.truncated).toBe(true);
    // Items are deterministically ordered (oldest-reported first, per the
    // query's own ORDER BY rowid ASC) - the same call twice returns the
    // identical page, never an arbitrary/unstable subset.
    const again = agentReferralsReviewQueue(db, new Date().toISOString());
    expect(again.distributions_review_required.items).toEqual(queue.distributions_review_required.items);
  });
});
