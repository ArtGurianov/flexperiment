import type Database from "better-sqlite3";
import { id } from "./crypto";
import { promoCodeSchema } from "./types";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * One permanent promo per partner (plan section B-9), and per-occurrence
 * authority to use it. This module is a leaf: mintEngagementPromoAuthorization
 * takes every identifier it needs as explicit parameters, so it never
 * imports agent-referrals-engagement.ts - that module imports this one
 * instead (engagement activation is what mints/supersedes an authorization).
 */

export class AgentReferralsPromoError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type PartnerPromoRow = { id: string; promo_code_id: string; partner_id: string; created_at: string };

export const partnerPromoByPartnerId = (db: Database.Database, partnerId: string): PartnerPromoRow | null =>
  (db.prepare("SELECT id, promo_code_id, partner_id, created_at FROM partner_promos WHERE partner_id = ?").get(partnerId) as PartnerPromoRow | undefined) ?? null;

export const partnerPromoByPromoCodeId = (db: Database.Database, promoCodeId: string): PartnerPromoRow | null =>
  (db.prepare("SELECT id, promo_code_id, partner_id, created_at FROM partner_promos WHERE promo_code_id = ?").get(promoCodeId) as PartnerPromoRow | undefined) ?? null;

export const isPromoPartnerOwned = (db: Database.Database, promoCodeId: string): boolean => partnerPromoByPromoCodeId(db, promoCodeId) !== null;

export type CreatePartnerPromoInput = { partner_id: string; code: string; reason: string };

/**
 * Admin-only, one-time mint: creates the underlying promo_codes row with
 * frozen NONE/0 placeholders (never commercial authority - the customer
 * discount lives in the engagement revision, per B-9) and the
 * partner_promos binding, atomically. Both promo_code_id and partner_id
 * are UNIQUE on partner_promos, so a second attempt for the same partner
 * (or a promo code already bound to a different partner) fails the
 * transaction outright rather than silently minting a second code.
 */
export const createPartnerPromo = (db: Database.Database, admin: AdminPrincipal, input: CreatePartnerPromoInput): PartnerPromoRow => {
  // Reuses the EXACT same grammar the legacy admin promo-creation surface
  // enforces (types.ts's promoCodeSchema - trimmed, uppercased,
  // ^[A-Z0-9_-]{2,64}$) rather than a second, slightly different
  // validation of its own. Throws a ZodError on an invalid code, exactly
  // as promoSchema.parse() does upstream of the legacy admin route.
  const normalized = promoCodeSchema.parse(input.code);
  const run = db.transaction((): PartnerPromoRow => {
    const promoCodeId = id();
    db.prepare(`INSERT INTO promo_codes(id, agent_id, code, normalized_code, status, discount_type, discount_value)
      VALUES (?, ?, ?, ?, 'ACTIVE', 'NONE', 0)`)
      .run(promoCodeId, input.partner_id, normalized, normalized);
    const partnerPromoId = id();
    db.prepare(`INSERT INTO partner_promos(id, promo_code_id, partner_id, created_by_admin_id) VALUES (?, ?, ?, ?)`)
      .run(partnerPromoId, promoCodeId, input.partner_id, admin.admin_id);
    return partnerPromoByPartnerId(db, input.partner_id)!;
  });
  return run.immediate();
};

export type EngagementPromoAuthorizationRow = {
  id: string;
  promo_code_id: string;
  partner_id: string;
  occurrence_id: string;
  engagement_id: string;
  engagement_revision_id: string;
  supersedes_authorization_id: string | null;
  effective_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  created_at: string;
};

const AUTHORIZATION_COLUMNS = "id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, supersedes_authorization_id, effective_at, revoked_at, revoked_reason, created_at";

/** The current (unrevoked) authorization for this exact (promo, occurrence) pair - structurally at most one, per the partial unique index. */
export const currentEngagementPromoAuthorization = (db: Database.Database, promoCodeId: string, occurrenceId: string): EngagementPromoAuthorizationRow | null =>
  (db.prepare(`SELECT ${AUTHORIZATION_COLUMNS} FROM engagement_promo_authorizations WHERE promo_code_id = ? AND occurrence_id = ? AND revoked_at IS NULL`)
    .get(promoCodeId, occurrenceId) as EngagementPromoAuthorizationRow | undefined) ?? null;

export const currentEngagementPromoAuthorizationForEngagement = (db: Database.Database, engagementId: string): EngagementPromoAuthorizationRow | null =>
  (db.prepare(`SELECT ${AUTHORIZATION_COLUMNS} FROM engagement_promo_authorizations WHERE engagement_id = ? AND revoked_at IS NULL`)
    .get(engagementId) as EngagementPromoAuthorizationRow | undefined) ?? null;

/**
 * Nestable: mints the next authorization for (promo, occurrence),
 * superseding whatever is currently live for that pair (if any) via the
 * revoke-then-insert ordering below. Called only from
 * agent-referrals-engagement.ts's activation path - never directly, since
 * activation is what validates every prerequisite this authorization
 * asserts implicitly by existing.
 */
export const mintEngagementPromoAuthorizationInTransaction = (
  db: Database.Database,
  input: { promo_code_id: string; partner_id: string; occurrence_id: string; engagement_id: string; engagement_revision_id: string },
): EngagementPromoAuthorizationRow => {
  const current = currentEngagementPromoAuthorization(db, input.promo_code_id, input.occurrence_id);
  if (current) {
    const changed = db.prepare(`UPDATE engagement_promo_authorizations SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = 'SUPERSEDED_BY_NEW_ACTIVATION' WHERE id = ? AND revoked_at IS NULL`).run(current.id);
    if (changed.changes !== 1) throw new AgentReferralsPromoError("AGENT_REFERRALS_PROMO_AUTHORIZATION_CONCURRENTLY_SUPERSEDED", 409, current.id);
  }
  const authorizationId = id();
  db.prepare(`INSERT INTO engagement_promo_authorizations(id, promo_code_id, partner_id, occurrence_id, engagement_id, engagement_revision_id, supersedes_authorization_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(authorizationId, input.promo_code_id, input.partner_id, input.occurrence_id, input.engagement_id, input.engagement_revision_id, current?.id ?? null);
  return currentEngagementPromoAuthorization(db, input.promo_code_id, input.occurrence_id)!;
};

/** Nestable: revokes the current authorization for an engagement, if one exists. A no-op (returns null) if none is currently live - suspending/closing an engagement that never activated must not throw. */
export const revokeEngagementPromoAuthorizationInTransaction = (db: Database.Database, engagementId: string, reason: string): EngagementPromoAuthorizationRow | null => {
  const current = currentEngagementPromoAuthorizationForEngagement(db, engagementId);
  if (!current) return null;
  const changed = db.prepare(`UPDATE engagement_promo_authorizations SET revoked_at = CURRENT_TIMESTAMP, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`).run(reason, current.id);
  if (changed.changes !== 1) throw new AgentReferralsPromoError("AGENT_REFERRALS_PROMO_AUTHORIZATION_CONCURRENTLY_REVOKED", 409, current.id);
  return { ...current, revoked_at: new Date().toISOString(), revoked_reason: reason };
};
