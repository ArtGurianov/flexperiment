import type Database from "better-sqlite3";
import { getPartnerIdentity } from "./agent-referrals-onboarding";
import { getEngagement, lastActivatedEngagementRevision, occurrenceFacts } from "./agent-referrals-engagement";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { isDelegationEffective } from "./agent-referrals-delegation-revocation";
import { currentEngagementPromoAuthorizationForEngagement, partnerPromoByPartnerId } from "./agent-referrals-promo";
import { currentCreativeAuthorization, creativeRevisionById } from "./agent-referrals-creative";
import { ordCreativeRegistrationForCreativeRevision } from "./agent-referrals-ord-creative-registration";

/**
 * CREATIVE_READY_TO_PUBLISH (plan section B-5e), now complete end to end.
 * Takes only an engagement id - deliberately no options object at all, so
 * there is structurally nowhere to smuggle a channel_id or a
 * distribution_resource_url into this call - the provider half (below)
 * takes no such argument either. It never requires a
 * distribution_resource_url (that value does not exist until AFTER
 * publication - see agent-referrals-distribution.ts) and contains no
 * capacity check in either half.
 *
 * creative_target_url is compared against the canonical Flexperiment
 * target URL, built exactly to the shape the plan's own §B-9 example uses
 * (https://flexperiment.ru/<city-slug>?promo=<CODE>) - not an invented
 * format.
 *
 * The provider half (PR8, 0048) proves the frozen registration/ERID facts:
 * a registration exists for the CURRENT creative revision, it has reached
 * EXTERNALLY_LOCKED (erid present is a direct consequence of that lock -
 * the migration's own CHECK constraint on ord_creative_registrations makes
 * "locked but no erid" structurally impossible), and its own pinned
 * registered_creative_target_url still agrees with the creative's real
 * target url (defense in depth against a future bug that could otherwise
 * let the two silently diverge). The failure is no longer "provider tables
 * unavailable" - it names the actual missing/invalid registration evidence.
 */

export class CreativeReadinessError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const canonicalFlexperimentTargetUrl = (citySlug: string, promoCode: string): string => `https://flexperiment.ru/${citySlug}?promo=${promoCode}`;

export type CreativeReadyToPublishEvidence = { engagement_id: string; creative_revision_id: string; ord_registration_id: string; erid: string };

/** Throws a local or provider defect code; returns the readiness evidence only when every prerequisite - local AND provider - genuinely holds. */
export const assessCreativeReadyToPublish = (db: Database.Database, engagementId: string): CreativeReadyToPublishEvidence => {
  // Readiness IS an assertion of NEW_PUBLICATION_AUTHORITY (identical class
  // to authorizeCreative's own gate) - global SUSPENDED must refuse it even
  // when every per-engagement prerequisite below still holds (Phase 5
  // holistic review, P0 finding 1): SUSPENDED blocks new publication
  // authority while still permitting the reporting tail for publications
  // that already exist.
  assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "NEW_PUBLICATION_AUTHORITY");

  const engagement = getEngagement(db, engagementId);
  if (!engagement) throw new CreativeReadinessError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);

  const partner = getPartnerIdentity(db, engagement.partner_identity_id)!;
  if (partner.onboarding_state !== "PARTNER_ACTIVE") throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_PARTNER_NOT_ACTIVE", 409, partner.onboarding_state);
  if (engagement.lifecycle_state !== "ACTIVE") throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_ENGAGEMENT_NOT_ACTIVE", 409, engagement.lifecycle_state);
  if (!isDelegationEffective(db, engagement.partner_identity_id)) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_DELEGATION_NOT_EFFECTIVE", 409);

  // The revision an admin most recently ACTIVATED, never the latest
  // AUTHORED (draft) one - a simple admin draft R2 must not break
  // publication readiness for the still-live R1 (Phase 5 review note 7).
  const revision = lastActivatedEngagementRevision(db, engagementId);
  if (!revision) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_ENGAGEMENT_NOT_ACTIVE", 409, engagementId);
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

  // Provider half (PR8): the CURRENT creative revision must have a
  // registration that has actually reached EXTERNALLY_LOCKED. A DRAFT or
  // SUBMITTED-but-unconfirmed registration is not readiness - VK has not
  // yet told us the ERID.
  const registration = ordCreativeRegistrationForCreativeRevision(db, creative.id);
  if (!registration) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_ORD_REGISTRATION_MISSING", 409, creative.id);
  if (registration.lock_state !== "EXTERNALLY_LOCKED" || !registration.erid) throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_ORD_ERID_MISSING", 409, registration.id);
  if (registration.registered_creative_target_url !== expectedUrl) {
    throw new CreativeReadinessError("AGENT_REFERRALS_READINESS_ORD_REGISTERED_TARGET_URL_MISMATCH", 409, `${registration.registered_creative_target_url} != ${expectedUrl}`);
  }

  return { engagement_id: engagementId, creative_revision_id: creative.id, ord_registration_id: registration.id, erid: registration.erid };
};
