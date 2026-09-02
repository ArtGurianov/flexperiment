import type Database from "better-sqlite3";
import { id } from "./crypto";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Phase 4 identity retention: a versioned policy, mutable legal-hold control
 * rows (released_at set to lift one, never deleted), and immutable
 * destruction evidence. Destruction never hard-deletes partner_identities -
 * that would break every FK evidence chain (framework_acceptances,
 * payout_profile_revisions, ...) this PR builds. It scrubs only the PII
 * columns (email/email_hash) under this module's authority alone, and the
 * ONLY way to do that is through destroyPartnerIdentity() below - there is
 * no other write path to those two columns anywhere in this codebase.
 */

export class RetentionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * Deliberately no `retention_period_days` (or any numeric field): the plan
 * names no authoritative anchor a duration would run from, and PR4
 * computes no eligibility from elapsed time. This is versioned evidence
 * that a real, externally-approved policy revision exists - `reason`
 * carries what that policy actually says (e.g. a citation) - not a
 * scheduler input this code half-enforces. See the migration's comment on
 * this table.
 */
export type RetentionPolicyRow = { id: string; revision: number; reason: string; supersedes_revision_id: string | null; created_at: string };

export const currentRetentionPolicy = (db: Database.Database): RetentionPolicyRow | null =>
  (db.prepare("SELECT id, revision, reason, supersedes_revision_id, created_at FROM partner_identity_retention_policies ORDER BY revision DESC LIMIT 1").get() as RetentionPolicyRow | undefined) ?? null;

export const mintRetentionPolicyRevision = (db: Database.Database, admin: AdminPrincipal, reason: string): RetentionPolicyRow => {
  const run = db.transaction((): RetentionPolicyRow => {
    const current = currentRetentionPolicy(db);
    const policyId = id();
    const nextRevision = (current?.revision ?? 0) + 1;
    db.prepare(`INSERT INTO partner_identity_retention_policies(id, revision, reason, supersedes_revision_id)
      VALUES (?, ?, ?, ?)`)
      .run(policyId, nextRevision, reason, current?.id ?? null);
    return currentRetentionPolicy(db)!;
  });
  return run.immediate();
};

export const isUnderLegalHold = (db: Database.Database, partnerIdentityId: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM partner_identity_legal_holds WHERE partner_identity_id = ? AND released_at IS NULL").get(partnerIdentityId));

export const placeLegalHold = (db: Database.Database, admin: AdminPrincipal, partnerIdentityId: string, reason: string): { hold_id: string } => {
  const run = db.transaction(() => {
    const holdId = id();
    db.prepare(`INSERT INTO partner_identity_legal_holds(id, partner_identity_id, reason, placed_by_admin_id) VALUES (?, ?, ?, ?)`)
      .run(holdId, partnerIdentityId, reason, admin.admin_id);
    recordPartnerIdentityEvent(db, partnerIdentityId, "LEGAL_HOLD_PLACED", "ADMIN", { hold_id: holdId, reason });
    return { hold_id: holdId };
  });
  return run.immediate();
};

export const releaseLegalHold = (db: Database.Database, admin: AdminPrincipal, holdId: string, reason: string): void => {
  const run = db.transaction(() => {
    const row = db.prepare("SELECT partner_identity_id FROM partner_identity_legal_holds WHERE id = ?").get(holdId) as { partner_identity_id: string } | undefined;
    if (!row) throw new RetentionError("AGENT_REFERRALS_LEGAL_HOLD_NOT_FOUND", 404, holdId);
    const changed = db.prepare(`UPDATE partner_identity_legal_holds SET released_at = CURRENT_TIMESTAMP, released_by_admin_id = ?, released_reason = ?
      WHERE id = ? AND released_at IS NULL`).run(admin.admin_id, reason, holdId);
    if (changed.changes !== 1) throw new RetentionError("AGENT_REFERRALS_LEGAL_HOLD_ALREADY_RELEASED", 409, holdId);
    recordPartnerIdentityEvent(db, row.partner_identity_id, "LEGAL_HOLD_RELEASED", "ADMIN", { hold_id: holdId, reason });
  });
  run.immediate();
};

const DESTROYED_EMAIL_SENTINEL = "destroyed@agent-referrals.invalid";
const DESTROYED_EMAIL_HASH_SENTINEL = "0".repeat(64);

export type DestructionResult = { destruction_event_id: string; replayed: boolean };

/**
 * Idempotent: a second call for an already-destroyed identity returns the
 * existing evidence row rather than re-scrubbing (a no-op regardless, since
 * the columns are already tombstoned) or erroring. A legal hold refuses the
 * operation entirely, before any write.
 */
export const destroyPartnerIdentity = (db: Database.Database, admin: AdminPrincipal, partnerIdentityId: string, reason: string): DestructionResult => {
  const run = db.transaction((): DestructionResult => {
    const existing = db.prepare("SELECT id FROM partner_identity_destruction_events WHERE partner_identity_id = ?").get(partnerIdentityId) as { id: string } | undefined;
    if (existing) return { destruction_event_id: existing.id, replayed: true };

    if (isUnderLegalHold(db, partnerIdentityId)) throw new RetentionError("AGENT_REFERRALS_IDENTITY_UNDER_LEGAL_HOLD", 409, partnerIdentityId);

    const policy = currentRetentionPolicy(db);
    if (!policy) throw new RetentionError("AGENT_REFERRALS_NO_RETENTION_POLICY", 409);

    const identity = db.prepare("SELECT id FROM partner_identities WHERE id = ?").get(partnerIdentityId) as { id: string } | undefined;
    if (!identity) throw new RetentionError("PARTNER_IDENTITY_NOT_FOUND", 404, partnerIdentityId);

    const destroyedFields = ["email", "email_hash"];
    db.prepare(`UPDATE partner_identities SET email = ?, email_hash = ?, destroyed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(DESTROYED_EMAIL_SENTINEL, DESTROYED_EMAIL_HASH_SENTINEL, partnerIdentityId);

    const eventId = id();
    db.prepare(`INSERT INTO partner_identity_destruction_events(id, partner_identity_id, destroyed_fields_json, retention_policy_revision_id, requested_by_admin_id)
      VALUES (?, ?, ?, ?, ?)`)
      .run(eventId, partnerIdentityId, JSON.stringify(destroyedFields), policy.id, admin.admin_id);

    recordPartnerIdentityEvent(db, partnerIdentityId, "IDENTITY_DESTROYED", "ADMIN", { destruction_event_id: eventId, reason });
    return { destruction_event_id: eventId, replayed: false };
  });
  return run.immediate();
};
