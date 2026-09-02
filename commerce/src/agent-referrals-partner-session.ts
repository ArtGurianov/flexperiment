import type Database from "better-sqlite3";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import { hashOpaqueToken } from "./agent-referrals-partner-auth";
import type { PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * Session lookup, always by hash - the raw token from the cookie never
 * touches a comparison against a stored raw value, and revocation deletes
 * server-side authority (revoked_at set) rather than depending on the
 * browser to discard the cookie.
 */
export const resolvePartnerSession = (db: Database.Database, rawToken: string): PartnerPrincipal | undefined => {
  const row = db.prepare(`SELECT id, partner_identity_id FROM partner_sessions
    WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP`).get(hashOpaqueToken(rawToken)) as
    { id: string; partner_identity_id: string } | undefined;
  return row ? { realm: "PARTNER", partner_identity_id: row.partner_identity_id, partner_session_id: row.id } : undefined;
};

export const revokePartnerSession = (db: Database.Database, partner: PartnerPrincipal): void => {
  const run = db.transaction(() => {
    db.prepare(`UPDATE partner_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL`).run(partner.partner_session_id);
    recordPartnerIdentityEvent(db, partner.partner_identity_id, "PARTNER_SESSION_REVOKED", "PARTNER", { partner_session_id: partner.partner_session_id });
  });
  run.immediate();
};
