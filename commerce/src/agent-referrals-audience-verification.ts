import type Database from "better-sqlite3";
import { id } from "./crypto";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Append-only audience verification authority (plan section B-9's
 * prerequisite, spec'd in Phase 5): VERIFIED | REVOKED, monotonic
 * aggregate revision per (partner, city). There is no SUPERSEDED state - a
 * replacement VERIFIED is simply the next revision, and "current" is
 * always the row with MAX(aggregate_revision) for that pair, read from
 * event_kind directly rather than from a mutable pointer.
 *
 * This module is deliberately a leaf: it knows nothing about engagements.
 * The cascade requirement ("revoking the CURRENT verification behind an
 * already-pinned ACTIVE engagement must, in the same transaction, suspend
 * that engagement and revoke its promo authorization") lives in
 * agent-referrals-engagement.ts instead.
 *
 * This module exports NO function capable of writing a REVOKED event, at
 * any visibility level - not even a nestable "InTransaction" primitive.
 * The only way anything in this codebase can revoke is
 * agent-referrals-engagement.ts's revokeAudienceVerificationForPartnerCity,
 * which writes the REVOKED row itself (reading only the exported,
 * read-only currentAudienceVerification below) and cascades the
 * engagement suspension in the identical transaction. That is a
 * structural guarantee, not a naming convention: there is no shared
 * "mint any event kind" function anywhere for a future caller to misuse.
 */

export type AudienceVerificationEventKind = "VERIFIED" | "REVOKED";

export class AudienceVerificationError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type AudienceVerificationEventRow = {
  id: string;
  partner_identity_id: string;
  city_id: string;
  aggregate_revision: number;
  event_kind: AudienceVerificationEventKind;
  valid_until: string | null;
  supersedes_event_id: string | null;
  evidence_ref: string;
  reason: string;
  placed_by_admin_id: string;
  created_at: string;
};

const EVENT_COLUMNS = "id, partner_identity_id, city_id, aggregate_revision, event_kind, valid_until, supersedes_event_id, evidence_ref, reason, placed_by_admin_id, created_at";

/** Current authority is the row with MAX(aggregate_revision) for this pair - never MAX(created_at), and never a stored pointer. */
export const currentAudienceVerification = (db: Database.Database, partnerIdentityId: string, cityId: string): AudienceVerificationEventRow | null =>
  (db.prepare(`SELECT ${EVENT_COLUMNS} FROM partner_audience_verification_events WHERE partner_identity_id = ? AND city_id = ? ORDER BY aggregate_revision DESC LIMIT 1`)
    .get(partnerIdentityId, cityId) as AudienceVerificationEventRow | undefined) ?? null;

/** VERIFIED only, and only when validUntil actually covers untilAtLeast (e.g. the engagement revision's publication_end_at) - the read side of the "valid through publication end" invariant. */
export const isAudienceVerifiedThrough = (db: Database.Database, partnerIdentityId: string, cityId: string, untilAtLeast: string): boolean => {
  const current = currentAudienceVerification(db, partnerIdentityId, cityId);
  if (current?.event_kind !== "VERIFIED" || !current.valid_until) return false;
  const covers = db.prepare("SELECT (julianday(?) >= julianday(?)) AS covers").get(current.valid_until, untilAtLeast) as { covers: number };
  return Boolean(covers.covers);
};

export const isAudienceVerified = (db: Database.Database, partnerIdentityId: string, cityId: string): boolean =>
  currentAudienceVerification(db, partnerIdentityId, cityId)?.event_kind === "VERIFIED";

export const allAudienceVerificationEvents = (db: Database.Database, partnerIdentityId: string, cityId: string): AudienceVerificationEventRow[] =>
  db.prepare(`SELECT ${EVENT_COLUMNS} FROM partner_audience_verification_events WHERE partner_identity_id = ? AND city_id = ? ORDER BY aggregate_revision ASC`)
    .all(partnerIdentityId, cityId) as AudienceVerificationEventRow[];

/**
 * The nestable's caller's own IMMEDIATE transaction (activated by holding
 * the write lock before this reads anything) is what makes "exactly one
 * writer wins" a real property of the (partner, city) revision race - a
 * second writer's IMMEDIATE transaction blocks until the first commits,
 * then re-reads the now-current revision and mints the next one, never
 * colliding. UNIQUE(partner_identity_id, city_id, aggregate_revision) is
 * the structural backstop if that ordering is ever violated.
 *
 * VERIFIED may be minted from ANY current state (fresh verification,
 * re-verification after updated evidence, or re-verification after a
 * prior revocation) - it is always "assert verified now, valid through
 * validUntil".
 */
const mintVerifiedInTransaction = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  cityId: string,
  validUntil: string,
  reason: string,
  evidenceRef: string,
): AudienceVerificationEventRow => {
  const current = currentAudienceVerification(db, partnerIdentityId, cityId);
  const eventId = id();
  const nextRevision = (current?.aggregate_revision ?? 0) + 1;
  db.prepare(`INSERT INTO partner_audience_verification_events(id, partner_identity_id, city_id, aggregate_revision, event_kind, valid_until, supersedes_event_id, evidence_ref, reason, placed_by_admin_id)
    VALUES (?, ?, ?, ?, 'VERIFIED', ?, ?, ?, ?, ?)`)
    .run(eventId, partnerIdentityId, cityId, nextRevision, validUntil, current?.id ?? null, evidenceRef, reason, admin.admin_id);
  return currentAudienceVerification(db, partnerIdentityId, cityId)!;
};

/**
 * The ONLY top-level (own-transaction) production entry point this module
 * exposes - and it can only ever assert VERIFIED (there is no eventKind
 * parameter at all, structurally). See the file header for why REVOKED
 * has no equivalent here.
 */
export const verifyAudience = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  cityId: string,
  validUntil: string,
  reason: string,
  evidenceRef: string,
): AudienceVerificationEventRow =>
  db.transaction(() => mintVerifiedInTransaction(db, admin, partnerIdentityId, cityId, validUntil, reason, evidenceRef)).immediate();
