import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted, type AgentReferralsOperationClass } from "./agent-referrals-suspension-policy";
import { resolveAgentReferralsChannelPolicy, type ChannelPolicyStatus } from "./agent-referrals-channel-policy";
import { currentCreativeAuthorization } from "./agent-referrals-creative";
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
  // same second.
  db.prepare("SELECT id, engagement_id, engagement_revision_id, creative_revision_id, created_at FROM engagement_distributions WHERE engagement_id = ? ORDER BY rowid ASC")
    .all(engagementId) as DistributionIdentityRow[];

export type DistributionEventRow = { id: string; distribution_id: string; event_kind: string; actor_realm: string; evidence_ref: string | null; reason: string | null; occurred_at: string };

export const distributionEvents = (db: Database.Database, distributionId: string): DistributionEventRow[] =>
  // rowid, not occurred_at - strftime('%f') is millisecond precision, and
  // several events (e.g. DECLARED then MARKED_REPORTABLE) are routinely
  // inserted within the same millisecond; a timestamp+random-UUID tiebreak
  // would let insertion order silently scramble, exactly the bug class
  // engagement_creative_revisions' own `revision` column exists to avoid.
  // rowid is SQLite's own monotonic insertion-order counter for this
  // ordinary (non-WITHOUT ROWID) table, so it needs no schema change.
  db.prepare("SELECT id, distribution_id, event_kind, actor_realm, evidence_ref, reason, occurred_at FROM engagement_distribution_events WHERE distribution_id = ? ORDER BY rowid ASC")
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

const appendEvent = (db: Database.Database, distributionId: string, eventKind: string, realm: "ADMIN" | "PARTNER" | "SYSTEM", evidenceRef: string | null, reason: string | null): void => {
  db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_kind, actor_realm, evidence_ref, reason) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id(), distributionId, eventKind, realm, evidenceRef, reason);
};

const classifyAndAppend = (db: Database.Database, distributionId: string, channelKey: string, publishedAt: string, realm: "ADMIN" | "PARTNER" | "SYSTEM"): { status: ChannelPolicyStatus; policyRevision: number | null } => {
  const resolution = resolveAgentReferralsChannelPolicy(db, channelKey, publishedAt);
  appendEvent(db, distributionId, "DECLARED", realm, null, null);
  appendEvent(db, distributionId, resolution.status === "ALLOWED" ? "MARKED_REPORTABLE" : "REVIEW_REQUIRED", realm, null, null);
  return { status: resolution.status, policyRevision: resolution.policy_revision };
};

const gate = (db: Database.Database, operationClass: AgentReferralsOperationClass) => assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, operationClass);

const canonicalRevisionHash = (input: DistributionReportInput): string => sha256(canonicalV2(input as unknown as Record<string, unknown>));

export type ReportDistributionResult = { distribution_id: string; revision: DistributionRevisionRow };

/**
 * A NEW distribution. Always resolves and binds to the engagement's
 * CURRENT creative authorization - the exact (engagement_revision_id,
 * creative_revision_id) pair the partner is currently authorized to
 * publish under. The fact is ALWAYS persisted; policy classifies it, never
 * rejects it (§B-5e's "a policy violation must never erase evidence").
 */
export const reportDistribution = (db: Database.Database, actor: DistributionActor, engagementId: string, input: DistributionReportInput): ReportDistributionResult => {
  const run = db.transaction((): ReportDistributionResult => {
    gate(db, "DISTRIBUTION_FACT_REPORTING");

    const authorization = currentCreativeAuthorization(db, engagementId);
    if (!authorization) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_REQUIRES_CREATIVE_AUTHORIZATION", 409, engagementId);

    const distributionId = id();
    db.prepare(`INSERT INTO engagement_distributions(id, engagement_id, engagement_revision_id, creative_revision_id) VALUES (?, ?, ?, ?)`)
      .run(distributionId, engagementId, authorization.engagement_revision_id, authorization.creative_revision_id);

    const classification = resolveAgentReferralsChannelPolicy(db, input.channel_key, input.published_at);
    const revisionId = id();
    db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, supersedes_revision_id, channel_key, channel_policy_status, channel_policy_revision, resource_kind, resource_identifier, distribution_resource_url, published_at, ended_at, reported_by, correction_reason, evidence_ref, canonical_hash)
      VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(revisionId, distributionId, input.channel_key, classification.status, classification.policy_revision, input.resource_kind, input.resource_identifier,
        input.distribution_resource_url, input.published_at, input.ended_at, actorRealm(actor), input.evidence_ref, canonicalRevisionHash(input));

    classifyAndAppend(db, distributionId, input.channel_key, input.published_at, actorRealm(actor));
    return { distribution_id: distributionId, revision: currentDistributionRevision(db, distributionId)! };
  });
  return run.immediate();
};

/** A CORRECTION: a new revision with provenance, never an UPDATE over a filed fact. Anything already submitted to the ORD keeps its original revision's provenance. */
export const correctDistribution = (db: Database.Database, actor: DistributionActor, distributionId: string, input: DistributionReportInput, correctionReason: string): ReportDistributionResult => {
  const run = db.transaction((): ReportDistributionResult => {
    gate(db, "DISTRIBUTION_FACT_REPORTING");
    const current = currentDistributionRevision(db, distributionId);
    if (!current) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
    if (!correctionReason.trim()) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_CORRECTION_REASON_REQUIRED", 422);

    const classification = resolveAgentReferralsChannelPolicy(db, input.channel_key, input.published_at);
    const revisionId = id();
    db.prepare(`INSERT INTO engagement_distribution_revisions(id, distribution_id, revision, supersedes_revision_id, channel_key, channel_policy_status, channel_policy_revision, resource_kind, resource_identifier, distribution_resource_url, published_at, ended_at, reported_by, correction_reason, evidence_ref, canonical_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, distributionId, current.revision + 1, current.id, input.channel_key, classification.status, classification.policy_revision, input.resource_kind,
        input.resource_identifier, input.distribution_resource_url, input.published_at, input.ended_at, actorRealm(actor), correctionReason, input.evidence_ref, canonicalRevisionHash(input));

    classifyAndAppend(db, distributionId, input.channel_key, input.published_at, actorRealm(actor));
    return { distribution_id: distributionId, revision: currentDistributionRevision(db, distributionId)! };
  });
  return run.immediate();
};

const appendLifecycleEvent = (db: Database.Database, actor: DistributionActor, distributionId: string, eventKind: string, operationClass: AgentReferralsOperationClass, evidenceRef: string | null, reason: string | null): void => {
  const run = db.transaction(() => {
    gate(db, operationClass);
    if (!currentDistributionRevision(db, distributionId)) throw new DistributionError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, distributionId);
    appendEvent(db, distributionId, eventKind, actorRealm(actor), evidenceRef, reason);
  });
  run.immediate();
};

/** Admin/system: marks a distribution's window closed and removal owed. */
export const requireRemoval = (db: Database.Database, admin: AdminPrincipal, distributionId: string, reason: string): void =>
  appendLifecycleEvent(db, admin, distributionId, "REMOVAL_REQUIRED", "REMOVAL_VERIFICATION", null, reason);
/** Partner: claims the content was taken down. */
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
