import type Database from "better-sqlite3";
import { getPartnerIdentity } from "./agent-referrals-onboarding";
import { currentAgentReferralsLegalProfile } from "./agent-referrals-legal-profile";
import { frameworkAgreementRevisionById, delegationTemplateRevisionById } from "./agent-referrals-framework-delegation";
import { currentPayoutProfile } from "./agent-referrals-payout-profile";
import { partnerPromoByPartnerId } from "./agent-referrals-promo";
import { isDelegationEffective } from "./agent-referrals-delegation-revocation";
import {
  getEngagement, engagementsForPartner, currentEngagementRevision, lastActivatedEngagementRevision,
} from "./agent-referrals-engagement";
import { currentCreativeRevision, currentCreativeAuthorization } from "./agent-referrals-creative";
import { currentOrdCreativeRegistrationForCreativeRevision } from "./agent-referrals-ord-creative-registration";
import { getDistribution, distributionsForEngagement, distributionProjection } from "./agent-referrals-distribution";
import { ordDistributionPeriodReportsForDistribution } from "./agent-referrals-ord-reporting";
import { currentEffectiveRewardSnapshot, rewardRegistrySnapshot } from "./agent-referrals-reward-registry";
import { zeroRewardClosureForEngagement } from "./agent-referrals-zero-reward-closure";
import { settlementForEffectiveSnapshot } from "./agent-referrals-settlement";
import { settlementActForSettlement, actAcceptanceForAct, actDisputeForAct } from "./agent-referrals-act";
import { paymentAttemptsForSettlement } from "./agent-referrals-payment";
import { latestNpdStatusCheck } from "./agent-referrals-npd";
import { rewardForOrder, type RewardOrderFacts } from "./reward-calculation";

/**
 * §B-11: the ONE explicit allowlist projection every `/v1/partner/*` read
 * goes through. The admin/order serializer is never reused here - every
 * function below selects an explicit column list and returns an explicit
 * DTO shape, so a customer PII column added to `orders` (or any other
 * table) in a later PR cannot silently leak into a partner response merely
 * by widening a `SELECT *`.
 *
 * Every function that names an engagement, distribution or other owned
 * resource takes the CALLER's own partnerIdentityId (resolved server-side
 * from the session, never accepted as a caller-supplied parameter - see
 * agent-referrals-api-partner.ts) and independently proves ownership before
 * returning anything. A resource that exists but belongs to a different
 * partner is refused exactly like one that does not exist at all, never
 * distinguished by response shape.
 */

export class PartnerProjectionError extends Error {
  constructor(readonly code: string, readonly status = 404, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const ownedEngagement = (db: Database.Database, partnerIdentityId: string, engagementId: string) => {
  const engagement = getEngagement(db, engagementId);
  if (!engagement) throw new PartnerProjectionError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
  if (engagement.partner_identity_id !== partnerIdentityId) throw new PartnerProjectionError("AGENT_REFERRALS_ENGAGEMENT_WRONG_PARTNER", 403, engagementId);
  return engagement;
};

/** Exported for the API layer: distribution-scoped partner mutations (correctDistribution, claimRemoval) need the same ownership proof without re-fetching the full detail projection. */
export const assertPartnerOwnsDistribution = (db: Database.Database, partnerIdentityId: string, distributionId: string): void => {
  const distribution = getDistribution(db, distributionId);
  if (!distribution) throw new PartnerProjectionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
  ownedEngagement(db, partnerIdentityId, distribution.engagement_id);
};

/** Exported for the API layer: engagement-scoped partner mutations (acceptEngagement, distribution reporting, ...) need the same ownership proof without re-fetching the full detail projection. */
export const assertPartnerOwnsEngagement = (db: Database.Database, partnerIdentityId: string, engagementId: string): void => {
  ownedEngagement(db, partnerIdentityId, engagementId);
};

export type PartnerProfileProjection = {
  partner_identity_id: string;
  email: string;
  onboarding_state: string;
  submitted_legal_form: string | null;
  submitted_tax_mode: string | null;
  legal_profile: { legal_form: string; tax_mode: string; projected_contractor_type: string; revision: number; created_at: string } | null;
  payout_profile: ReturnType<typeof currentPayoutProfile>;
  promo_code: string | null;
  delegation_effective: boolean;
};

/** §B-11: "own legal profile and its revisions" + "own promo" + payout profile (redacted at the source - currentPayoutProfile never selects key/ciphertext/nonce). */
export const partnerProfileProjection = (db: Database.Database, partnerIdentityId: string): PartnerProfileProjection => {
  const identity = getPartnerIdentity(db, partnerIdentityId);
  if (!identity) throw new PartnerProjectionError("PARTNER_IDENTITY_NOT_FOUND", 404, partnerIdentityId);
  const legalProfile = currentAgentReferralsLegalProfile(db, identity.agent_id);
  const partnerPromo = partnerPromoByPartnerId(db, identity.agent_id);
  const promoCode = partnerPromo
    ? (db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(partnerPromo.promo_code_id) as { code: string } | undefined)
    : undefined;
  return {
    partner_identity_id: identity.id,
    email: identity.email,
    onboarding_state: identity.onboarding_state,
    submitted_legal_form: identity.submitted_legal_form,
    submitted_tax_mode: identity.submitted_tax_mode,
    legal_profile: legalProfile
      ? { legal_form: legalProfile.legal_form, tax_mode: legalProfile.tax_mode, projected_contractor_type: legalProfile.projected_contractor_type, revision: legalProfile.revision, created_at: legalProfile.created_at }
      : null,
    payout_profile: currentPayoutProfile(db, partnerIdentityId),
    promo_code: promoCode?.code ?? null,
    delegation_effective: isDelegationEffective(db, partnerIdentityId),
  };
};

/** §B-11: "own agreements and accepted revisions". Never issued -> `{ issued: false }`, not an error - a partner mid-onboarding legitimately has nothing here yet. */
export const partnerAgreementsProjection = (db: Database.Database, partnerIdentityId: string) => {
  const issuance = db.prepare(`SELECT framework_agreement_revision_id, delegation_template_revision_id, issued_at FROM framework_issuances WHERE partner_identity_id = ?`)
    .get(partnerIdentityId) as { framework_agreement_revision_id: string; delegation_template_revision_id: string; issued_at: string } | undefined;
  if (!issuance) return { issued: false as const };

  const agreement = frameworkAgreementRevisionById(db, issuance.framework_agreement_revision_id);
  const delegationTemplate = delegationTemplateRevisionById(db, issuance.delegation_template_revision_id);
  const acceptance = db.prepare(`SELECT id, created_at FROM framework_acceptances WHERE partner_identity_id = ? AND framework_agreement_revision_id = ? AND delegation_template_revision_id = ?`)
    .get(partnerIdentityId, issuance.framework_agreement_revision_id, issuance.delegation_template_revision_id) as { id: string; created_at: string } | undefined;
  const delegation = db.prepare(`SELECT d.id AS id, r.created_at AS revoked_at FROM ord_reporting_delegations d
      LEFT JOIN ord_reporting_delegation_revocations r ON r.ord_reporting_delegation_id = d.id WHERE d.partner_identity_id = ?`)
    .get(partnerIdentityId) as { id: string; revoked_at: string | null } | undefined;

  return {
    issued: true as const,
    issued_at: issuance.issued_at,
    // Pinned ids the partner portal must echo back verbatim when accepting
    // (acceptFrameworkAndDelegation checks them against framework_issuances
    // exactly - see that module's own header) - exposed at the top level,
    // never only nested, so the client never has to assume framework_agreement.id
    // happens to equal the issuance's own pin.
    framework_agreement_revision_id: issuance.framework_agreement_revision_id,
    delegation_template_revision_id: issuance.delegation_template_revision_id,
    framework_agreement: agreement ? { revision: agreement.revision, content: JSON.parse(agreement.content_json) as unknown, created_at: agreement.created_at } : null,
    delegation_template: delegationTemplate ? { revision: delegationTemplate.revision, content: JSON.parse(delegationTemplate.content_json) as unknown, created_at: delegationTemplate.created_at } : null,
    accepted: !!acceptance,
    accepted_at: acceptance?.created_at ?? null,
    delegation_id: delegation?.id ?? null,
    delegation_revoked: !!delegation?.revoked_at,
    delegation_revoked_at: delegation?.revoked_at ?? null,
  };
};

type OccurrenceSummary = { id: string; title: string; starts_at: string; fulfillment_status: string; city_title: string };

const occurrenceSummary = (db: Database.Database, occurrenceId: string): OccurrenceSummary =>
  db.prepare(`SELECT o.id, o.title, o.starts_at, o.fulfillment_status, c.title AS city_title FROM occurrences o JOIN cities c ON c.id = o.city_id WHERE o.id = ?`)
    .get(occurrenceId) as OccurrenceSummary;

/** §B-11: "own engagements (active and closed)" - a summary list, never the full detail projection (that is partnerEngagementDetail, one call per engagement). */
export const partnerEngagementSummaries = (db: Database.Database, partnerIdentityId: string) =>
  engagementsForPartner(db, partnerIdentityId).map((engagement) => ({
    engagement_id: engagement.id,
    lifecycle_state: engagement.lifecycle_state,
    created_at: engagement.created_at,
    occurrence: occurrenceSummary(db, engagement.occurrence_id),
  }));

/** §B-11: "own creative revisions and ERID information" + "own engagements" detail + "own publication and reporting obligations" + "own acts, payment status, dispute status". One ownership-checked read for an entire engagement's portal page. */
export const partnerEngagementDetail = (db: Database.Database, partnerIdentityId: string, engagementId: string) => {
  const engagement = ownedEngagement(db, partnerIdentityId, engagementId);
  const occurrence = occurrenceSummary(db, engagement.occurrence_id);

  const latestRevision = currentEngagementRevision(db, engagementId);
  const activeRevision = lastActivatedEngagementRevision(db, engagementId);
  const latestAccepted = latestRevision
    ? !!db.prepare("SELECT 1 FROM engagement_acceptances WHERE engagement_id = ? AND engagement_revision_id = ?").get(engagementId, latestRevision.id)
    : false;

  const creative = currentCreativeRevision(db, engagementId);
  const creativeAuthorization = currentCreativeAuthorization(db, engagementId);
  const ordRegistration = creative ? currentOrdCreativeRegistrationForCreativeRevision(db, creative.id) : null;

  const distributions = distributionsForEngagement(db, engagementId).map((distribution) => {
    const projection = distributionProjection(db, distribution.id);
    const reports = ordDistributionPeriodReportsForDistribution(db, distribution.id);
    return {
      distribution_id: distribution.id,
      current_revision: projection.current_revision,
      compliance_state: projection.compliance_state,
      removal_state: projection.removal_state,
      reporting_periods: reports.map((report) => ({
        reporting_period_key: report.reporting_period_key, reporting_basis: report.reporting_basis,
        revision: report.revision, statistics_state: report.statistics_state, submission_state: report.submission_state,
        review_required: report.review_required,
      })),
    };
  });

  const registry = rewardRegistrySnapshot(db, engagementId);
  const effective = currentEffectiveRewardSnapshot(db, engagementId);
  const zeroClosure = zeroRewardClosureForEngagement(db, engagementId);
  const settlement = effective ? settlementForEffectiveSnapshot(db, effective.id) : null;
  const act = settlement ? settlementActForSettlement(db, settlement.id) : null;
  const actAcceptance = act ? actAcceptanceForAct(db, act.id) : null;
  const actDispute = act ? actDisputeForAct(db, act.id) : null;
  const paymentAttempts = settlement
    ? paymentAttemptsForSettlement(db, settlement.id).map((attempt) => ({ id: attempt.id, status: attempt.status, amount_kopecks: attempt.amount_kopecks, made_at: attempt.made_at, started_at: attempt.started_at }))
    : [];
  const npdStatus = latestNpdStatusCheck(db, partnerIdentityId);

  return {
    engagement: { id: engagement.id, lifecycle_state: engagement.lifecycle_state, created_at: engagement.created_at },
    occurrence,
    latest_revision: latestRevision,
    latest_revision_accepted: latestAccepted,
    active_revision: activeRevision,
    creative,
    creative_authorization: creativeAuthorization,
    erid: ordRegistration?.local_state === "CONFIRMED" ? ordRegistration.erid : null,
    distributions,
    reward: {
      registry_finalized: !!registry,
      reward_total_kopecks: effective?.reward_total_kopecks ?? null,
      zero_reward_closed: !!zeroClosure,
    },
    settlement: settlement ? { id: settlement.id, status: settlement.status, amount_kopecks: settlement.amount_kopecks } : null,
    // amount_kopecks and engagement_revision_id are exposed alongside id
    // because the partner portal must construct the EXACT same
    // ACT_ACCEPTANCE step-up resource hash acceptSettlementAct() re-derives
    // server-side ({ act_id, amount_kopecks, engagement_revision_id }) -
    // see agent-referrals-act.ts's own consumeSettlementStepUpGrantInTransaction
    // call. Omitting either field would make it impossible for the client
    // to ever mint a grant that validates.
    act: act ? { id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id, presented_at: act.presented_at } : null,
    act_acceptance: actAcceptance,
    act_dispute: actDispute,
    payment_attempts: paymentAttempts,
    npd_status: npdStatus ? { status: npdStatus.status, checked_at: npdStatus.checked_at } : null,
  };
};

export type PartnerConversionRow = {
  reference: string;
  occurrence_title: string;
  occurrence_starts_at: string;
  purchase_at: string;
  promo_code: string | null;
  gross_attributable_sale_kopecks: number;
  reward_amount_kopecks: number;
  booking_status: string;
  payment_status: string;
  refund_status: string;
};

type ConversionRawRow = RewardOrderFacts & {
  reference: string; purchase_at: string; promo_code: string | null; captured_amount_kopecks: number; payment_status: string; booking_status: string;
  occurrence_title: string; occurrence_starts_at: string; refunded_amount_kopecks: number; latest_refund_status: string | null;
};

/**
 * §B-11: "own commercial conversion/reward projection", exactly the carried
 * fields the plan pins - a partner-facing opaque `reference`
 * (`orders.public_status_id`, never `orders.id`, and not expandable into
 * customer PII through this or any other partner endpoint), no customer
 * name/email/phone anywhere in the SELECT list.
 */
export const partnerConversionProjection = (db: Database.Database, partnerIdentityId: string, engagementId: string): PartnerConversionRow[] => {
  ownedEngagement(db, partnerIdentityId, engagementId);
  const rows = db.prepare(`
    SELECT o.public_status_id AS reference, o.created_at AS purchase_at, o.promo_code_snapshot AS promo_code,
      p.captured_amount_kopecks AS captured_amount_kopecks, p.status AS payment_status, b.status AS booking_status,
      o.attributed_agent_id AS attributed_agent_id, o.reward_type_snapshot AS reward_type_snapshot, o.reward_value_snapshot AS reward_value_snapshot,
      oc.title AS occurrence_title, oc.starts_at AS occurrence_starts_at,
      COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS refunded_amount_kopecks,
      (SELECT r2.status FROM refunds r2 WHERE r2.payment_id = p.id ORDER BY r2.created_at DESC LIMIT 1) AS latest_refund_status
    FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id JOIN occurrences oc ON oc.id = o.occurrence_id
    WHERE o.resolved_engagement_id = ? ORDER BY o.created_at DESC`).all(engagementId) as ConversionRawRow[];

  return rows.map((row) => {
    const grossKopecks = Math.max(0, row.captured_amount_kopecks - row.refunded_amount_kopecks);
    const rewardKopecks = row.booking_status === "CONFIRMED" ? rewardForOrder(row, grossKopecks) : 0;
    return {
      reference: row.reference, occurrence_title: row.occurrence_title, occurrence_starts_at: row.occurrence_starts_at,
      purchase_at: row.purchase_at, promo_code: row.promo_code,
      gross_attributable_sale_kopecks: grossKopecks, reward_amount_kopecks: rewardKopecks,
      booking_status: row.booking_status, payment_status: row.payment_status,
      refund_status: row.latest_refund_status ?? "NONE",
    };
  });
};
