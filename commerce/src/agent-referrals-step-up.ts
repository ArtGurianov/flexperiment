import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import type { PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * Step-up grants pin the exact action AND the exact resource/revision
 * context they authorize - never a generic `step_up = true`. A grant for
 * one material action can never authorize another, because consumption
 * checks the full tuple (partner identity, partner session, action,
 * resource hash) in one CAS UPDATE - there is no code path that checks a
 * subset of these and treats the rest as implied.
 *
 * No separate bearer secret: the grant id alone is not privileged (it is
 * not a capability crossing a trust boundary like the invite/OTP secrets
 * are) - authority comes from the caller ALSO presenting the exact
 * partner_session_id that requested the grant, which the partner's own
 * session cookie already authenticates on every request.
 */

export type StepUpAction = "FRAMEWORK_ACCEPTANCE" | "PAYOUT_PROFILE_SUPERSESSION";
const STEP_UP_TTL_MS = 5 * 60_000;

export class StepUpError extends Error {
  constructor(readonly code: string, readonly status = 403, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const resourceHashOf = (resource: Record<string, unknown>): string => sha256(canonicalV2(resource));

export const mintStepUpGrant = (db: Database.Database, partner: PartnerPrincipal, action: StepUpAction, resource: Record<string, unknown>): { grant_id: string } => {
  const run = db.transaction(() => {
    const grantId = id();
    db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(grantId, partner.partner_session_id, partner.partner_identity_id, action, JSON.stringify(resource), resourceHashOf(resource), new Date(Date.now() + STEP_UP_TTL_MS).toISOString());
    recordPartnerIdentityEvent(db, partner.partner_identity_id, "STEP_UP_GRANT_ISSUED", "PARTNER", { grant_id: grantId, action });
    return { grant_id: grantId };
  });
  return run.immediate();
};

/**
 * Nestable: consumes the grant inside the CALLER's own transaction, so
 * consumption and the protected mutation commit together or not at all. If
 * the mutation throws after this call, the enclosing transaction rolls back
 * this consume too, leaving the grant unconsumed and reusable for a
 * legitimate retry - never a spent grant with no effect to show for it.
 */
export const consumeStepUpGrantInTransaction = (
  db: Database.Database,
  partner: PartnerPrincipal,
  grantId: string,
  action: StepUpAction,
  resource: Record<string, unknown>,
): void => {
  // expires_at is an ISO 8601 string ("...T...Z"); comparing it against
  // CURRENT_TIMESTAMP's "... ..." shape as plain TEXT sorts 'T' after ' '
  // and would read an already-expired grant as still valid until the UTC
  // date rolls over. julianday() parses both onto the same numeric axis.
  const changed = db.prepare(`UPDATE step_up_grants SET consumed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND partner_identity_id = ? AND partner_session_id = ? AND action = ? AND resource_hash = ?
      AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')`)
    .run(grantId, partner.partner_identity_id, partner.partner_session_id, action, resourceHashOf(resource));
  if (changed.changes !== 1) throw new StepUpError("AGENT_REFERRALS_STEP_UP_GRANT_INVALID", 403, grantId);
};
