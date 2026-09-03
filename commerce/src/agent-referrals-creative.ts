import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { currentEngagementPromoAuthorizationForEngagement, partnerPromoByPartnerId } from "./agent-referrals-promo";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Immutable creative CONTENT (plan section B-5) and its separate
 * authorization to an exact engagement revision + promo authorization.
 * creative_hash covers every MATERIAL field only - never engagement
 * discount values, reward formula or occurrence facts, which is exactly
 * what keeps a reward-formula-only engagement revision from forcing a new
 * hash, a new ORD registration or a new ERID (L6).
 */

export class CreativeError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type CreativeFormatKind = "post" | "story" | "short_video" | "long_video" | "stream" | "audio" | "text" | "graphic" | "text_graphic" | "native_authored";

export type CreativeMaterialFields = {
  format_kind: CreativeFormatKind;
  media_ref: string | null;
  copy_text: string | null;
  cta_text: string | null;
  mandatory_labeling_text: string;
  creative_target_url: string;
};

export const creativeHashOf = (promoCodeId: string, fields: CreativeMaterialFields): string =>
  sha256(canonicalV2({ promo_code_id: promoCodeId, ...fields } as unknown as Record<string, unknown>));

export type CreativeRevisionRow = CreativeMaterialFields & {
  id: string;
  engagement_id: string;
  revision: number;
  partner_id: string;
  promo_code_id: string;
  creative_hash: string;
  supersedes_creative_revision_id: string | null;
  created_by_admin_id: string;
  created_at: string;
};

const REVISION_COLUMNS = "id, engagement_id, revision, partner_id, promo_code_id, format_kind, media_ref, copy_text, cta_text, mandatory_labeling_text, creative_target_url, creative_hash, supersedes_creative_revision_id, created_by_admin_id, created_at";

/** "Current" resolves by `revision` (monotonic), never by created_at - see the migration's comment on why. */
export const currentCreativeRevision = (db: Database.Database, engagementId: string): CreativeRevisionRow | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS} FROM engagement_creative_revisions WHERE engagement_id = ? ORDER BY revision DESC LIMIT 1`)
    .get(engagementId) as CreativeRevisionRow | undefined) ?? null;

export const creativeRevisionById = (db: Database.Database, revisionId: string): CreativeRevisionRow | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS} FROM engagement_creative_revisions WHERE id = ?`).get(revisionId) as CreativeRevisionRow | undefined) ?? null;

/**
 * Admin-only content authoring - not gated by SUSPENDED (preparing content
 * is not itself new publication authority; authorizeCreative below is).
 *
 * partner_id and promo_code_id are DERIVED from the engagement's own
 * authority, never accepted as independent caller arguments - the earlier
 * shape (both as free parameters) let a caller mint immutable creative
 * evidence for engagement A binding promo B's code, an evidence-integrity
 * defect no later check could safely paper over (Phase 5 review note 5).
 */
export const mintCreativeRevision = (db: Database.Database, admin: AdminPrincipal, engagementId: string, fields: CreativeMaterialFields): CreativeRevisionRow => {
  const run = db.transaction((): CreativeRevisionRow => {
    const owner = db.prepare(`SELECT pi.agent_id AS agent_id FROM engagements e JOIN partner_identities pi ON pi.id = e.partner_identity_id WHERE e.id = ?`)
      .get(engagementId) as { agent_id: string } | undefined;
    if (!owner) throw new CreativeError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
    const partnerPromo = partnerPromoByPartnerId(db, owner.agent_id);
    if (!partnerPromo) throw new CreativeError("AGENT_REFERRALS_CREATIVE_PARTNER_HAS_NO_PROMO", 409, engagementId);

    const current = currentCreativeRevision(db, engagementId);
    const revisionId = id();
    const nextRevision = (current?.revision ?? 0) + 1;
    db.prepare(`INSERT INTO engagement_creative_revisions(id, engagement_id, revision, partner_id, promo_code_id, format_kind, media_ref, copy_text, cta_text, mandatory_labeling_text, creative_target_url, creative_hash, supersedes_creative_revision_id, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, engagementId, nextRevision, owner.agent_id, partnerPromo.promo_code_id, fields.format_kind, fields.media_ref, fields.copy_text, fields.cta_text, fields.mandatory_labeling_text, fields.creative_target_url,
        creativeHashOf(partnerPromo.promo_code_id, fields), current?.id ?? null, admin.admin_id);
    return currentCreativeRevision(db, engagementId)!;
  });
  return run.immediate();
};

export type CreativeAuthorizationRow = {
  id: string;
  engagement_id: string;
  engagement_revision_id: string;
  promo_authorization_id: string;
  creative_revision_id: string;
  supersedes_authorization_id: string | null;
  effective_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
};

const AUTHORIZATION_COLUMNS = "id, engagement_id, engagement_revision_id, promo_authorization_id, creative_revision_id, supersedes_authorization_id, effective_at, revoked_at, revoked_reason, created_at";

/** "Canonical" per B-5e: at most one current (unrevoked) authorization per engagement, enforced structurally by the partial unique index. */
export const currentCreativeAuthorization = (db: Database.Database, engagementId: string): CreativeAuthorizationRow | null =>
  (db.prepare(`SELECT ${AUTHORIZATION_COLUMNS} FROM engagement_creative_authorizations WHERE engagement_id = ? AND revoked_at IS NULL`)
    .get(engagementId) as CreativeAuthorizationRow | undefined) ?? null;

/**
 * Admin-only, gated as NEW_PUBLICATION_AUTHORITY. Always binds to the
 * engagement's CURRENT (live) promo authorization - which pins its own
 * engagement_revision_id - so an engagement that never activated, or is
 * currently SUSPENDED/CLOSED, has no live authorization to bind to and
 * this refuses outright. A superseded creative revision may not back new
 * authorized publication: creativeRevisionId must be the engagement's
 * CURRENT creative revision.
 */
export const authorizeCreative = (db: Database.Database, admin: AdminPrincipal, engagementId: string, creativeRevisionId: string): CreativeAuthorizationRow => {
  void admin;
  const run = db.transaction((): CreativeAuthorizationRow => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "NEW_PUBLICATION_AUTHORITY");

    const promoAuthorization = currentEngagementPromoAuthorizationForEngagement(db, engagementId);
    if (!promoAuthorization) throw new CreativeError("AGENT_REFERRALS_CREATIVE_AUTHORIZATION_REQUIRES_ACTIVE_ENGAGEMENT", 409, engagementId);

    const creative = creativeRevisionById(db, creativeRevisionId);
    if (!creative || creative.engagement_id !== engagementId) throw new CreativeError("AGENT_REFERRALS_CREATIVE_REVISION_NOT_FOUND", 404, creativeRevisionId);
    const current = currentCreativeRevision(db, engagementId)!;
    if (current.id !== creativeRevisionId) throw new CreativeError("AGENT_REFERRALS_CREATIVE_REVISION_SUPERSEDED", 409, creativeRevisionId);
    // Defense in depth: mintCreativeRevision derives partner_id/promo_code_id
    // from the engagement, so this can never actually fire through the
    // public API - guards against a future caller bypassing that
    // derivation (e.g. direct DB manipulation in a bug elsewhere).
    if (creative.partner_id !== promoAuthorization.partner_id) throw new CreativeError("AGENT_REFERRALS_CREATIVE_PARTNER_MISMATCH", 409, creativeRevisionId);
    if (creative.promo_code_id !== promoAuthorization.promo_code_id) throw new CreativeError("AGENT_REFERRALS_CREATIVE_PROMO_MISMATCH", 409, creativeRevisionId);

    const existingCurrent = currentCreativeAuthorization(db, engagementId);
    if (existingCurrent) {
      const changed = db.prepare(`UPDATE engagement_creative_authorizations SET revoked_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), revoked_reason = 'SUPERSEDED_BY_NEW_AUTHORIZATION' WHERE id = ? AND revoked_at IS NULL`).run(existingCurrent.id);
      if (changed.changes !== 1) throw new CreativeError("AGENT_REFERRALS_CREATIVE_AUTHORIZATION_CONCURRENTLY_SUPERSEDED", 409, existingCurrent.id);
    }

    const authorizationId = id();
    db.prepare(`INSERT INTO engagement_creative_authorizations(id, engagement_id, engagement_revision_id, promo_authorization_id, creative_revision_id, supersedes_authorization_id)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(authorizationId, engagementId, promoAuthorization.engagement_revision_id, promoAuthorization.id, creativeRevisionId, existingCurrent?.id ?? null);
    return currentCreativeAuthorization(db, engagementId)!;
  });
  return run.immediate();
};

export const revokeCreativeAuthorization = (db: Database.Database, admin: AdminPrincipal, authorizationId: string, reason: string): void => {
  void admin;
  const run = db.transaction(() => {
    const changed = db.prepare(`UPDATE engagement_creative_authorizations SET revoked_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`).run(reason, authorizationId);
    if (changed.changes !== 1) throw new CreativeError("AGENT_REFERRALS_CREATIVE_AUTHORIZATION_ALREADY_REVOKED", 409, authorizationId);
  });
  run.immediate();
};
