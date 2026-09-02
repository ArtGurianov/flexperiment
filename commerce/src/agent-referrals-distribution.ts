import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted, type AgentReferralsOperationClass } from "./agent-referrals-suspension-policy";
import { resolveAgentReferralsChannelPolicy, type ChannelPolicyStatus } from "./agent-referrals-channel-policy";
import type { AdminPrincipal, PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * Minimum actual-distribution facts (plan section B-5c) plus the removal
 * lifecycle (B-5d). A reported distribution is ALWAYS persisted - policy
 * decides classification, never whether reality may be recorded. The
 * current projection is always derived (latest revision + folded event
 * log), never a stored mutable column that could drift from the events
 * that produced it.
 */

export class DistributionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type DistributionActor = PartnerPrincipal | AdminPrincipal;
const actorRealm = (actor: DistributionActor): "ADMIN" | "PARTNER" => actor.realm;

/**
 * A PARTNER actor may only write evidence for an engagement/distribution
 * their own partner_identity_id owns - never another partner's. Admin is
 * always permitted (compliance/correction authority). Every partner-facing
 * write path below calls exactly one of these before touching any row.
 */
const assertEngagementOwnership = (db: Database.Database, engagementId: string, actor: DistributionActor): void => {
  if (actor.realm !== "PARTNER") return;
  const engagement = db.prepare("SELECT partner_identity_id FROM engagements WHERE id = ?").get(engagementId) as { partner_identity_id: string } | undefined;
  if (!engagement) throw new DistributionError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, engagementId);
  if (engagement.partner_identity_id !== actor.partner_identity_id) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_WRONG_PARTNER", 403, engagementId);
};

const assertDistributionOwnership = (db: Database.Database, distributionId: string, actor: DistributionActor): void => {
  if (actor.realm !== "PARTNER") return;
  const row = db.prepare(`SELECT e.partner_identity_id AS partner_identity_id FROM engagement_distributions d JOIN engagements e ON e.id = d.engagement_id WHERE d.id = ?`).get(distributionId) as { partner_identity_id: string } | undefined;
  if (!row) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
  if (row.partner_identity_id !== actor.partner_identity_id) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_WRONG_PARTNER", 403, distributionId);
};

export type ResourceKind = "channel" | "page" | "profile" | "site" | "stream";

export type DistributionReportInput = {
  channel_key: string;
  resource_kind: ResourceKind;
  resource_identifier: string;
  distribution_resource_url: string;
  published_at: string;
  ended_at: string | null;
  evidence_ref: string;
};

export type DistributionRevisionRow = DistributionReportInput & {
  id: string;
  distribution_id: string;
  revision: number;
  supersedes_revision_id: string | null;
  channel_policy_status: ChannelPolicyStatus;
  channel_policy_revision: number | null;
  reported_by: "PARTNER" | "ADMIN";
  correction_reason: string | null;
  canonical_hash: string;
  created_at: string;
};

const REVISION_COLUMNS = "id, distribution_id, revision, supersedes_revision_id, channel_key, channel_policy_status, channel_policy_revision, resource_kind, resource_identifier, distribution_resource_url, published_at, ended_at, reported_by, correction_reason, evidence_ref, canonical_hash, created_at";

export const currentDistributionRevision = (db: Database.Database, distributionId: string): DistributionRevisionRow | null =>
  (db.prepare(`SELECT ${REVISION_COLUMNS} FROM engagement_distribution_revisions WHERE distribution_id = ? ORDER BY revision DESC LIMIT 1`)
    .get(distributionId) as DistributionRevisionRow | undefined) ?? null;

export type DistributionIdentityRow = { id: string; engagement_id: string; engagement_revision_id: string; creative_revision_id: string; created_at: string };

export const getDistribution = (db: Database.Database, distributionId: string): DistributionIdentityRow | null =>
  (db.prepare("SELECT id, engagement_id, engagement_revision_id, creative_revision_id, created_at FROM engagement_distributions WHERE id = ?").get(distributionId) as DistributionIdentityRow | undefined) ?? null;

export const distributionsForEngagement = (db: Database.Database, engagementId: string): DistributionIdentityRow[] =>
  // rowid (insertion order), not created_at - CURRENT_TIMESTAMP is
  // second-precision and several distributions can be reported within the
  // same second. This is a listing convenience, not the regulatory event
  // stream (that is engagement_distribution_events, ordered by its own
  // explicit event_sequence below).
  db.prepare("SELECT id, engagement_id, engagement_revision_id, creative_revision_id, created_at FROM engagement_distributions WHERE engagement_id = ? ORDER BY rowid ASC")
    .all(engagementId) as DistributionIdentityRow[];

export type DistributionEventRow = { id: string; distribution_id: string; event_sequence: number; event_kind: string; actor_realm: string; evidence_ref: string | null; reason: string | null; occurred_at: string };

export const distributionEvents = (db: Database.Database, distributionId: string): DistributionEventRow[] =>
  db.prepare("SELECT id, distribution_id, event_sequence, event_kind, actor_realm, evidence_ref, reason, occurred_at FROM engagement_distribution_events WHERE distribution_id = ? ORDER BY event_sequence ASC")
    .all(distributionId) as DistributionEventRow[];

const REMOVAL_KINDS = new Set(["REMOVAL_REQUIRED", "REMOVAL_CLAIMED", "REMOVAL_CONFIRMED", "OVERDUE_REMOVAL", "REMOVAL_UNVERIFIED"]);
const COMPLIANCE_KINDS = new Set(["MARKED_REPORTABLE", "REVIEW_REQUIRED", "REVIEW_CLEARED"]);

export type DistributionProjection = {
  current_revision: DistributionRevisionRow;
  compliance_state: string | null;
  removal_state: string | null;
};

/** Folded from the event log, never a stored mutable column (B-5c/B-5d). */
export const distributionProjection = (db: Database.Database, distributionId: string): DistributionProjection => {
  const current = currentDistributionRevision(db, distributionId);
  if (!current) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
  const events = distributionEvents(db, distributionId);
  const lastOf = (kinds: Set<string>) => [...events].reverse().find((event) => kinds.has(event.event_kind))?.event_kind ?? null;
  return { current_revision: current, compliance_state: lastOf(COMPLIANCE_KINDS), removal_state: lastOf(REMOVAL_KINDS) };
};

/**
 * event_sequence is this regulatory evidence stream's own durable fold
 * order, allocated inside the caller's IMMEDIATE transaction - never
 * SQLite's implicit rowid, a storage detail this table's readers (and any
 * future DB maintenance/rebuild) must not be relied upon to preserve.
 */
const appendEvent = (db: Database.Database, distributionId: string, eventKind: string, realm: "ADMIN" | "PARTNER" | "SYSTEM", evidenceRef: string | null, reason: string | null): void => {
  const next = (db.prepare("SELECT COALESCE(MAX(event_sequence), 0) AS m FROM engagement_distribution_events WHERE distribution_id = ?").get(distributionId) as { m: number }).m + 1;
  db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_sequence, event_kind, actor_realm, evidence_ref, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id(), distributionId, next, eventKind, realm, evidenceRef, reason);
};

/**
 * DECLARED is always appended first. If the channel policy at published_at
 * is not ALLOWED, or the distribution was not temporally authorized (see
 * resolveHistoricalCreativeAuthority below - published after the
 * authorized window ended, or after the authorization was revoked),
 * REVIEW_REQUIRED is appended instead of MARKED_REPORTABLE - a policy
 * violation, of either kind, is never a reason to reject the record
 * (§B-5e), only to classify it. An unauthorized-in-time publication also
 * gets an immediate REMOVAL_REQUIRED: publishing after publication_end_at
 * is itself prohibited and creates a removal obligation (§B-5d).
 */
const classifyAndAppend = (db: Database.Database, distributionId: string, channelKey: string, publishedAt: string, temporallyAuthorized: boolean, realm: "ADMIN" | "PARTNER" | "SYSTEM"): ChannelPolicyStatus => {
  const resolution = resolveAgentReferralsChannelPolicy(db, channelKey, publishedAt);
  appendEvent(db, distributionId, "DECLARED", realm, null, null);
  if (resolution.status === "ALLOWED" && temporallyAuthorized) {
    appendEvent(db, distributionId, "MARKED_REPORTABLE", realm, null, null);
  } else {
    appendEvent(db, distributionId, "REVIEW_REQUIRED", realm, null, null);
    if (!temporallyAuthorized) appendEvent(db, distributionId, "REMOVAL_REQUIRED", realm, null, "published outside the authorized creative window (superseded, revoked, or after publication_end_at)");
  }
  return resolution.status;
};

const gate = (db: Database.Database, operationClass: AgentReferralsOperationClass) => assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, operationClass);

const canonicalRevisionHash = (input: DistributionReportInput): string => sha256(canonicalV2(input as unknown as Record<string, unknown>));

type HistoricalCreativeAuthority = { creative_revision_id: string; engagement_revision_id: string; authorized: boolean };

/**
 * The creative authorization effectively governing the engagement AT
 * publishedAt - never "whatever is current now". A distribution reported
 * days after the fact must pin the authority that was actually live when
 * the ad was really published, not one a later admin/partner action has
 * since superseded (Phase 5 review note 4). julianday() compares both the
 * SQLite-shaped effective_at/revoked_at (CURRENT_TIMESTAMP) and the
 * caller-supplied ISO published_at correctly - a raw TEXT comparison would
 * reproduce the exact 'T' vs ' ' bug this codebase has already fixed
 * elsewhere. "Most recently effective at or before publishedAt" always
 * resolves to something as long as ANY authorization existed by then, even
 * one already revoked or past its own window by that point - `authorized`
 * distinguishes that case so classifyAndAppend can flag it, while the
 * distribution identity still pins the real (engagement_revision_id,
 * creative_revision_id) pair that was actually live or most recently live.
 */
const resolveHistoricalCreativeAuthority = (db: Database.Database, engagementId: string, publishedAt: string): HistoricalCreativeAuthority => {
  const row = db.prepare(`
    SELECT eca.creative_revision_id AS creative_revision_id, eca.engagement_revision_id AS engagement_revision_id,
      (eca.revoked_at IS NOT NULL AND julianday(eca.revoked_at) <= julianday(?)) AS revoked_by_then,
      (julianday(?) > julianday(er.publication_end_at)) AS past_window
    FROM engagement_creative_authorizations eca
    JOIN engagement_revisions er ON er.id = eca.engagement_revision_id
    WHERE eca.engagement_id = ? AND julianday(eca.effective_at) <= julianday(?)
    ORDER BY julianday(eca.effective_at) DESC LIMIT 1
  `).get(publishedAt, publishedAt, engagementId, publishedAt) as { creative_revision_id: string; engagement_revision_id: string; revoked_by_then: number; past_window: number } | undefined;
  if (!row) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NO_AUTHORIZATION_EFFECTIVE_AT_PUBLICATION", 409, publishedAt);
  return { creative_revision_id: row.creative_revision_id, engagement_revision_id: row.engagement_revision_id, authorized: !row.revoked_by_then && !row.past_window };
};

/** Whether the PINNED (identity-fixed) engagement revision's publication window still covered publishedAt - used by corrections, which never re-resolve authority (see correctDistribution). */
const isWithinPublicationWindow = (db: Database.Database, engagementRevisionId: string, publishedAt: string): boolean => {
  const row = db.prepare("SELECT (julianday(?) > julianday(publication_end_at)) AS past_window FROM engagement_revisions WHERE id = ?").get(publishedAt, engagementRevisionId) as { past_window: number };
  return !row.past_window;
};

export type ReportDistributionResult = { distribution_id: string; revision: DistributionRevisionRow };

/**
 * A NEW distribution. Resolves and binds to the exact (engagement_revision_id,
 * creative_revision_id) pair that governed the engagement AT published_at -
 * never "whatever is current now" (Phase 5 review note 4). The fact is
 * ALWAYS persisted; policy and temporal authority classify it, never reject
 * it (§B-5e's "a policy violation must never erase evidence"). Refuses only
 * if the caller is a PARTNER reporting for an engagement they do not own.
 */
export const reportDistribution = (db: Database.Database, actor: DistributionActor, engagementId: string, input: DistributionReportInput): ReportDistributionResult => {
  const run = db.transaction((): ReportDistributionResult => {
    gate(db, "DISTRIBUTION_FACT_REPORTING");
    assertEngagementOwnership(db, engagementId, actor);

    const authority = resolveHistoricalCreativeAuthority(db, engagementId, input.published_at);

    const distributionId = id();
    db.prepare(`INSERT INTO engagement_distributions(id, engagement_id, engagement_revision_id, creative_revision_id) VALUES (?, ?, ?, ?)`)
      .run(distributionId, engagementId, authority.engagement_revision_id, authority.creative_revision_id);

    const classification = resolveAgentReferralsChannelPolicy(db, input.channel_key, input.published_at);
    const revisionId = id();
    db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, supersedes_revision_id, channel_key, channel_policy_status, channel_policy_revision, resource_kind, resource_identifier, distribution_resource_url, published_at, ended_at, reported_by, correction_reason, evidence_ref, canonical_hash)
      VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(revisionId, distributionId, input.channel_key, classification.status, classification.policy_revision, input.resource_kind, input.resource_identifier,
        input.distribution_resource_url, input.published_at, input.ended_at, actorRealm(actor), input.evidence_ref, canonicalRevisionHash(input));

    classifyAndAppend(db, distributionId, input.channel_key, input.published_at, authority.authorized, actorRealm(actor));
    return { distribution_id: distributionId, revision: currentDistributionRevision(db, distributionId)! };
  });
  return run.immediate();
};

/**
 * A CORRECTION: a new revision with provenance, never an UPDATE over a
 * filed fact. Anything already submitted to the ORD keeps its original
 * revision's provenance. Never re-resolves creative authority - the
 * distribution's identity-pinned (engagement_revision_id,
 * creative_revision_id) is immutable once set; a correction only fixes
 * the REPORTED FACTS (channel/URL/timing details), re-classified against
 * that same pinned revision's publication window.
 */
export const correctDistribution = (db: Database.Database, actor: DistributionActor, distributionId: string, input: DistributionReportInput, correctionReason: string): ReportDistributionResult => {
  const run = db.transaction((): ReportDistributionResult => {
    gate(db, "DISTRIBUTION_FACT_REPORTING");
    assertDistributionOwnership(db, distributionId, actor);
    const current = currentDistributionRevision(db, distributionId);
    if (!current) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
    if (!correctionReason.trim()) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_CORRECTION_REASON_REQUIRED", 422);
    const identity = getDistribution(db, distributionId)!;

    const classification = resolveAgentReferralsChannelPolicy(db, input.channel_key, input.published_at);
    const revisionId = id();
    db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, supersedes_revision_id, channel_key, channel_policy_status, channel_policy_revision, resource_kind, resource_identifier, distribution_resource_url, published_at, ended_at, reported_by, correction_reason, evidence_ref, canonical_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, distributionId, current.revision + 1, current.id, input.channel_key, classification.status, classification.policy_revision, input.resource_kind,
        input.resource_identifier, input.distribution_resource_url, input.published_at, input.ended_at, actorRealm(actor), correctionReason, input.evidence_ref, canonicalRevisionHash(input));

    const stillWithinWindow = isWithinPublicationWindow(db, identity.engagement_revision_id, input.published_at);
    classifyAndAppend(db, distributionId, input.channel_key, input.published_at, stillWithinWindow, actorRealm(actor));
    return { distribution_id: distributionId, revision: currentDistributionRevision(db, distributionId)! };
  });
  return run.immediate();
};

const appendLifecycleEvent = (db: Database.Database, actor: DistributionActor, distributionId: string, eventKind: string, operationClass: AgentReferralsOperationClass, evidenceRef: string | null, reason: string | null): void => {
  const run = db.transaction(() => {
    gate(db, operationClass);
    assertDistributionOwnership(db, distributionId, actor);
    if (!currentDistributionRevision(db, distributionId)) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
    appendEvent(db, distributionId, eventKind, actorRealm(actor), evidenceRef, reason);
  });
  run.immediate();
};

/** Admin/system: marks a distribution's window closed and removal owed. */
export const requireRemoval = (db: Database.Database, admin: AdminPrincipal, distributionId: string, reason: string): void =>
  appendLifecycleEvent(db, admin, distributionId, "REMOVAL_REQUIRED", "REMOVAL_VERIFICATION", null, reason);
/** Partner: claims the content was taken down. Refused for a distribution owned by a different partner. */
export const claimRemoval = (db: Database.Database, partner: PartnerPrincipal, distributionId: string, evidenceRef: string): void =>
  appendLifecycleEvent(db, partner, distributionId, "REMOVAL_CLAIMED", "PUBLICATION_REMOVAL", evidenceRef, null);
/** Admin: independently confirms removal - the per-distribution authority §B-5d requires, never an aggregate shortcut. */
export const confirmRemoval = (db: Database.Database, admin: AdminPrincipal, distributionId: string, evidenceRef: string): void =>
  appendLifecycleEvent(db, admin, distributionId, "REMOVAL_CONFIRMED", "PUBLICATION_REMOVAL", evidenceRef, null);
export const markOverdueRemoval = (db: Database.Database, admin: AdminPrincipal, distributionId: string, reason: string): void =>
  appendLifecycleEvent(db, admin, distributionId, "OVERDUE_REMOVAL", "REMOVAL_VERIFICATION", null, reason);
export const markRemovalUnverified = (db: Database.Database, admin: AdminPrincipal, distributionId: string, reason: string): void =>
  appendLifecycleEvent(db, admin, distributionId, "REMOVAL_UNVERIFIED", "REMOVAL_VERIFICATION", null, reason);
export const markReviewCleared = (db: Database.Database, admin: AdminPrincipal, distributionId: string, reason: string): void =>
  appendLifecycleEvent(db, admin, distributionId, "REVIEW_CLEARED", "REMOVAL_VERIFICATION", null, reason);
