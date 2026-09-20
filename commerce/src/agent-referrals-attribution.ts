import type Database from "better-sqlite3";
import { isPromoPartnerOwned, currentEngagementPromoAuthorization } from "./agent-referrals-promo";
import { getEngagement, engagementRevisionById } from "./agent-referrals-engagement";
import { getPartnerIdentity } from "./agent-referrals-onboarding";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted, AgentReferralsSuspensionPolicyError } from "./agent-referrals-suspension-policy";

/**
 * The ONE canonical checkout-time attribution resolution contract (§B-9's
 * six-step chain: promo -> global status -> partner -> occurrence ->
 * current authorization -> ACTIVE engagement on its accepted revision),
 * called from inside the checkout IMMEDIATE transaction only - never at
 * quote time, which stays deliberately non-authoritative (A4-6; PR5's
 * resolveCheckoutPromoTerms already covers quote-time pricing and is
 * untouched here). A partner-owned promo NEVER falls through to the
 * legacy referral-slug or direct path - it simply has no legacy meaning -
 * and an invalid/unavailable partner promo never degrades to a
 * discount-without-attribution order; the caller in domain.ts is expected
 * to have already refused PROMO_NOT_FOUND / PROMO_NOT_ELIGIBLE /
 * PROMO_NO_LONGER_ELIGIBLE and QUOTE_STALE before this ever runs.
 *
 * This is a read-only resolver: it mutates nothing, so it needs no
 * transaction of its own and is safe to call from anywhere already inside
 * one. New authority logic lives here (and in
 * agent-referrals-reward-registry.ts), not in domain.ts, which stays thin
 * wiring (plan A4-8).
 */

export class AgentReferralsAttributionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export const ATTRIBUTION_RULE_VERSION = 1;

/**
 * An ordinary order: either no promo at all, or a plain discount promo that
 * carries no partner reward authority. A discount is a price fact, never a
 * payable. There is exactly one way to earn a partner reward, and it is
 * EngagementScopedOrderAttribution below.
 */
export type DirectOrderAttribution = {
  reward_authority_kind: "DIRECT";
  attributed_agent_id: null;
  explicit_promo_id: string | null;
  resolved_partner_id: null;
  resolved_engagement_id: null;
  resolved_engagement_revision_id: null;
  resolved_promo_authorization_id: null;
  reward_type: null;
  reward_value: null;
  resolution_reason: "DISCOUNT_PROMO" | "DIRECT";
};

export type EngagementScopedOrderAttribution = {
  reward_authority_kind: "ENGAGEMENT_SCOPED";
  attributed_agent_id: string;
  explicit_promo_id: string;
  resolved_partner_id: string;
  resolved_engagement_id: string;
  resolved_engagement_revision_id: string;
  resolved_promo_authorization_id: string;
  reward_type: "PERCENT" | "FIXED";
  reward_value: number;
  resolution_reason: "EXPLICIT_PARTNER_PROMO";
};

export type OrderAttribution = DirectOrderAttribution | EngagementScopedOrderAttribution;

/**
 * `assertAgentReferralsOperationPermitted` is consulted ONLY on the
 * partner-owned-promo branch: an ordinary order carries no partner reward
 * authority at all, so a global suspension has nothing to block there.
 * Suspension blocks new partner attribution, never an ordinary sale.
 */
export const resolveOrderAttribution = (
  db: Database.Database,
  promo: { id: string; agent_id: string | null } | undefined,
  occurrenceId: string,
): OrderAttribution => {
  if (promo && isPromoPartnerOwned(db, promo.id)) {
    try {
      assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "NEW_ATTRIBUTION");
    } catch (error) {
      if (error instanceof AgentReferralsSuspensionPolicyError) throw new AgentReferralsAttributionError(error.code, error.status);
      throw error;
    }
    const authorization = currentEngagementPromoAuthorization(db, promo.id, occurrenceId);
    const engagement = authorization ? getEngagement(db, authorization.engagement_id) : null;
    const revision = authorization ? engagementRevisionById(db, authorization.engagement_revision_id) : null;
    // Structurally, a live (unrevoked) authorization should always imply an
    // ACTIVE engagement (every suspend/close transition revokes it in the
    // same transaction it changes lifecycle_state) - this re-check is
    // defense in depth, not the primary mechanism, and is exactly what
    // catches "authorization superseded between quote and checkout" (the
    // OLD authorization is gone, a NEW one now exists) as well as
    // "engagement suspended/closed between quote and checkout" (no live
    // authorization at all).
    if (!authorization || !engagement || engagement.lifecycle_state !== "ACTIVE" || !revision) {
      throw new AgentReferralsAttributionError("AGENT_REFERRALS_ATTRIBUTION_AUTHORITY_UNAVAILABLE", 409, promo.id);
    }
    // Integration-hardening round-2 #5b: a destroyed identity's engagement
    // can still legitimately be ACTIVE with a live promo authorization
    // (destruction never revokes existing commercial authority chains), so
    // this must independently refuse new checkout attribution rather than
    // rely on onboarding_state, exactly like offerEngagement/
    // activateEngagement/authorizeCreative already do for their own new-
    // authority surfaces.
    const owningIdentity = getPartnerIdentity(db, engagement.partner_identity_id);
    if (owningIdentity?.destroyed_at) {
      throw new AgentReferralsAttributionError("AGENT_REFERRALS_ATTRIBUTION_PARTNER_IDENTITY_DESTROYED", 409, promo.id);
    }
    return {
      reward_authority_kind: "ENGAGEMENT_SCOPED",
      attributed_agent_id: authorization.partner_id,
      explicit_promo_id: promo.id,
      resolved_partner_id: authorization.partner_id,
      resolved_engagement_id: engagement.id,
      resolved_engagement_revision_id: revision.id,
      resolved_promo_authorization_id: authorization.id,
      reward_type: revision.reward_type,
      reward_value: revision.reward_value,
      resolution_reason: "EXPLICIT_PARTNER_PROMO",
    };
  }

  // Everything that is not an explicit partner promo is an ordinary sale. A
  // plain promo is a discount on the price and nothing more; it can never
  // create a payable. The single way a partner earns is the engagement-scoped
  // branch above, so there is no second money path to reconcile here.
  return {
    reward_authority_kind: "DIRECT",
    attributed_agent_id: null,
    explicit_promo_id: promo?.id ?? null,
    resolved_partner_id: null,
    resolved_engagement_id: null,
    resolved_engagement_revision_id: null,
    resolved_promo_authorization_id: null,
    reward_type: null,
    reward_value: null,
    resolution_reason: promo ? "DISCOUNT_PROMO" : "DIRECT",
  };
};
