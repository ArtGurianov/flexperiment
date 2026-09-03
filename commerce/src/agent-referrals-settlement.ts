import type Database from "better-sqlite3";
import { id, now } from "./crypto";
import { getEngagement, occurrenceFacts, type EngagementRow } from "./agent-referrals-engagement";
import { getPartnerIdentity } from "./agent-referrals-onboarding";
import { currentPayoutProfile } from "./agent-referrals-payout-profile";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { correctEngagementEffectiveRewardSnapshot, currentEffectiveRewardSnapshot, type EffectiveRewardSnapshotRow } from "./agent-referrals-reward-registry";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-6/F10: Agent Referrals settlement authority - a SEPARATE path from
 * legacy prepareSettlement()/markSettlementPaymentMade()/
 * completeSettlementDocuments()/cancelSettlementBeforePayment() in
 * domain.ts, never a branch grafted onto them. Both flows share the same
 * `reward_settlements` table and its existing four-value status enum
 * (F5), partitioned by `settlement_flow` - the migration's own structural
 * guards are what make it impossible for this module to ever produce a
 * settlement whose amount disagrees with its pinned effective reward
 * snapshot (F10: derived, never caller input).
 */

export class SettlementError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type AgentReferralsSettlementRow = {
  id: string;
  agent_id: string;
  occurrence_id: string;
  amount_kopecks: number;
  status: "PREPARED" | "PENDING_DOCUMENT" | "SETTLED" | "CANCELLED_BEFORE_PAYMENT";
  settlement_flow: "AGENT_REFERRALS";
  engagement_id: string;
  engagement_revision_id: string;
  base_registry_snapshot_id: string;
  reward_registry_hash: string;
  effective_reward_snapshot_id: string;
  partner_identity_id: string;
  payout_profile_revision_id: string;
  tax_mode_snapshot: "NPD" | "OTHER";
  legal_profile_revision_id_snapshot: string;
  supersedes_settlement_id: string | null;
  cancellation_reason: string | null;
  prepared_at: string;
  created_by_admin_id: string;
};

const SETTLEMENT_COLUMNS = `id, agent_id, occurrence_id, amount_kopecks, status, settlement_flow, engagement_id, engagement_revision_id,
  base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot,
  legal_profile_revision_id_snapshot, supersedes_settlement_id, cancellation_reason, prepared_at, created_by_admin_id`;

export const agentReferralsSettlementById = (db: Database.Database, settlementId: string): AgentReferralsSettlementRow | null =>
  (db.prepare(`SELECT ${SETTLEMENT_COLUMNS} FROM reward_settlements WHERE id = ? AND settlement_flow = 'AGENT_REFERRALS'`)
    .get(settlementId) as AgentReferralsSettlementRow | undefined) ?? null;

/** At most one, by the migration's own partial UNIQUE index - the settlement (if any) currently live for this exact effective snapshot. */
export const settlementForEffectiveSnapshot = (db: Database.Database, effectiveRewardSnapshotId: string): AgentReferralsSettlementRow | null =>
  (db.prepare(`SELECT ${SETTLEMENT_COLUMNS} FROM reward_settlements WHERE effective_reward_snapshot_id = ? AND settlement_flow = 'AGENT_REFERRALS'`)
    .get(effectiveRewardSnapshotId) as AgentReferralsSettlementRow | undefined) ?? null;

type SettlementContext = {
  effective: EffectiveRewardSnapshotRow;
  engagement: EngagementRow;
  partnerIdentityId: string;
  agentId: string;
  contractorType: string;
  payoutProfileRevisionId: string;
  taxMode: "NPD" | "OTHER";
  legalProfileRevisionId: string;
  rewardRegistryHash: string;
};

/**
 * Resolves and validates every fact a settlement pins, INCLUDING that the
 * named E is the engagement's CURRENT one (MAX sequence) right now - never
 * merely "a real E that once existed". Without this, a settlement could be
 * minted (or, worse, left dangling and later paid) against an E a later
 * correction has already superseded - the exact "stale E stays payable"
 * seam. This is re-derived fresh on every call, including from
 * correctPartnerRewardWithSettlement's own supersession branch (where the
 * named E was just minted in the SAME transaction and is therefore
 * trivially current) and is re-derived YET AGAIN, independently, by
 * payment_authorizations' own structural guard at BEGIN_PAYMENT time - a
 * settlement passing this check at prepare time is not exempt from
 * proving it again at the money-moving step.
 */
const resolveSettlementContext = (db: Database.Database, effectiveRewardSnapshotId: string): SettlementContext => {
  const effective = db.prepare(`SELECT id, engagement_id, engagement_revision_id, base_registry_snapshot_id, supersedes_effective_snapshot_id, sequence, kind, reward_total_kopecks, source_state_hash, reason, created_by_admin_id, canonical_hash, created_at
    FROM engagement_effective_reward_snapshots WHERE id = ?`).get(effectiveRewardSnapshotId) as EffectiveRewardSnapshotRow | undefined;
  if (!effective) throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_EFFECTIVE_SNAPSHOT_NOT_FOUND", 404, effectiveRewardSnapshotId);
  if (effective.reward_total_kopecks <= 0) throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_REWARD_NOT_POSITIVE", 409, effectiveRewardSnapshotId);

  const current = currentEffectiveRewardSnapshot(db, effective.engagement_id);
  if (!current || current.id !== effective.id) throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_EFFECTIVE_SNAPSHOT_STALE", 409, effectiveRewardSnapshotId);

  const engagement = getEngagement(db, effective.engagement_id);
  if (!engagement) throw new SettlementError("AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND", 404, effective.engagement_id);

  const occurrence = occurrenceFacts(db, engagement.occurrence_id)!;
  if (occurrence.fulfillment_status !== "COMPLETED") throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_OCCURRENCE_NOT_COMPLETED", 409, occurrence.fulfillment_status);

  const registry = db.prepare("SELECT id, source_state_hash FROM engagement_reward_registry_snapshot WHERE id = ?")
    .get(effective.base_registry_snapshot_id) as { id: string; source_state_hash: string };

  const partnerIdentity = getPartnerIdentity(db, engagement.partner_identity_id);
  if (!partnerIdentity) throw new SettlementError("AGENT_REFERRALS_PARTNER_IDENTITY_NOT_FOUND", 404, engagement.partner_identity_id);
  if (!partnerIdentity.legal_profile_revision_id) throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_LEGAL_PROFILE_MISSING", 409, partnerIdentity.id);
  const legalProfile = db.prepare("SELECT id, tax_mode FROM agent_referrals_legal_profile_revisions WHERE id = ?")
    .get(partnerIdentity.legal_profile_revision_id) as { id: string; tax_mode: "NPD" | "OTHER" };

  const payoutProfile = currentPayoutProfile(db, partnerIdentity.id);
  if (!payoutProfile || payoutProfile.kind !== "ACTIVE_DESTINATION") throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_PAYOUT_PROFILE_UNUSABLE", 409, partnerIdentity.id);

  const agent = db.prepare("SELECT id, contractor_type FROM agents WHERE id = ?").get(partnerIdentity.agent_id) as { id: string; contractor_type: string };

  return {
    effective, engagement, partnerIdentityId: partnerIdentity.id, agentId: agent.id, contractorType: agent.contractor_type,
    payoutProfileRevisionId: payoutProfile.id, taxMode: legalProfile.tax_mode, legalProfileRevisionId: legalProfile.id,
    rewardRegistryHash: registry.source_state_hash,
  };
};

const mintAgentReferralsSettlement = (
  db: Database.Database,
  admin: AdminPrincipal,
  context: SettlementContext,
  supersedesSettlementId: string | null,
): AgentReferralsSettlementRow => {
  const settlementId = id();
  db.prepare(`INSERT INTO reward_settlements(
      id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id,
      settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id,
      partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot, supersedes_settlement_id)
    VALUES (?, ?, ?, ?, 'PAYOUT_PROFILE', 'PREPARED', ?, ?, ?, 'AGENT_REFERRALS', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      settlementId, context.agentId, context.engagement.occurrence_id, context.effective.reward_total_kopecks, context.contractorType, now(), admin.admin_id,
      context.effective.engagement_id, context.effective.engagement_revision_id, context.effective.base_registry_snapshot_id, context.rewardRegistryHash, context.effective.id,
      context.partnerIdentityId, context.payoutProfileRevisionId, context.taxMode, context.legalProfileRevisionId, supersedesSettlementId,
    );
  return agentReferralsSettlementById(db, settlementId)!;
};

export type PreparePartnerSettlementResult = { settlement: AgentReferralsSettlementRow; replayed: boolean };

/**
 * F10: amount_kopecks is NOT caller input - resolved entirely from the
 * pinned effective_reward_snapshot_id. Idempotent: a second call naming
 * the same E returns the settlement already minted for it, never a second
 * row (the migration's own partial UNIQUE index is the real backstop a
 * raw concurrent duplicate write still hits).
 */
export const preparePartnerSettlement = (
  db: Database.Database,
  admin: AdminPrincipal,
  effectiveRewardSnapshotId: string,
): PreparePartnerSettlementResult => {
  const run = db.transaction((): PreparePartnerSettlementResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "SETTLEMENT_PREPARED");
    const existing = settlementForEffectiveSnapshot(db, effectiveRewardSnapshotId);
    if (existing) return { settlement: existing, replayed: true };
    const context = resolveSettlementContext(db, effectiveRewardSnapshotId);
    const settlement = mintAgentReferralsSettlement(db, admin, context, null);
    return { settlement, replayed: false };
  });
  return run.immediate();
};

/** paid_net (Σ MADE payment_attempts − Σ actual settlement_recoveries) and the exposure a correction leaves once payment already left. Read-only evidence, not itself a mutation. */
export type RecoveryExposure = { paid_net_kopecks: number; current_effective_total_kopecks: number; exposure_kopecks: number };

export const recoveryExposure = (db: Database.Database, engagementId: string): RecoveryExposure => {
  const madeTotal = Number((db.prepare(`SELECT COALESCE(SUM(pat.amount_kopecks), 0) AS total FROM payment_attempts pat
    JOIN reward_settlements rs ON rs.id = pat.settlement_id
    WHERE rs.engagement_id = ? AND rs.settlement_flow = 'AGENT_REFERRALS' AND pat.status = 'MADE'`).get(engagementId) as { total: number }).total);
  const recoveredTotal = Number((db.prepare(`SELECT COALESCE(SUM(sr.amount_recovered_kopecks), 0) AS total FROM settlement_recoveries sr
    JOIN reward_settlements rs ON rs.id = sr.settlement_id
    WHERE rs.engagement_id = ? AND rs.settlement_flow = 'AGENT_REFERRALS'`).get(engagementId) as { total: number }).total);
  const paidNet = madeTotal - recoveredTotal;
  const current = currentEffectiveRewardSnapshot(db, engagementId);
  const currentTotal = current?.reward_total_kopecks ?? 0;
  return { paid_net_kopecks: paidNet, current_effective_total_kopecks: currentTotal, exposure_kopecks: Math.max(0, paidNet - currentTotal) };
};

export type RecoveryExposureEvidenceRow = {
  id: string;
  engagement_id: string;
  settlement_id: string;
  effective_reward_snapshot_id: string;
  paid_net_kopecks: number;
  exposure_kopecks: number;
  created_at: string;
};

/** Append-only immutable evidence (§B-6) - one row per correction that landed while a settlement was already MADE, oldest first. */
export const recoveryExposureEvidenceForEngagement = (db: Database.Database, engagementId: string): RecoveryExposureEvidenceRow[] =>
  db.prepare(`SELECT id, engagement_id, settlement_id, effective_reward_snapshot_id, paid_net_kopecks, exposure_kopecks, created_at
    FROM engagement_recovery_exposure_evidence WHERE engagement_id = ? ORDER BY created_at ASC, id ASC`).all(engagementId) as RecoveryExposureEvidenceRow[];

export type CorrectPartnerRewardResult =
  | { correction: ReturnType<typeof correctEngagementEffectiveRewardSnapshot>; settlement_action: "NONE" }
  | { correction: ReturnType<typeof correctEngagementEffectiveRewardSnapshot>; settlement_action: "RECOVERY_EXPOSURE"; exposure: RecoveryExposure }
  | { correction: ReturnType<typeof correctEngagementEffectiveRewardSnapshot>; settlement_action: "CANCELLED_ZERO"; cancelled_settlement_id: string }
  | { correction: ReturnType<typeof correctEngagementEffectiveRewardSnapshot>; settlement_action: "SUPERSEDED"; cancelled_settlement_id: string; new_settlement_id: string };

/**
 * §B-6 correction/supersession orchestration - the ONE atomic command that
 * runs PR6's correctEngagementEffectiveRewardSnapshot (unchanged) together
 * with whatever it implies for THIS engagement's current AGENT_REFERRALS
 * settlement, if any:
 *
 *   no settlement yet               -> correction only, nothing else to do
 *   settlement PREPARED, no payment -> old CANCELLED_BEFORE_PAYMENT
 *                                       (reason SUPERSEDED_BY_REWARD_CORRECTION),
 *                                       new settlement if E2 > 0, none if E2 = 0
 *   settlement already paid (MADE)  -> old payment/settlement stay
 *                                       untouched; only recovery-exposure
 *                                       evidence is computed
 *   payment IN_PROGRESS/PAYOUT_UNKNOWN
 *   (unsettled, not yet MADE)       -> refused outright: cancelling
 *                                       underneath a live attempt is never
 *                                       automatic
 */
export const correctPartnerRewardWithSettlement = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagementId: string,
  reason: string,
): CorrectPartnerRewardResult => {
  const run = db.transaction((): CorrectPartnerRewardResult => {
    const before = currentEffectiveRewardSnapshot(db, engagementId);
    if (!before) throw new SettlementError("AGENT_REFERRALS_REWARD_REGISTRY_NOT_FINALIZED", 409, engagementId);
    const existingSettlement = settlementForEffectiveSnapshot(db, before.id);

    if (existingSettlement) {
      const madeAttempt = db.prepare("SELECT 1 FROM payment_attempts WHERE settlement_id = ? AND status = 'MADE'").get(existingSettlement.id);
      const unsettledAttempt = db.prepare("SELECT 1 FROM payment_attempts WHERE settlement_id = ? AND status IN ('IN_PROGRESS', 'PAYOUT_UNKNOWN')").get(existingSettlement.id);
      if (!madeAttempt && unsettledAttempt) {
        throw new SettlementError("AGENT_REFERRALS_CORRECTION_BLOCKED_PAYMENT_IN_FLIGHT", 409, existingSettlement.id);
      }
      if (madeAttempt) {
        const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, reason);
        const exposure = recoveryExposure(db, engagementId);
        // §B-6: "immutable correction + recovery-exposure evidence" - a
        // real, append-only row pinning the exact figures this correction
        // produced, not merely a value recoveryExposure() can recompute
        // later from live data (which would drift if settlement_recoveries
        // grows before anyone reads it).
        db.prepare(`INSERT INTO engagement_recovery_exposure_evidence(id, engagement_id, settlement_id, effective_reward_snapshot_id, paid_net_kopecks, exposure_kopecks)
          VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id(), engagementId, existingSettlement.id, correction.effective_snapshot_id, exposure.paid_net_kopecks, exposure.exposure_kopecks);
        return { correction, settlement_action: "RECOVERY_EXPOSURE", exposure };
      }

      const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, reason);
      const cancelled = db.prepare(`UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancellation_reason = 'SUPERSEDED_BY_REWARD_CORRECTION', cancelled_before_payment_at = ?
        WHERE id = ? AND status = 'PREPARED' AND settlement_flow = 'AGENT_REFERRALS'`).run(now(), existingSettlement.id);
      if (cancelled.changes !== 1) throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_SUPERSESSION_CONFLICT", 409, existingSettlement.id);

      if (correction.reward_total_kopecks > 0) {
        const context = resolveSettlementContext(db, correction.effective_snapshot_id);
        const newSettlement = mintAgentReferralsSettlement(db, admin, context, existingSettlement.id);
        return { correction, settlement_action: "SUPERSEDED", cancelled_settlement_id: existingSettlement.id, new_settlement_id: newSettlement.id };
      }
      return { correction, settlement_action: "CANCELLED_ZERO", cancelled_settlement_id: existingSettlement.id };
    }

    const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, reason);
    return { correction, settlement_action: "NONE" };
  });
  return run.immediate();
};
