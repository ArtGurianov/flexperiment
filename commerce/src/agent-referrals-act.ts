import type Database from "better-sqlite3";
import { id, now } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { agentReferralsSettlementById, type AgentReferralsSettlementRow } from "./agent-referrals-settlement";
import { consumeSettlementStepUpGrantInTransaction } from "./agent-referrals-settlement-step-up";
import { currentEffectiveRewardSnapshot } from "./agent-referrals-reward-registry";
import type { AdminPrincipal, PartnerPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-6 act authority. Not a mutable document row: settlement_acts pins the
 * exact financial/legal authority (immutable from creation, one legal
 * one-way mutation - presented_at); acceptance and dispute are separate,
 * mutually exclusive, append-only evidence tables the migration itself
 * enforces (no "accepted=true" flag anywhere for this module or raw SQL to
 * flip without producing real evidence).
 */

export class SettlementActError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type SettlementActRow = {
  id: string;
  settlement_id: string;
  engagement_id: string;
  engagement_revision_id: string;
  effective_reward_snapshot_id: string;
  partner_identity_id: string;
  amount_kopecks: number;
  presented_at: string | null;
  created_by_admin_id: string;
  created_at: string;
};

const ACT_COLUMNS = "id, settlement_id, engagement_id, engagement_revision_id, effective_reward_snapshot_id, partner_identity_id, amount_kopecks, presented_at, created_by_admin_id, created_at";

export const settlementActById = (db: Database.Database, actId: string): SettlementActRow | null =>
  (db.prepare(`SELECT ${ACT_COLUMNS} FROM settlement_acts WHERE id = ?`).get(actId) as SettlementActRow | undefined) ?? null;

export const settlementActForSettlement = (db: Database.Database, settlementId: string): SettlementActRow | null =>
  (db.prepare(`SELECT ${ACT_COLUMNS} FROM settlement_acts WHERE settlement_id = ?`).get(settlementId) as SettlementActRow | undefined) ?? null;

/**
 * Recheck that a settlement is still viable authority for NEW act
 * evidence: still PREPARED (not yet superseded/cancelled or already paid
 * onward) AND still pinned to its engagement's CURRENT effective reward
 * snapshot (never stale - the same recheck preparePartnerSettlement and
 * beginPayment each perform independently). Disputing an already-
 * presented act is exempt from this - see disputeSettlementAct's own
 * header - since that records a partner's objection to a document they
 * were genuinely shown, never new financial authority.
 */
const assertSettlementActionable = (db: Database.Database, settlement: AgentReferralsSettlementRow): void => {
  if (settlement.status !== "PREPARED") throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_SETTLEMENT_NOT_PREPARED", 409, settlement.id);
  const current = currentEffectiveRewardSnapshot(db, settlement.engagement_id);
  if (!current || current.id !== settlement.effective_reward_snapshot_id) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_SETTLEMENT_STALE", 409, settlement.id);
};

export type GenerateActResult = { act: SettlementActRow; replayed: boolean };

/** ACT_PREPARED. Idempotent by the migration's own UNIQUE(settlement_id) - a settlement can have at most one act, ever. */
export const generateSettlementAct = (db: Database.Database, admin: AdminPrincipal, settlementId: string): GenerateActResult => {
  const run = db.transaction((): GenerateActResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ACT_GENERATION");
    const existing = settlementActForSettlement(db, settlementId);
    if (existing) return { act: existing, replayed: true };
    const settlement = agentReferralsSettlementById(db, settlementId);
    if (!settlement) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_NOT_FOUND", 404, settlementId);
    assertSettlementActionable(db, settlement);

    const actId = id();
    db.prepare(`INSERT INTO settlement_acts(id, settlement_id, engagement_id, engagement_revision_id, effective_reward_snapshot_id, partner_identity_id, amount_kopecks, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(actId, settlement.id, settlement.engagement_id, settlement.engagement_revision_id, settlement.effective_reward_snapshot_id, settlement.partner_identity_id, settlement.amount_kopecks, admin.admin_id);
    return { act: settlementActById(db, actId)!, replayed: false };
  });
  return run.immediate();
};

export type PresentActResult = { act: SettlementActRow; replayed: boolean };

/** ACT_PREPARED -> ACT_PRESENTED. One-way; idempotent replay returns the already-presented act unchanged. */
export const presentSettlementAct = (db: Database.Database, admin: AdminPrincipal, actId: string): PresentActResult => {
  const run = db.transaction((): PresentActResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ACT_PRESENTATION");
    const act = settlementActById(db, actId);
    if (!act) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_FOUND", 404, actId);
    if (act.presented_at) return { act, replayed: true };
    const settlement = agentReferralsSettlementById(db, act.settlement_id);
    if (!settlement) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_NOT_FOUND", 404, act.settlement_id);
    assertSettlementActionable(db, settlement);
    db.prepare("UPDATE settlement_acts SET presented_at = ? WHERE id = ? AND presented_at IS NULL").run(now(), actId);
    return { act: settlementActById(db, actId)!, replayed: false };
  });
  return run.immediate();
};

export type ActAcceptanceRow = {
  id: string;
  act_id: string;
  partner_identity_id: string;
  step_up_grant_id: string;
  accepted_amount_kopecks: number;
  accepted_engagement_revision_id: string;
  created_at: string;
};

export const actAcceptanceForAct = (db: Database.Database, actId: string): ActAcceptanceRow | null =>
  (db.prepare("SELECT id, act_id, partner_identity_id, step_up_grant_id, accepted_amount_kopecks, accepted_engagement_revision_id, created_at FROM settlement_act_acceptances WHERE act_id = ?")
    .get(actId) as ActAcceptanceRow | undefined) ?? null;

/**
 * Partner-only by construction: this function takes a PartnerPrincipal,
 * never an AdminPrincipal - admin cannot ACT_ACCEPTED. Consumes a
 * settlement_step_up_grants row bound to this EXACT act id (the resource
 * hash), so a grant minted for one act can never accept another. The DB
 * guard additionally requires the act's own partner_identity_id to equal
 * the acceptance row's - partner A can never accept partner B's act, even
 * with a superficially valid grant of their own.
 */
export const acceptSettlementAct = (
  db: Database.Database,
  partner: PartnerPrincipal,
  actId: string,
  stepUpGrantId: string,
): { acceptance: ActAcceptanceRow; replayed: boolean } => {
  const run = db.transaction((): { acceptance: ActAcceptanceRow; replayed: boolean } => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ACT_ACCEPTANCE");
    const existing = actAcceptanceForAct(db, actId);
    if (existing) return { acceptance: existing, replayed: true };
    const act = settlementActById(db, actId);
    if (!act) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_FOUND", 404, actId);
    if (act.partner_identity_id !== partner.partner_identity_id) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_WRONG_PARTNER", 403, actId);
    if (!act.presented_at) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_PRESENTED", 409, actId);
    const settlement = agentReferralsSettlementById(db, act.settlement_id);
    if (!settlement) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_NOT_FOUND", 404, act.settlement_id);
    assertSettlementActionable(db, settlement);

    consumeSettlementStepUpGrantInTransaction(db, partner, stepUpGrantId, "ACT_ACCEPTANCE", { act_id: actId, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id });

    const acceptanceId = id();
    db.prepare(`INSERT INTO settlement_act_acceptances(id, act_id, partner_identity_id, step_up_grant_id, accepted_amount_kopecks, accepted_engagement_revision_id)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(acceptanceId, actId, partner.partner_identity_id, stepUpGrantId, act.amount_kopecks, act.engagement_revision_id);
    return { acceptance: actAcceptanceForAct(db, actId)!, replayed: false };
  });
  return run.immediate();
};

export type ActDisputeRow = { id: string; act_id: string; partner_identity_id: string; reason: string; detail: string | null; created_at: string };
export type DocumentDisputeReason = "AMOUNT_INCORRECT" | "PARTNER_DETAILS_INCORRECT" | "SERVICE_NOT_RENDERED" | "OTHER";

export const actDisputeForAct = (db: Database.Database, actId: string): ActDisputeRow | null =>
  (db.prepare("SELECT id, act_id, partner_identity_id, reason, detail, created_at FROM settlement_act_disputes WHERE act_id = ?")
    .get(actId) as ActDisputeRow | undefined) ?? null;

/** Partner-only (no step-up: an objection, not a material commitment). Blocks payment authorization structurally - see payment_authorizations' own guard. */
export const disputeSettlementAct = (
  db: Database.Database,
  partner: PartnerPrincipal,
  actId: string,
  reason: DocumentDisputeReason,
  detail?: string,
): { dispute: ActDisputeRow; replayed: boolean } => {
  const run = db.transaction((): { dispute: ActDisputeRow; replayed: boolean } => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "ACT_DISPUTE");
    const existing = actDisputeForAct(db, actId);
    if (existing) return { dispute: existing, replayed: true };
    const act = settlementActById(db, actId);
    if (!act) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_FOUND", 404, actId);
    if (act.partner_identity_id !== partner.partner_identity_id) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_WRONG_PARTNER", 403, actId);
    if (!act.presented_at) throw new SettlementActError("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_PRESENTED", 409, actId);

    const disputeId = id();
    db.prepare("INSERT INTO settlement_act_disputes(id, act_id, partner_identity_id, reason, detail) VALUES (?, ?, ?, ?, ?)")
      .run(disputeId, actId, partner.partner_identity_id, reason, detail ?? null);
    return { dispute: actDisputeForAct(db, actId)!, replayed: false };
  });
  return run.immediate();
};
