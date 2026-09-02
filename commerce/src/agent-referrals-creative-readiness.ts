import type Database from "better-sqlite3";
import { getPartnerIdentity } from "./agent-referrals-onboarding";
import { getEngagement, currentEngagementRevision, occurrenceFacts } from "./agent-referrals-engagement";
import { isDelegationEffective } from "./agent-referrals-delegation-revocation";
import { currentEngagementPromoAuthorizationForEngagement, partnerPromoByPartnerId } from "./agent-referrals-promo";
import { currentCreativeAuthorization, creativeRevisionById } from "./agent-referrals-creative";

/**
 * CREATIVE_READY_TO_PUBLISH, local half only (plan section B-5e). Takes
 * only an engagement id - deliberately no options object at all, so there
 * is structurally nowhere to smuggle a channel_id or a
 * distribution_resource_url into this call. Every local prerequisite is
 * checked; if all of them hold, the function still never reports success -
 * the provider-backed half (ORD registration complete, ERID present) does
 * not exist until PR8's 0048 tables land, so this fails closed with
 * PUBLICATION_PROVIDER_PREFLIGHT_UNAVAILABLE rather than silently
 * pretending an absent check passed.
 *
 * creative_target_url is compared against the canonical Flexperiment
 * target URL, built exactly to the shape the plan's own §B-9 example uses
 * (https://flexperiment.ru/<city-slug>?promo=<CODE>) - not an invented
 * format.
 */

export class CreativeReadinessError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const canonicalFlexperimentTargetUrl = (citySlug: string, promoCode: string): string => `https://flexperiment.ru/${citySlug}?promo=${promoCode}`;

/** Always throws: a local defect code, or PUBLICATION_PROVIDER_PREFLIGHT_UNAVAILABLE once every local prerequisite is satisfied. Never returns "ready". */
export const assessCreativeReadyToPublish = (db: Database.Database, engagementId: string): never => {
  const engagement = getEngagement(db, engagementId);
  if (!engagement) throw new CreativeReadinessError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);

  const partner = getPartnerIdentity(db, engagement.partner_identity_id)!;
  if (partner.onboarding_state !== "PARTNER_ACTIVE") throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_PARTNER_NOT_ACTIVE", 409, partner.onboarding_state);
  if (engagement.lifecycle_state !== "ACTIVE") throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_ENGAGEMENT_NOT_ACTIVE", 409, engagement.lifecycle_state);
  if (!isDelegationEffective(db, engagement.partner_identity_id)) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_DELEGATION_NOT_EFFECTIVE", 409);

  const revision = currentEngagementRevision(db, engagementId)!;
  const now = Date.now();
  if (now < new Date(revision.publication_start_at).getTime() || now > new Date(revision.publication_end_at).getTime()) {
    throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_PUBLICATION_WINDOW_CLOSED", 409);
  }

  const promoAuthorization = currentEngagementPromoAuthorizationForEngagement(db, engagementId);
  if (!promoAuthorization || promoAuthorization.engagement_revision_id !== revision.id) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_PROMO_AUTHORIZATION_MISSING", 409);

  const creativeAuthorization = currentCreativeAuthorization(db, engagementId);
  if (!creativeAuthorization || creativeAuthorization.engagement_revision_id !== revision.id) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_CREATIVE_AUTHORIZATION_MISSING", 409);
  const creative = creativeRevisionById(db, creativeAuthorization.creative_revision_id)!;

  const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
  const city = db.prepare("SELECT slug FROM cities WHERE id = ?").get(occurrence.city_id) as { slug: string };
  const partnerPromo = partnerPromoByPartnerId(db, partner.agent_id);
  if (!partnerPromo) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_PARTNER_HAS_NO_PROMO", 409);
  const promoCode = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(partnerPromo.promo_code_id) as { code: string };
  const expectedUrl = canonicalFlexperimentTargetUrl(city.slug, promoCode.code);
  if (creative.creative_target_url !== expectedUrl) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_CREATIVE_TARGET_URL_MISMATCH", 409, `${creative.creative_target_url} != ${expectedUrl}`);

  // Every local prerequisite holds. The provider half (ORD registration
  // complete, ERID present) has no schema to check against until 0048 -
  // fail closed rather than report readiness this PR cannot actually prove.
  throw new CreativeReadinessError("PUBLICATION_PROVIDER_PREFLIGHT_UNAVAILABLE", 503);
};
