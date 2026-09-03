import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { getEngagement, engagementRevisionById, occurrenceFacts } from "./agent-referrals-engagement";
import { currentEffectiveRewardSnapshot, rewardRegistrySnapshot } from "./agent-referrals-reward-registry";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-3/§B-6 zero-reward closure: mutually exclusive with a settlement by
 * construction (reward_settlements/settlement_acts both CHECK
 * amount_kopecks > 0 and the settlement authority-tuple guard proves the
 * amount equals the pinned E's own total - a positive settlement can never
 * reference a zero-total E, and vice versa). Never rewrites R, which may
 * still record a positive registry total (§B-6: "reward_total = 0, equal to
 * the EFFECTIVE snapshot's total, not an assertion that the registry was
 * zero").
 */

export class ZeroRewardClosureError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type ZeroRewardClosureReason = "NO_ELIGIBLE_CONVERSIONS" | "FULLY_REFUNDED" | "OCCURRENCE_CANCELLED" | "OTHER_POLICY_ZERO" | "CORRECTED_TO_ZERO";

export type ZeroRewardClosureRow = {
  id: string;
  engagement_id: string;
  engagement_revision_id: string;
  base_registry_snapshot_id: string;
  effective_reward_snapshot_id: string;
  reward_total_kopecks: number;
  closure_reason: ZeroRewardClosureReason;
  occurrence_fulfillment_status: "COMPLETED" | "CANCELLED";
  service_period_start_at: string;
  service_period_end_at: string;
  reporting_policy_version: number;
  command_id: string;
  canonical_hash: string;
  closed_by_admin_id: string;
  created_at: string;
};

const CLOSURE_COLUMNS = `id, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id, reward_total_kopecks,
  closure_reason, occurrence_fulfillment_status, service_period_start_at, service_period_end_at, reporting_policy_version, command_id, canonical_hash, closed_by_admin_id, created_at`;

/**
 * Not proven by law, no external field mapping to conform to yet (L11 is
 * still PENDING_EXTERNAL_CONFIRMATION for the ORD representation) - a
 * versioned pin so a later policy revision is itself evidenced, matching
 * every other `*_version`/`*_revision` pin in this schema.
 */
export const ZERO_REWARD_REPORTING_POLICY_VERSION = 1;

export const zeroRewardClosureForEngagement = (db: Database.Database, engagementId: string): ZeroRewardClosureRow | null =>
  (db.prepare(`SELECT ${CLOSURE_COLUMNS} FROM engagement_zero_reward_closures WHERE engagement_id = ?`).get(engagementId) as ZeroRewardClosureRow | undefined) ?? null;

export type CloseZeroRewardResult = { closure: ZeroRewardClosureRow; replayed: boolean };

/**
 * Idempotent by the migration's own UNIQUE(engagement_id) - zero, once
 * reached, is an absorbing floor for this engagement's E chain (PR6's own
 * "no increase" correction rule), so a second call for the same engagement
 * is always a genuine replay, never a race between two distinct legitimate
 * closures.
 */
export const closeEngagementZeroReward = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagementId: string,
  closureReason: ZeroRewardClosureReason,
  commandId: string,
): CloseZeroRewardResult => {
  const run = db.transaction((): CloseZeroRewardResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ZERO_REWARD_CLOSED");
    const existing = zeroRewardClosureForEngagement(db, engagementId);
    if (existing) return { closure: existing, replayed: true };

    const registry = rewardRegistrySnapshot(db, engagementId);
    if (!registry) throw new ZeroRewardClosureError("AGENT_REFERRALS_REWARD_REGISTRY_NOT_FINALIZED", 409, engagementId);
    const effective = currentEffectiveRewardSnapshot(db, engagementId);
    if (!effective) throw new ZeroRewardClosureError("AGENT_REFERRALS_REWARD_REGISTRY_NOT_FINALIZED", 409, engagementId);
    if (effective.reward_total_kopecks !== 0) throw new ZeroRewardClosureError("AGENT_REFERRALS_ZERO_CLOSURE_REWARD_NOT_ZERO", 409, String(effective.reward_total_kopecks));

    // §B-6: zero closure means no effective settlement, no act, no
    // payment. A settlement that was already PAID (MADE, possibly
    // SETTLED) before a later correction drove E to zero is NOT this
    // path - old payment/settlement stay untouched and the correction
    // produces recovery-exposure evidence instead (see
    // correctPartnerRewardWithSettlement). A settlement legitimately
    // CANCELLED_BEFORE_PAYMENT by a pre-payment correction-to-zero is
    // fine and does not block closure. The migration's own relational
    // guard re-proves this identically; this is the clean-error-code
    // early exit.
    const liveSettlement = db.prepare(`SELECT id, status FROM reward_settlements WHERE engagement_id = ? AND settlement_flow = 'AGENT_REFERRALS' AND status != 'CANCELLED_BEFORE_PAYMENT'`)
      .get(engagementId) as { id: string; status: string } | undefined;
    if (liveSettlement) throw new ZeroRewardClosureError("AGENT_REFERRALS_ZERO_CLOSURE_SETTLEMENT_EXISTS", 409, `${liveSettlement.id}:${liveSettlement.status}`);

    const engagement = getEngagement(db, engagementId)!;
    const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
    const revision = engagementRevisionById(db, effective.engagement_revision_id)!;

    const closureId = id();
    const canonicalHash = sha256(canonicalV2({
      engagement_id: engagementId, effective_reward_snapshot_id: effective.id, closure_reason: closureReason, command_id: commandId,
    }));
    db.prepare(`INSERT INTO engagement_zero_reward_closures(
        id, engagement_id, engagement_revision_id, base_registry_snapshot_id, effective_reward_snapshot_id, reward_total_kopecks,
        closure_reason, occurrence_fulfillment_status, service_period_start_at, service_period_end_at, reporting_policy_version,
        command_id, canonical_hash, closed_by_admin_id)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        closureId, engagementId, effective.engagement_revision_id, effective.base_registry_snapshot_id, effective.id,
        closureReason, occurrence.fulfillment_status, revision.publication_start_at, revision.publication_end_at, ZERO_REWARD_REPORTING_POLICY_VERSION,
        commandId, canonicalHash, admin.admin_id,
      );
    return { closure: zeroRewardClosureForEngagement(db, engagementId)!, replayed: false };
  });
  return run.immediate();
};
