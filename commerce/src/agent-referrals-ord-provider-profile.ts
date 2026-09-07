import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";

/**
 * Immutable VK ORD provider profile families (plan Phase 8): COUNTERPARTY,
 * PLATFORM, CONTRACT, MEDIA. Configuration, not a business fact - DORMANT
 * readiness explicitly distinguishes seeded static configuration from
 * production business records, so this module calls
 * assertAgentReferralsOperationPermitted nowhere: an admin may record which
 * VK counterparty/platform/contract/media profile Flexperiment operates
 * under long before activation, exactly as ad_channel_policy and the
 * framework templates are seeded pre-activation. No production VK API
 * credentials are modelled here - only the manual/contractual facts MANUAL
 * mode requires (plan §B-4).
 */

export type OrdProviderProfileKind = "COUNTERPARTY" | "PLATFORM" | "CONTRACT" | "MEDIA";

export class OrdProviderProfileError extends Error {
  constructor(readonly code: string, readonly status = 422, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type OrdProviderProfileRevision = {
  id: string;
  profile_kind: OrdProviderProfileKind;
  revision: number;
  content_json: string;
  content_hash: string;
  supersedes_revision_id: string | null;
  reason: string;
  created_by_admin_id: string;
  created_at: string;
};

const COLUMNS = "id, profile_kind, revision, content_json, content_hash, supersedes_revision_id, reason, created_by_admin_id, created_at";

/** "Current" is always MAX(revision) for the exact kind - never a stored pointer. */
export const currentOrdProviderProfile = (db: Database.Database, kind: OrdProviderProfileKind): OrdProviderProfileRevision | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_provider_profile_revisions WHERE profile_kind = ? ORDER BY revision DESC LIMIT 1`)
    .get(kind) as OrdProviderProfileRevision | undefined) ?? null;

export const ordProviderProfileById = (db: Database.Database, revisionId: string): OrdProviderProfileRevision | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_provider_profile_revisions WHERE id = ?`).get(revisionId) as OrdProviderProfileRevision | undefined) ?? null;

/**
 * A real RECURSIVE canonical encoding (crypto.ts's canonicalV2, the same
 * primitive creative_hash/canonical_hash use throughout this schema) -
 * never a shallow JSON.stringify(value, sortedTopLevelKeys) array replacer,
 * which sorts only the TOP-LEVEL keys and therefore can silently omit a
 * nested-only semantic change from the hash (P1.2).
 */
const canonicalContentHash = (content: Record<string, unknown>): string => sha256(canonicalV2(content));

/** Mints the next revision for an exact profile_kind. Forward-only: supersedes the current revision, never edits it. */
export const mintOrdProviderProfile = (
  db: Database.Database,
  adminId: string,
  kind: OrdProviderProfileKind,
  content: Record<string, unknown>,
  reason: string,
): OrdProviderProfileRevision => {
  const run = db.transaction((): OrdProviderProfileRevision => {
    const current = currentOrdProviderProfile(db, kind);
    const revisionId = id();
    const nextRevision = (current?.revision ?? 0) + 1;
    const contentJson = JSON.stringify(content);
    db.prepare(`INSERT INTO ord_provider_profile_revisions(id, profile_kind, revision, content_json, content_hash, supersedes_revision_id, reason, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, kind, nextRevision, contentJson, canonicalContentHash(content), current?.id ?? null, reason, adminId);
    return currentOrdProviderProfile(db, kind)!;
  });
  return run.immediate();
};
