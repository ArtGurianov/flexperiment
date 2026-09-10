import type Database from "better-sqlite3";
import { requireObservedVersion } from "./agent-referrals-command-precondition";
import { id, now } from "./crypto";
import { getEngagement, occurrenceFacts, resolveActivatedLegalProfileBinding, type EngagementRow } from "./agent-referrals-engagement";
import { getPartnerIdentity } from "./agent-referrals-onboarding";
import { currentPayoutProfile } from "./agent-referrals-payout-profile";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { correctEngagementEffectiveRewardSnapshot, currentEffectiveRewardSnapshot, type EffectiveRewardSnapshotRow } from "./agent-referrals-reward-registry";
import { resolveCurrentLegalProfileBinding } from "./agent-referrals-legal-profile";
import { resolveTaxTreatmentForLegalProfileAt } from "./agent-referrals-tax-treatment";
import { canonicalizeSettlementTaxV1 } from "./agent-referrals-ord-canonical";
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
  tax_treatment_revision_id_snapshot: string;
  tax_canonicalization_version: string;
  tax_canonical_json: string;
  tax_canonical_hash: string;
  prepared_at: string;
  created_by_admin_id: string;
};

const SETTLEMENT_COLUMNS = `id, agent_id, occurrence_id, amount_kopecks, status, settlement_flow, engagement_id, engagement_revision_id,
  base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot,
  legal_profile_revision_id_snapshot, supersedes_settlement_id, cancellation_reason,
  tax_treatment_revision_id_snapshot, tax_canonicalization_version, tax_canonical_json, tax_canonical_hash, prepared_at, created_by_admin_id`;

export const agentReferralsSettlementById = (db: Database.Database, settlementId: string): AgentReferralsSettlementRow | null =>
  (db.prepare(`SELECT ${SETTLEMENT_COLUMNS} FROM reward_settlements WHERE id = ? AND settlement_flow = 'AGENT_REFERRALS'`)
    .get(settlementId) as AgentReferralsSettlementRow | undefined) ?? null;

/** At most one, by the migration's own partial UNIQUE index - the settlement (if any) currently live for this exact effective snapshot. */
export const settlementForEffectiveSnapshot = (db: Database.Database, effectiveRewardSnapshotId: string): AgentReferralsSettlementRow | null =>
  (db.prepare(`SELECT ${SETTLEMENT_COLUMNS} FROM reward_settlements WHERE effective_reward_snapshot_id = ? AND settlement_flow = 'AGENT_REFERRALS'`)
    .get(effectiveRewardSnapshotId) as AgentReferralsSettlementRow | undefined) ?? null;

/**
 * The engagement's PAID settlement, found independent of which E it
 * currently pins - once a settlement is paid (MADE -> PENDING_DOCUMENT or
 * SETTLED), no replacement settlement is EVER minted for that engagement
 * again (the pre-payment supersession branch below only ever fires while
 * `!madeAttempt`), so at most one row can ever match. Matching by "pins
 * the CURRENT E" instead would silently stop finding it after the FIRST
 * post-payment correction, since a paid settlement keeps pinning its
 * original E forever while later corrections advance the engagement's
 * current E past it - exactly the P1.9a defect this query exists to avoid.
 */
export const paidSettlementForEngagement = (db: Database.Database, engagementId: string): AgentReferralsSettlementRow | null =>
  (db.prepare(`SELECT ${SETTLEMENT_COLUMNS} FROM reward_settlements WHERE engagement_id = ? AND settlement_flow = 'AGENT_REFERRALS' AND status IN ('PENDING_DOCUMENT', 'SETTLED')`)
    .get(engagementId) as AgentReferralsSettlementRow | undefined) ?? null;

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
  taxTreatmentRevisionId: string;
  taxCanonicalizationVersion: string;
  taxCanonicalJson: string;
  taxCanonicalHash: string;
  preparedAt: string;
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

  // D2 §4/§5-A: tax_mode and contractor_type both come from the SAME pinned
  // revision - resolveCurrentLegalProfileBinding proves pointer == MAX
  // first, so this is never agents.contractor_type (a second, independently
  // mutable copy) and never a revision read by the pointer alone. No
  // settlement-local "pointer is null" pre-check exists here on purpose:
  // classifying that case as a friendly LEGAL_PROFILE_MISSING would be
  // wrong the moment MAX is non-null (that is POINTER_DIVERGED, a
  // structural defect, not "never verified") - one resolver owns the
  // entire classification, never a locally-duplicated partial one.
  const currentLegalProfile = resolveCurrentLegalProfileBinding(db, partnerIdentity);

  // D2 §5-Б: the engagement's own activation-pinned legal identity must
  // still be the current one. This is what makes it structurally
  // impossible to mint a NEW payable settlement for old work under a legal
  // identity the engagement was never activated under - including via the
  // post-payment RECOVERY_EXPOSURE correction path, which the blocking
  // predicate alone cannot close (it only gates supersession, not later
  // settlement minting against an already-superseded engagement).
  const activatedLegalProfile = resolveActivatedLegalProfileBinding(db, engagement.id);
  if (activatedLegalProfile.id !== currentLegalProfile.id) {
    throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_LEGAL_PROFILE_BINDING_MISMATCH", 409, `activated=${activatedLegalProfile.id} current=${currentLegalProfile.id}`);
  }

  const payoutProfile = currentPayoutProfile(db, partnerIdentity.id);
  if (!payoutProfile || payoutProfile.kind !== "ACTIVE_DESTINATION") throw new SettlementError("AGENT_REFERRALS_SETTLEMENT_PAYOUT_PROFILE_UNUSABLE", 409, partnerIdentity.id);

  // PR-F: resolved as of an explicit operational instant, named for exactly
  // what it is - NOT asserted as a legal VAT tax point (that determination
  // depends on facts and NK RF rules this codebase does not model). For v1
  // this is the settlement-preparation instant; a future revision may
  // resolve against a different, more precisely-defined business instant
  // without changing this function's own contract (one instant, resolved
  // once, pinned forever - never re-resolved for an already-minted
  // settlement).
  //
  // Captured EXACTLY once here (review round 1, P1.2) and reused below AND
  // by mintAgentReferralsSettlement's own prepared_at - not a second,
  // independent now() call there. Two separate clock reads could otherwise
  // straddle a tax-treatment boundary (a treatment with effective_from
  // falling between the two reads), leaving an immutable settlement whose
  // own prepared_at is already past a treatment its own pinned snapshot
  // does not reflect - silently contradicting this comment's own claim that
  // the resolution instant IS the settlement-preparation instant.
  const preparedAt = now();
  const taxTreatment = resolveTaxTreatmentForLegalProfileAt(db, currentLegalProfile.id, preparedAt);
  if (!taxTreatment) throw new SettlementError("AGENT_REFERRALS_TAX_TREATMENT_MISSING", 409, currentLegalProfile.id);
  const taxCanonical = canonicalizeSettlementTaxV1(taxTreatment);

  return {
    effective, engagement, partnerIdentityId: partnerIdentity.id, agentId: partnerIdentity.agent_id, contractorType: currentLegalProfile.projected_contractor_type,
    payoutProfileRevisionId: payoutProfile.id, taxMode: currentLegalProfile.tax_mode, legalProfileRevisionId: currentLegalProfile.id,
    rewardRegistryHash: registry.source_state_hash,
    taxTreatmentRevisionId: taxTreatment.id, taxCanonicalizationVersion: taxCanonical.version, taxCanonicalJson: taxCanonical.canonical_json, taxCanonicalHash: taxCanonical.canonical_hash,
    preparedAt,
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
      partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot, supersedes_settlement_id,
      tax_treatment_revision_id_snapshot, tax_canonicalization_version, tax_canonical_json, tax_canonical_hash)
    VALUES (?, ?, ?, ?, 'PAYOUT_PROFILE', 'PREPARED', ?, ?, ?, 'AGENT_REFERRALS', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      settlementId, context.agentId, context.engagement.occurrence_id, context.effective.reward_total_kopecks, context.contractorType, context.preparedAt, admin.admin_id,
      context.effective.engagement_id, context.effective.engagement_revision_id, context.effective.base_registry_snapshot_id, context.rewardRegistryHash, context.effective.id,
      context.partnerIdentityId, context.payoutProfileRevisionId, context.taxMode, context.legalProfileRevisionId, supersedesSettlementId,
      context.taxTreatmentRevisionId, context.taxCanonicalizationVersion, context.taxCanonicalJson, context.taxCanonicalHash,
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
 * with whatever it implies for THIS engagement's AGENT_REFERRALS
 * settlement, if any:
 *
 *   no settlement yet               -> correction only, nothing else to do
 *   settlement already paid (MADE)  -> old payment/settlement stay
 *                                       untouched; immutable recovery-
 *                                       exposure evidence is recorded -
 *                                       every time, for every correction
 *                                       that lands after payment, found by
 *                                       the settlement's PAID status, never
 *                                       by which E it currently pins (a
 *                                       paid settlement's own E is frozen
 *                                       at whatever it was when it was
 *                                       minted, while the engagement's
 *                                       current E keeps advancing)
 *   settlement PREPARED, no payment -> old CANCELLED_BEFORE_PAYMENT
 *                                       (reason SUPERSEDED_BY_REWARD_CORRECTION),
 *                                       new settlement if E2 > 0, none if E2 = 0
 *   payment IN_PROGRESS/PAYOUT_UNKNOWN
 *   (unsettled, not yet MADE)       -> refused outright: cancelling
 *                                       underneath a live attempt is never
 *                                       automatic (the migration's own
 *                                       trigger on engagement_effective_
 *                                       reward_snapshots is the real
 *                                       structural backstop for this -
 *                                       this check exists only to fail
 *                                       with a clean error code first)
 */
export const correctPartnerRewardWithSettlement = (
  db: Database.Database,
  admin: AdminPrincipal,
  engagementId: string,
  reason: string,
  /**
   * PR-C2 STALE_BOUND: the effective snapshot the correction was decided
   * against. Every call mints a NEW E, so a retried correction after a
   * second, genuine correction would mint a third - recomputing a total
   * from state that has since moved, and (post-payment) writing another
   * recovery-exposure row against it.
   */
  expectedCurrentEffectiveSnapshotId: string,
): CorrectPartnerRewardResult => {
  const run = db.transaction((): CorrectPartnerRewardResult => {
    const before = currentEffectiveRewardSnapshot(db, engagementId);
    if (!before) throw new SettlementError("AGENT_REFERRALS_REWARD_REGISTRY_NOT_FINALIZED", 409, engagementId);
    requireObservedVersion("AGENT_REFERRALS_REWARD_CORRECTION_STALE", expectedCurrentEffectiveSnapshotId, before.id);

    const paidSettlement = paidSettlementForEngagement(db, engagementId);
    if (paidSettlement) {
      const correction = correctEngagementEffectiveRewardSnapshot(db, admin, engagementId, reason);
      const exposure = recoveryExposure(db, engagementId);
      // §B-6: "immutable correction + recovery-exposure evidence" - a
      // real, append-only row pinning the exact figures THIS correction
      // produced, written on EVERY post-MADE correction (not only the
      // first - UNIQUE(effective_reward_snapshot_id) on the table makes a
      // second row for the same correction impossible, but each new
      // correction mints its own distinct E and therefore its own row).
      db.prepare(`INSERT INTO engagement_recovery_exposure_evidence(id, engagement_id, settlement_id, effective_reward_snapshot_id, paid_net_kopecks, exposure_kopecks)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id(), engagementId, paidSettlement.id, correction.effective_snapshot_id, exposure.paid_net_kopecks, exposure.exposure_kopecks);
      return { correction, settlement_action: "RECOVERY_EXPOSURE", exposure };
    }

    const existingSettlement = settlementForEffectiveSnapshot(db, before.id);
    if (existingSettlement) {
      const unsettledAttempt = db.prepare("SELECT 1 FROM payment_attempts WHERE settlement_id = ? AND status IN ('IN_PROGRESS', 'PAYOUT_UNKNOWN')").get(existingSettlement.id);
      if (unsettledAttempt) throw new SettlementError("AGENT_REFERRALS_CORRECTION_BLOCKED_PAYMENT_IN_FLIGHT", 409, existingSettlement.id);

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
