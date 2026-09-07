import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import type { PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * Phase 7's own step-up-grant table (settlement_step_up_grants), parallel to
 * 0044's step_up_grants and 0045's engagement_step_up_grants - see 0045's
 * migration header for why an existing action-CHECK table cannot simply
 * admit a new value without an FK-off rebuild. Same contract: the grant
 * pins the exact action AND the exact resource (here, the exact act id plus
 * its amount/revision) it authorizes, consumed atomically with the
 * protected mutation via CAS.
 *
 * ACT_ACCEPTANCE is the only legal action, and this module's consume
 * function only ever accepts a PartnerPrincipal - the same structural
 * argument already relied on for acceptEngagement/framework acceptance
 * closes "admin cannot ACT_ACCEPTED" without any admin/partner
 * discriminator column anywhere in this table.
 */

export type SettlementStepUpAction = "ACT_ACCEPTANCE";
const STEP_UP_TTL_MS = 5 * 60_000;

export class SettlementStepUpError extends Error {
  constructor(readonly code: string, readonly status = 403, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const resourceHashOf = (resource: Record<string, unknown>): string => sha256(canonicalV2(resource));

export const mintSettlementStepUpGrant = (
  db: Database.Database,
  partner: PartnerPrincipal,
  action: SettlementStepUpAction,
  resource: Record<string, unknown>,
): { grant_id: string } => {
  const run = db.transaction(() => {
    const grantId = id();
    db.prepare(`INSERT INTO settlement_step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(grantId, partner.partner_session_id, partner.partner_identity_id, action, JSON.stringify(resource), resourceHashOf(resource), new Date(Date.now() + STEP_UP_TTL_MS).toISOString());
    recordPartnerIdentityEvent(db, partner.partner_identity_id, "SETTLEMENT_STEP_UP_GRANT_ISSUED", "PARTNER", { grant_id: grantId, action });
    return { grant_id: grantId };
  });
  return run.immediate();
};

/** Nestable - see agent-referrals-step-up.ts's consumeStepUpGrantInTransaction for the identical rationale. */
export const consumeSettlementStepUpGrantInTransaction = (
  db: Database.Database,
  partner: PartnerPrincipal,
  grantId: string,
  action: SettlementStepUpAction,
  resource: Record<string, unknown>,
): void => {
  const changed = db.prepare(`UPDATE settlement_step_up_grants SET consumed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND partner_identity_id = ? AND partner_session_id = ? AND action = ? AND resource_hash = ?
      AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')`)
    .run(grantId, partner.partner_identity_id, partner.partner_session_id, action, resourceHashOf(resource));
  if (changed.changes !== 1) throw new SettlementStepUpError("AGENT_REFERRALS_SETTLEMENT_STEP_UP_GRANT_INVALID", 403, grantId);
};
