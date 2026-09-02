import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { validatePromoTerms, PromoPricingError } from "./promo-pricing";
import { getPartnerIdentity, recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { currentAudienceVerification, mintAudienceVerificationEventInTransaction } from "./agent-referrals-audience-verification";
import { consumeEngagementStepUpGrantInTransaction } from "./agent-referrals-engagement-step-up";
import { partnerPromoByPartnerId, mintEngagementPromoAuthorizationInTransaction, revokeEngagementPromoAuthorizationInTransaction } from "./agent-referrals-promo";
import type { AdminPrincipal, PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * Engagement identity, immutable revisions, partner acceptance and
 * activation - four separate authorities per plan section B (Phase 5
 * review note 2), never folded together. A new material revision does not
 * rewrite the old one and is not automatically accepted; admin cannot
 * accept on the partner's behalf (acceptEngagement takes only a
 * PartnerPrincipal); activation is the one privileged transaction that
 * validates and pins every prerequisite as an immutable snapshot.
 */

export class EngagementError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type EngagementLifecycleState = "OFFERED" | "ACCEPTED" | "ACTIVE" | "SUSPENDED" | "CLOSED";

export type EngagementRow = {
  id: string;
  partner_identity_id: string;
  occurrence_id: string;
  lifecycle_state: EngagementLifecycleState;
  lifecycle_revision: number;
  created_by_admin_id: string;
  created_at: string;
  updated_at: string;
};

export const getEngagement = (db: Database.Database, engagementId: string): EngagementRow | null =>
  (db.prepare(`SELECT id, partner_identity_id, occurrence_id, lifecycle_state, lifecycle_revision, created_by_admin_id, created_at, updated_at
    FROM engagements WHERE id = ?`).get(engagementId) as EngagementRow | undefined) ?? null;

export const engagementByPartnerAndOccurrence = (db: Database.Database, partnerIdentityId: string, occurrenceId: string): EngagementRow | null =>
  (db.prepare(`SELECT id, partner_identity_id, occurrence_id, lifecycle_state, lifecycle_revision, created_by_admin_id, created_at, updated_at
    FROM engagements WHERE partner_identity_id = ? AND occurrence_id = ?`).get(partnerIdentityId, occurrenceId) as EngagementRow | undefined) ?? null;

export type EngagementRevisionRow = {
  id: string;
  engagement_id: string;
  revision: number;
  occurrence_material_revision: number;
  reward_type: "PERCENT" | "FIXED";
  reward_value: number;
  customer_discount_type: "NONE" | "PERCENT" | "FIXED";
  customer_discount_value: number;
  publication_start_at: string;
  publication_end_at: string;
  terms_json: string;
  content_hash: string;
  supersedes_revision_id: string | null;
  created_by_admin_id: string;
  reason: string;
  created_at: string;
};

const REVISION_COLUMNS = "id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, supersedes_revision_id, created_by_admin_id, reason, created_at";

/** The LATEST authored (minted) revision - a draft, never itself authority. Never use this to decide what an ACTIVE engagement currently grants; see lastActivatedEngagementRevision below. */
export const currentEngagementRevision = (db: Database.Database, engagementId: string): EngagementRevisionRow | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS} FROM engagement_revisions WHERE engagement_id = ? ORDER BY revision DESC LIMIT 1`)
    .get(engagementId) as EngagementRevisionRow | undefined) ?? null;

export const engagementRevisionById = (db: Database.Database, revisionId: string): EngagementRevisionRow | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS} FROM engagement_revisions WHERE id = ?`).get(revisionId) as EngagementRevisionRow | undefined) ?? null;

/**
 * The revision an admin most recently activated - the authoritative
 * "current forward authority" concept (Phase 5 review note 7), distinct
 * from both "latest authored" (currentEngagementRevision, a draft with no
 * authority of its own) and "accepted" (acceptance alone changes no
 * authority either). Resolved from engagement_activation_events, which
 * persists across suspension - so this stays correct even while the
 * engagement's live promo authorization is currently revoked.
 */
export const lastActivatedEngagementRevision = (db: Database.Database, engagementId: string): EngagementRevisionRow | null => {
  const event = db.prepare("SELECT engagement_revision_id FROM engagement_activation_events WHERE engagement_id = ? ORDER BY rowid DESC LIMIT 1").get(engagementId) as { engagement_revision_id: string } | undefined;
  return event ? engagementRevisionById(db, event.engagement_revision_id) : null;
};

export type OccurrenceFacts = { id: string; city_id: string; fulfillment_status: "SCHEDULED" | "COMPLETED" | "CANCELLED"; sales_status: "OPEN" | "PAUSED" | "CLOSED"; material_revision: number };

export const occurrenceFacts = (db: Database.Database, occurrenceId: string): OccurrenceFacts | null =>
  (db.prepare("SELECT id, city_id, fulfillment_status, sales_status, material_revision FROM occurrences WHERE id = ?").get(occurrenceId) as OccurrenceFacts | undefined) ?? null;

export type EngagementRevisionTerms = {
  reward_type: "PERCENT" | "FIXED";
  reward_value: number;
  customer_discount_type: "NONE" | "PERCENT" | "FIXED";
  customer_discount_value: number;
  publication_start_at: string;
  publication_end_at: string;
  terms: unknown;
};

const revisionContentHash = (terms: EngagementRevisionTerms): string => sha256(canonicalV2(terms as unknown as Record<string, unknown>));

const validateRevisionTerms = (terms: EngagementRevisionTerms): void => {
  try {
    validatePromoTerms(terms.customer_discount_type, terms.customer_discount_value);
  } catch (error) {
    if (error instanceof PromoPricingError) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_DISCOUNT_TERMS_INVALID", 422, error.code);
    throw error;
  }
  if (new Date(terms.publication_end_at).getTime() <= new Date(terms.publication_start_at).getTime()) {
    throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_PUBLICATION_WINDOW_INVALID", 422);
  }
};

const insertEngagementRevisionInTransaction = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagement: EngagementRow,
  terms: EngagementRevisionTerms,
  reason: string,
): EngagementRevisionRow => {
  validateRevisionTerms(terms);
  const current = currentEngagementRevision(db, engagement.id);
  const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
  const revisionId = id();
  const nextRevision = (current?.revision ?? 0) + 1;
  db.prepare(`INSERT INTO engagement_revisions(id, engagement_id, revision, occurrence_material_revision, reward_type, reward_value, customer_discount_type, customer_discount_value, publication_start_at, publication_end_at, terms_json, content_hash, supersedes_revision_id, created_by_admin_id, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(revisionId, engagement.id, nextRevision, occurrence.material_revision, terms.reward_type, terms.reward_value, terms.customer_discount_type, terms.customer_discount_value,
      terms.publication_start_at, terms.publication_end_at, JSON.stringify(terms.terms ?? {}), revisionContentHash(terms), current?.id ?? null, admin.admin_id, reason);
  return currentEngagementRevision(db, engagement.id)!;
};

export type OfferEngagementResult = { engagement_id: string; engagement_revision_id: string };

/** Admin-only: creates the engagement identity and its first revision atomically. Requires the partner to already be PARTNER_ACTIVE - engagements are not offered mid-onboarding. */
export const offerEngagement = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  occurrenceId: string,
  terms: EngagementRevisionTerms,
  reason: string,
): OfferEngagementResult => {
  const run = db.transaction((): OfferEngagementResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ENGAGEMENT_OFFER");

    const partner = getPartnerIdentity(db, partnerIdentityId);
    if (!partner) throw new EngagementError("PARTNER_IDENTITY_NOT_FOUND", 404, partnerIdentityId);
    if (partner.onboarding_state !== "PARTNER_ACTIVE") throw new EngagementError("AGENT_REFERRALS_PARTNER_NOT_ACTIVE", 409, partner.onboarding_state);

    const occurrence = occurrenceFacts(db, occurrenceId);
    if (!occurrence) throw new EngagementError("OCCURRENCE_NOT_FOUND", 404, occurrenceId);

    if (engagementByPartnerAndOccurrence(db, partnerIdentityId, occurrenceId)) {
      throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_ALREADY_EXISTS", 409, `${partnerIdentityId}:${occurrenceId}`);
    }

    const engagementId = id();
    db.prepare(`INSERT INTO engagements(id, partner_identity_id, occurrence_id, lifecycle_state, created_by_admin_id) VALUES (?, ?, ?, 'OFFERED', ?)`)
      .run(engagementId, partnerIdentityId, occurrenceId, admin.admin_id);
    const revision = insertEngagementRevisionInTransaction(db, admin, getEngagement(db, engagementId)!, terms, reason);
    recordPartnerIdentityEvent(db, partnerIdentityId, "ENGAGEMENT_OFFERED", "ADMIN", { engagement_id: engagementId, engagement_revision_id: revision.id, occurrence_id: occurrenceId, reason });
    return { engagement_id: engagementId, engagement_revision_id: revision.id };
  });
  return run.immediate();
};

/** Admin-only: mints a new material revision for an existing, not-yet-closed engagement. Does not itself change lifecycle_state or count as acceptance. */
export const mintEngagementRevision = (db: Database.Database, admin: AdminPrincipal, engagementId: string, terms: EngagementRevisionTerms, reason: string): EngagementRevisionRow => {
  const run = db.transaction((): EngagementRevisionRow => {
    const engagement = getEngagement(db, engagementId);
    if (!engagement) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    if (engagement.lifecycle_state === "CLOSED") throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_CLOSED", 409, engagementId);
    const revision = insertEngagementRevisionInTransaction(db, admin, engagement, terms, reason);
    recordPartnerIdentityEvent(db, engagement.partner_identity_id, "ENGAGEMENT_REVISION_MINTED", "ADMIN", { engagement_id: engagementId, engagement_revision_id: revision.id, reason });
    return revision;
  });
  return run.immediate();
};

export type AcceptEngagementResult = { acceptance_id: string; replayed: boolean };

/**
 * Partner-only authority. Exact-parameter replay (same engagement, same
 * revision, already accepted) is idempotent and consumes no new
 * suspension check or step-up grant - mirrors acceptFrameworkAndDelegation
 * exactly. The FIRST acceptance for an engagement transitions
 * OFFERED -> ACCEPTED; every later acceptance (of a newer revision, while
 * ACCEPTED/ACTIVE/SUSPENDED) records evidence only and leaves
 * lifecycle_state untouched - only activateEngagement moves the engagement
 * onto the newly accepted revision's authority.
 */
export const acceptEngagement = (db: Database.Database, partner: PartnerPrincipal, engagementId: string, engagementRevisionId: string, stepUpGrantId: string): AcceptEngagementResult => {
  const run = db.transaction((): AcceptEngagementResult => {
    const engagement = getEngagement(db, engagementId);
    if (!engagement || engagement.partner_identity_id !== partner.partner_identity_id) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    const revision = engagementRevisionById(db, engagementRevisionId);
    if (!revision || revision.engagement_id !== engagementId) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_NOT_FOUND", 404, engagementRevisionId);

    const existing = db.prepare("SELECT id FROM engagement_acceptances WHERE engagement_id = ? AND engagement_revision_id = ?").get(engagementId, engagementRevisionId) as { id: string } | undefined;
    if (existing) return { acceptance_id: existing.id, replayed: true };

    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ENGAGEMENT_ACCEPTANCE");
    if (engagement.lifecycle_state === "CLOSED") throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_CLOSED", 409, engagementId);

    consumeEngagementStepUpGrantInTransaction(db, partner, stepUpGrantId, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: engagementRevisionId });

    const acceptanceId = id();
    db.prepare(`INSERT INTO engagement_acceptances(id, engagement_id, engagement_revision_id, step_up_grant_id) VALUES (?, ?, ?, ?)`)
      .run(acceptanceId, engagementId, engagementRevisionId, stepUpGrantId);
    recordPartnerIdentityEvent(db, partner.partner_identity_id, "ENGAGEMENT_ACCEPTED", "PARTNER", { engagement_id: engagementId, engagement_revision_id: engagementRevisionId });

    if (engagement.lifecycle_state === "OFFERED") {
      const changed = db.prepare(`UPDATE engagements SET lifecycle_state = 'ACCEPTED', lifecycle_revision = lifecycle_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lifecycle_revision = ? AND lifecycle_state = 'OFFERED'`)
        .run(engagementId, engagement.lifecycle_revision);
      if (changed.changes !== 1) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_CONFLICT", 409, engagementId);
    }
    return { acceptance_id: acceptanceId, replayed: false };
  });
  return run.immediate();
};

export type ActivateEngagementResult = { activation_event_id: string; promo_authorization_id: string };

/**
 * The one privileged transaction validating and pinning every prerequisite
 * (plan section B, Phase 5 review note 2). Legal source state is
 * ACCEPTED, ACTIVE (re-activation onto a newer accepted revision) or
 * SUSPENDED (reactivation) - all three go through the identical CAS below,
 * because in every case the outcome is the same: validate prerequisites
 * fresh, pin a new activation snapshot, mint a new promo authorization.
 * "Reactivation never auto-reactivates a suspended engagement" (B-8) is
 * about the GLOBAL feature transition, not this explicit per-engagement
 * command - nothing calls this function except a deliberate admin action.
 */
export const activateEngagement = (db: Database.Database, admin: AdminPrincipal, engagementId: string, engagementRevisionId: string): ActivateEngagementResult => {
  const run = db.transaction((): ActivateEngagementResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ENGAGEMENT_ACTIVATION");

    const engagement = getEngagement(db, engagementId);
    if (!engagement) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    if (engagement.lifecycle_state !== "ACCEPTED" && engagement.lifecycle_state !== "ACTIVE" && engagement.lifecycle_state !== "SUSPENDED") {
      throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_ILLEGAL_TRANSITION", 409, `${engagement.lifecycle_state}->ACTIVE`);
    }

    const partner = getPartnerIdentity(db, engagement.partner_identity_id)!;
    if (partner.onboarding_state !== "PARTNER_ACTIVE") throw new EngagementError("AGENT_REFERRALS_PARTNER_NOT_ACTIVE", 409, partner.onboarding_state);
    if (!partner.legal_profile_revision_id) throw new EngagementError("AGENT_REFERRALS_ACTIVATION_LEGAL_PROFILE_MISSING", 409);

    const revision = engagementRevisionById(db, engagementRevisionId);
    if (!revision || revision.engagement_id !== engagementId) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_NOT_FOUND", 404, engagementRevisionId);
    const acceptance = db.prepare("SELECT id FROM engagement_acceptances WHERE engagement_id = ? AND engagement_revision_id = ?").get(engagementId, engagementRevisionId) as { id: string } | undefined;
    if (!acceptance) throw new EngagementError("AGENT_REFERRALS_ACTIVATION_REVISION_NOT_ACCEPTED", 409, engagementRevisionId);
    if (new Date(revision.publication_end_at).getTime() <= Date.now()) throw new EngagementError("AGENT_REFERRALS_ACTIVATION_PUBLICATION_WINDOW_ENDED", 409);

    // Forward-only authority: activating a revision OLDER than the one
    // currently governing this engagement would silently roll back
    // discount/reward terms to a superseded state (Phase 5 review note 7).
    const lastActivated = lastActivatedEngagementRevision(db, engagementId);
    if (lastActivated && revision.revision < lastActivated.revision) {
      throw new EngagementError("AGENT_REFERRALS_ACTIVATION_CANNOT_ROLL_BACK_REVISION", 409, `${revision.revision}<${lastActivated.revision}`);
    }

    const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
    if (occurrence.fulfillment_status !== "SCHEDULED") throw new EngagementError("AGENT_REFERRALS_ACTIVATION_OCCURRENCE_NOT_SCHEDULED", 409, occurrence.fulfillment_status);
    // The revision's pinned occurrence_material_revision must still match
    // the occurrence's CURRENT material_revision - occurrence date/time is
    // itself material (Phase 5 review note 6); a schedule change since this
    // revision was minted requires a fresh revision, not activating stale
    // terms against it.
    if (revision.occurrence_material_revision !== occurrence.material_revision) {
      throw new EngagementError("AGENT_REFERRALS_ACTIVATION_OCCURRENCE_MATERIAL_REVISION_STALE", 409, `${revision.occurrence_material_revision}!=${occurrence.material_revision}`);
    }

    const audience = currentAudienceVerification(db, engagement.partner_identity_id, occurrence.city_id);
    if (audience?.event_kind !== "VERIFIED") throw new EngagementError("AGENT_REFERRALS_ACTIVATION_AUDIENCE_NOT_VERIFIED", 409, occurrence.city_id);

    const frameworkAcceptance = db.prepare("SELECT id FROM framework_acceptances WHERE partner_identity_id = ?").get(engagement.partner_identity_id) as { id: string } | undefined;
    if (!frameworkAcceptance) throw new EngagementError("AGENT_REFERRALS_ACTIVATION_FRAMEWORK_NOT_ACCEPTED", 409);

    const delegation = db.prepare(`SELECT d.id FROM ord_reporting_delegations d
      LEFT JOIN ord_reporting_delegation_revocations r ON r.ord_reporting_delegation_id = d.id
      WHERE d.partner_identity_id = ? AND r.id IS NULL`).get(engagement.partner_identity_id) as { id: string } | undefined;
    if (!delegation) throw new EngagementError("AGENT_REFERRALS_ACTIVATION_DELEGATION_NOT_EFFECTIVE", 409);

    const partnerPromo = partnerPromoByPartnerId(db, partner.agent_id);
    if (!partnerPromo) throw new EngagementError("AGENT_REFERRALS_ACTIVATION_PARTNER_HAS_NO_PROMO", 409);

    const authorization = mintEngagementPromoAuthorizationInTransaction(db, {
      promo_code_id: partnerPromo.promo_code_id, partner_id: partner.agent_id, occurrence_id: occurrence.id, engagement_id: engagementId, engagement_revision_id: engagementRevisionId,
    });

    const activationEventId = id();
    db.prepare(`INSERT INTO engagement_activation_events(id, engagement_id, engagement_revision_id, audience_verification_event_id, legal_profile_revision_id, framework_acceptance_id, ord_reporting_delegation_id, promo_authorization_id, occurrence_id, activated_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(activationEventId, engagementId, engagementRevisionId, audience.id, partner.legal_profile_revision_id, frameworkAcceptance.id, delegation.id, authorization.id, occurrence.id, admin.admin_id);

    const changed = db.prepare(`UPDATE engagements SET lifecycle_state = 'ACTIVE', lifecycle_revision = lifecycle_revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND lifecycle_revision = ? AND lifecycle_state IN ('ACCEPTED', 'ACTIVE', 'SUSPENDED')`).run(engagementId, engagement.lifecycle_revision);
    if (changed.changes !== 1) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_CONFLICT", 409, engagementId);

    recordPartnerIdentityEvent(db, engagement.partner_identity_id, "ENGAGEMENT_ACTIVATED", "ADMIN", { engagement_id: engagementId, engagement_revision_id: engagementRevisionId, activation_event_id: activationEventId });
    return { activation_event_id: activationEventId, promo_authorization_id: authorization.id };
  });
  return run.immediate();
};

/** Alias, for callers making the "reactivate after suspension" intent explicit - identical mechanism to activateEngagement. */
export const reactivateEngagement = activateEngagement;

const transitionEngagementLifecycleInTransaction = (db: Database.Database, engagementId: string, to: "SUSPENDED" | "CLOSED", reason: string): EngagementRow => {
  const engagement = getEngagement(db, engagementId);
  if (!engagement) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
  const legalFrom: EngagementLifecycleState[] = to === "SUSPENDED" ? ["ACTIVE"] : ["ACTIVE", "SUSPENDED"];
  if (!legalFrom.includes(engagement.lifecycle_state)) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_ILLEGAL_TRANSITION", 409, `${engagement.lifecycle_state}->${to}`);

  const changed = db.prepare(`UPDATE engagements SET lifecycle_state = ?, lifecycle_revision = lifecycle_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND lifecycle_revision = ?`)
    .run(to, engagementId, engagement.lifecycle_revision);
  if (changed.changes !== 1) throw new EngagementError("AGENT_REFERRALS_ENGAGEMENT_REVISION_CONFLICT", 409, engagementId);
  revokeEngagementPromoAuthorizationInTransaction(db, engagementId, `ENGAGEMENT_${to}:${reason}`);
  recordPartnerIdentityEvent(db, engagement.partner_identity_id, `ENGAGEMENT_${to}`, "ADMIN", { engagement_id: engagementId, reason });
  return getEngagement(db, engagementId)!;
};

/** Admin-only manual pause. Revokes the current promo authorization for that occurrence in the same transaction - suspending Tomsk must never touch Novosibirsk. */
export const suspendEngagement = (db: Database.Database, admin: AdminPrincipal, engagementId: string, reason: string): EngagementRow => {
  void admin;
  return db.transaction(() => transitionEngagementLifecycleInTransaction(db, engagementId, "SUSPENDED", reason)).immediate();
};

/**
 * Compatibility seam for the legacy occurrence-patch path (domain.ts's
 * patchOccurrence) - called only when that command's own classification
 * already decided the change is material (the same signal that bumps
 * occurrences.material_revision). Suspends every currently-ACTIVE
 * engagement for this occurrence, across every partner, and revokes each
 * one's promo authorization - closing the gap where a schedule change
 * would otherwise leave a stale-terms engagement live (Phase 5 review
 * note 6). Forcing a fresh engagement_revisions row (whose
 * occurrence_material_revision will pin the new state) through
 * acceptance and activation again is the only way back to ACTIVE - never
 * automatic, never on the partner's behalf.
 */
export const suspendEngagementsForOccurrenceMaterialChange = (db: Database.Database, occurrenceId: string, reason: string): string[] => {
  const run = db.transaction((): string[] => {
    const affected = db.prepare("SELECT id FROM engagements WHERE occurrence_id = ? AND lifecycle_state = 'ACTIVE'").all(occurrenceId) as { id: string }[];
    for (const row of affected) transitionEngagementLifecycleInTransaction(db, row.id, "SUSPENDED", reason);
    return affected.map((row) => row.id);
  });
  return run.immediate();
};

export type RevokeAudienceCascadeResult = { verification_event_id: string; suspended_engagement_ids: string[] };

/**
 * Revoking the CURRENT audience verification for (partner, city), in one
 * authority transaction, suspends every currently-ACTIVE engagement for
 * that same (partner, city) pair and revokes its promo authorization -
 * "audience row changed, engagement later catches up" is exactly the gap
 * this closes. A REPLACEMENT verification (a fresh VERIFIED superseding a
 * prior VERIFIED - e.g. updated evidence) does not run this cascade: the
 * partner is still verified throughout, so no already-satisfied activation
 * prerequisite has become false.
 */
export const revokeAudienceVerificationForPartnerCity = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  cityId: string,
  reason: string,
  evidenceRef: string,
): RevokeAudienceCascadeResult => {
  const run = db.transaction((): RevokeAudienceCascadeResult => {
    const event = mintAudienceVerificationEventInTransaction(db, admin, partnerIdentityId, cityId, "REVOKED", reason, evidenceRef);
    const affected = db.prepare(`SELECT e.id FROM engagements e JOIN occurrences o ON o.id = e.occurrence_id
      WHERE e.partner_identity_id = ? AND o.city_id = ? AND e.lifecycle_state = 'ACTIVE'`).all(partnerIdentityId, cityId) as { id: string }[];
    for (const row of affected) transitionEngagementLifecycleInTransaction(db, row.id, "SUSPENDED", `AUDIENCE_VERIFICATION_REVOKED:${reason}`);
    return { verification_event_id: event.id, suspended_engagement_ids: affected.map((row) => row.id) };
  });
  return run.immediate();
};

/** Exported for delegation-revocation and closure modules - the identical CAS+revoke+audit primitive suspend/close both need. */
export const transitionEngagementLifecycle = transitionEngagementLifecycleInTransaction;
