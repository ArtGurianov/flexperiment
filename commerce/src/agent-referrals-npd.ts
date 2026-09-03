import type Database from "better-sqlite3";
import { id } from "./crypto";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-6/Phase 7 NPD payout authority - never `agents.npd_status_checked_at`
 * (a bare nullable timestamp with no status and no freshness), which stays
 * exactly as it is for the LEGACY flow.
 *
 * No FNS adapter ships in this PR (plan: "если FNS adapter/network itself
 * не относится к PR7 frozen implementation, реализуй explicit
 * injected/manual evidence boundary"). recordNpdStatusCheck is that
 * boundary: every row is an explicit, admin-attributed fact carrying its
 * own evidence_ref, never something this module infers or fabricates.
 * Fail-closed by construction: there is no code path in this module that
 * ever returns ACTIVE for a missing, stale, or errored check - the caller
 * (payment authorization) always starts from "no usable check" and must be
 * handed a genuinely fresh ACTIVE one.
 */

export type NpdCheckStatus = "ACTIVE" | "INACTIVE" | "UNKNOWN";

export class NpdStatusError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * How long an ACTIVE check remains usable as payout authority. A policy
 * constant, not a law-derived figure (L9/L10 do not fix one) - deliberately
 * conservative (well under a business day) because a stale ACTIVE reading is
 * indistinguishable from a genuinely current INACTIVE one until re-checked,
 * and BEGIN_PAYMENT must never trust an old answer.
 */
export const NPD_STATUS_CHECK_FRESHNESS_MS = 4 * 60 * 60 * 1_000;

export type NpdStatusCheckRow = {
  id: string;
  partner_identity_id: string;
  status: NpdCheckStatus;
  checked_at: string;
  evidence_ref: string;
  created_by_admin_id: string;
  created_at: string;
};

const CHECK_COLUMNS = "id, partner_identity_id, status, checked_at, evidence_ref, created_by_admin_id, created_at";

export const recordNpdStatusCheck = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  status: NpdCheckStatus,
  evidenceRef: string,
  checkedAtIso = new Date().toISOString(),
): NpdStatusCheckRow => {
  const run = db.transaction((): NpdStatusCheckRow => {
    const checkId = id();
    db.prepare(`INSERT INTO npd_status_checks(id, partner_identity_id, status, checked_at, evidence_ref, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(checkId, partnerIdentityId, status, checkedAtIso, evidenceRef, admin.admin_id);
    return db.prepare(`SELECT ${CHECK_COLUMNS} FROM npd_status_checks WHERE id = ?`).get(checkId) as NpdStatusCheckRow;
  });
  return run.immediate();
};

/** The most recently checked_at fact on file - not necessarily fresh or ACTIVE; freshness is judged separately below. */
export const latestNpdStatusCheck = (db: Database.Database, partnerIdentityId: string): NpdStatusCheckRow | null =>
  (db.prepare(`SELECT ${CHECK_COLUMNS} FROM npd_status_checks WHERE partner_identity_id = ? ORDER BY julianday(checked_at) DESC, id DESC LIMIT 1`)
    .get(partnerIdentityId) as NpdStatusCheckRow | undefined) ?? null;

/**
 * Normalized time arithmetic (julianday), never raw TEXT comparison - the
 * same rationale as every other freshness window in this codebase.
 */
export const isNpdCheckFresh = (db: Database.Database, check: NpdStatusCheckRow, atIso = new Date().toISOString()): boolean => {
  const row = db.prepare("SELECT (julianday(?) - julianday(?)) * 86400000 AS age_ms").get(atIso, check.checked_at) as { age_ms: number };
  return row.age_ms >= 0 && row.age_ms <= NPD_STATUS_CHECK_FRESHNESS_MS;
};

/**
 * The one usable check for minting a NEW payment authorization right now:
 * ACTIVE and fresh, or null. UNKNOWN, INACTIVE, missing, or stale all
 * resolve to null uniformly - the caller (agent-referrals-payment.ts) has
 * exactly one branch to take on a null result: refuse. There is
 * deliberately no separate "why" returned here beyond that - the reason
 * belongs to the check row itself (latestNpdStatusCheck), not to this
 * gate's own return type.
 */
export const currentUsableNpdCheck = (db: Database.Database, partnerIdentityId: string, atIso = new Date().toISOString()): NpdStatusCheckRow | null => {
  const latest = latestNpdStatusCheck(db, partnerIdentityId);
  if (!latest || latest.status !== "ACTIVE") return null;
  return isNpdCheckFresh(db, latest, atIso) ? latest : null;
};
