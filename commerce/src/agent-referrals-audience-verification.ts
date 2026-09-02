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
 * agent-referrals-engagement.ts instead, which imports the mint function
 * below - the reverse import would create a cycle (activateEngagement
 * needs to read current audience verification too).
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
  supersedes_event_id: string | null;
  evidence_ref: string;
  reason: string;
  placed_by_admin_id: string;
  created_at: string;
};

/** Current authority is the row with MAX(aggregate_revision) for this pair - never MAX(created_at), and never a stored pointer. */
export const currentAudienceVerification = (db: Database.Database, partnerIdentityId: string, cityId: string): AudienceVerificationEventRow | null =>
  (db.prepare(`SELECT id, partner_identity_id, city_id, aggregate_revision, event_kind, supersedes_event_id, evidence_ref, reason, placed_by_admin_id, created_at
    FROM partner_audience_verification_events WHERE partner_identity_id = ? AND city_id = ? ORDER BY aggregate_revision DESC LIMIT 1`)
    .get(partnerIdentityId, cityId) as AudienceVerificationEventRow | undefined) ?? null;

export const isAudienceVerified = (db: Database.Database, partnerIdentityId: string, cityId: string): boolean =>
  currentAudienceVerification(db, partnerIdentityId, cityId)?.event_kind === "VERIFIED";

export const allAudienceVerificationEvents = (db: Database.Database, partnerIdentityId: string, cityId: string): AudienceVerificationEventRow[] =>
  db.prepare(`SELECT id, partner_identity_id, city_id, aggregate_revision, event_kind, supersedes_event_id, evidence_ref, reason, placed_by_admin_id, created_at
    FROM partner_audience_verification_events WHERE partner_identity_id = ? AND city_id = ? ORDER BY aggregate_revision ASC`)
    .all(partnerIdentityId, cityId) as AudienceVerificationEventRow[];

/**
 * Nestable: the caller's own IMMEDIATE transaction (activated by holding
 * the write lock before this reads anything) is what makes "exactly one
 * writer wins" a real property of the (partner, city) revision race - a
 * second writer's IMMEDIATE transaction blocks until the first commits,
 * then re-reads the now-current revision and mints the next one, never
 * colliding. UNIQUE(partner_identity_id, city_id, aggregate_revision) is
 * the structural backstop if that ordering is ever violated.
 *
 * VERIFIED may be minted from ANY current state (fresh verification,
 * re-verification after updated evidence, or re-verification after a
 * prior revocation) - it is always "assert verified now". REVOKED may
 * only be minted when the current state is VERIFIED - there is nothing to
 * revoke otherwise.
 */
export const mintAudienceVerificationEventInTransaction = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  cityId: string,
  eventKind: AudienceVerificationEventKind,
  reason: string,
  evidenceRef: string,
): AudienceVerificationEventRow => {
  const current = currentAudienceVerification(db, partnerIdentityId, cityId);
  if (eventKind === "REVOKED" && current?.event_kind !== "VERIFIED") {
    throw new AudienceVerificationError("AGENT_REFERRALS_AUDIENCE_NOT_VERIFIED", 409, `${partnerIdentityId}:${cityId}`);
  }

  const eventId = id();
  const nextRevision = (current?.aggregate_revision ?? 0) + 1;
  db.prepare(`INSERT INTO partner_audience_verification_events(id, partner_identity_id, city_id, aggregate_revision, event_kind, supersedes_event_id, evidence_ref, reason, placed_by_admin_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(eventId, partnerIdentityId, cityId, nextRevision, eventKind, current?.id ?? null, evidenceRef, reason, admin.admin_id);
  return currentAudienceVerification(db, partnerIdentityId, cityId)!;
};

export const mintAudienceVerificationEvent = (
  db: Database.Database,
  admin: AdminPrincipal,
  partnerIdentityId: string,
  cityId: string,
  eventKind: AudienceVerificationEventKind,
  reason: string,
  evidenceRef: string,
): AudienceVerificationEventRow =>
  db.transaction(() => mintAudienceVerificationEventInTransaction(db, admin, partnerIdentityId, cityId, eventKind, reason, evidenceRef)).immediate();
