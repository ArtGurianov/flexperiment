import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { settlementActById } from "./agent-referrals-act";
import { agentReferralsSettlementById } from "./agent-referrals-settlement";
import { currentOrdProviderProfile } from "./agent-referrals-ord-provider-profile";
import { ordPaidInvoicePayloadOperationKey } from "./agent-referrals-ord-operation-key";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * VKPaidInvoicePayload (plan Phase 8): constructible only from an exact
 * ACT_ACCEPTED authority - every field copied from ALREADY-immutable pinned
 * sources (the act's own columns, its acceptance's own accepted_amount/
 * accepted_engagement_revision_id, the settlement's own frozen tax/legal/
 * contractor-type snapshot columns), never a live re-read of a mutable
 * "current" table. No caller-supplied amount is ever accepted - the amount
 * is derived entirely from the named act's own acceptance. No customer PII
 * field exists anywhere on this payload.
 */

export class OrdPaidInvoiceError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type OrdPaidInvoicePayloadRow = {
  id: string;
  act_id: string;
  settlement_id: string;
  engagement_id: string;
  partner_identity_id: string;
  accepted_amount_kopecks: number;
  accepted_engagement_revision_id: string;
  tax_mode_snapshot: "NPD" | "OTHER";
  legal_profile_revision_id_snapshot: string;
  contractor_type_snapshot: string;
  provider_contract_profile_id: string;
  operation_key: string;
  submission_state: "NOT_SUBMITTED" | "SUBMITTED" | "SUBMIT_FAILED";
  vk_operation_external_id: string | null;
  erir_code: string | null;
  lock_state: "MUTABLE" | "EXTERNALLY_LOCKED";
  canonical_hash: string;
  created_by_admin_id: string;
  created_at: string;
};

const COLUMNS = `id, act_id, settlement_id, engagement_id, partner_identity_id, accepted_amount_kopecks, accepted_engagement_revision_id, tax_mode_snapshot,
  legal_profile_revision_id_snapshot, contractor_type_snapshot, provider_contract_profile_id, operation_key, submission_state, vk_operation_external_id, erir_code, lock_state, canonical_hash, created_by_admin_id, created_at`;

export const ordPaidInvoicePayloadById = (db: Database.Database, payloadId: string): OrdPaidInvoicePayloadRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_paid_invoice_payloads WHERE id = ?`).get(payloadId) as OrdPaidInvoicePayloadRow | undefined) ?? null;

/** At most one, ever, by the migration's own UNIQUE(act_id). */
export const ordPaidInvoicePayloadForAct = (db: Database.Database, actId: string): OrdPaidInvoicePayloadRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_paid_invoice_payloads WHERE act_id = ?`).get(actId) as OrdPaidInvoicePayloadRow | undefined) ?? null;

const gate = (db: Database.Database) => assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "VK_ERIR_REPORTING");

export type MintPaidInvoicePayloadResult = { payload: OrdPaidInvoicePayloadRow; replayed: boolean };

/**
 * Idempotent by act_id - a second call for the same act returns the
 * already-minted, byte-identical payload, never a second divergent one.
 * Refuses if the named act has no genuine acceptance yet
 * (AGENT_REFERRALS_ORD_PAID_INVOICE_ACT_NOT_ACCEPTED) - a payload can only
 * ever describe money the partner actually accepted.
 */
export const mintOrdPaidInvoicePayload = (
  db: Database.Database,
  admin: AdminPrincipal,
  actId: string,
  providerContractProfileId?: string,
): MintPaidInvoicePayloadResult => {
  const run = db.transaction((): MintPaidInvoicePayloadResult => {
    gate(db);
    const existing = ordPaidInvoicePayloadForAct(db, actId);
    if (existing) return { payload: existing, replayed: true };

    const act = settlementActById(db, actId);
    if (!act) throw new OrdPaidInvoiceError("AGENT_REFERRALS_SETTLEMENT_ACT_NOT_FOUND", 404, actId);
    const acceptance = db.prepare("SELECT accepted_amount_kopecks, accepted_engagement_revision_id FROM settlement_act_acceptances WHERE act_id = ?")
      .get(actId) as { accepted_amount_kopecks: number; accepted_engagement_revision_id: string } | undefined;
    if (!acceptance) throw new OrdPaidInvoiceError("AGENT_REFERRALS_ORD_PAID_INVOICE_ACT_NOT_ACCEPTED", 409, actId);

    const settlement = agentReferralsSettlementById(db, act.settlement_id)!;
    // contractor_type_snapshot predates PR7's own exported settlement type
    // (it is a pre-existing reward_settlements column PR7 pins but does not
    // itself select) - read directly rather than widening PR7's frozen
    // AgentReferralsSettlementRow shape for one extra field.
    const contractorType = (db.prepare("SELECT contractor_type_snapshot FROM reward_settlements WHERE id = ?").get(settlement.id) as { contractor_type_snapshot: string }).contractor_type_snapshot;
    const contract = providerContractProfileId ? { id: providerContractProfileId } : currentOrdProviderProfile(db, "CONTRACT");
    if (!contract) throw new OrdPaidInvoiceError("AGENT_REFERRALS_ORD_PROVIDER_CONTRACT_PROFILE_MISSING", 409);

    const operationKey = ordPaidInvoicePayloadOperationKey({
      act_id: actId, settlement_id: settlement.id, accepted_amount_kopecks: acceptance.accepted_amount_kopecks, accepted_engagement_revision_id: acceptance.accepted_engagement_revision_id,
    });
    const canonicalHash = sha256(canonicalV2({
      act_id: actId, settlement_id: settlement.id, engagement_id: act.engagement_id, partner_identity_id: act.partner_identity_id,
      accepted_amount_kopecks: acceptance.accepted_amount_kopecks, accepted_engagement_revision_id: acceptance.accepted_engagement_revision_id,
      tax_mode_snapshot: settlement.tax_mode_snapshot, legal_profile_revision_id_snapshot: settlement.legal_profile_revision_id_snapshot, contractor_type_snapshot: contractorType,
    } as Record<string, unknown>));

    const payloadId = id();
    db.prepare(`INSERT INTO ord_paid_invoice_payloads(id, act_id, settlement_id, engagement_id, partner_identity_id, accepted_amount_kopecks, accepted_engagement_revision_id,
        tax_mode_snapshot, legal_profile_revision_id_snapshot, contractor_type_snapshot, provider_contract_profile_id, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(payloadId, actId, settlement.id, act.engagement_id, act.partner_identity_id, acceptance.accepted_amount_kopecks, acceptance.accepted_engagement_revision_id,
        settlement.tax_mode_snapshot, settlement.legal_profile_revision_id_snapshot, contractorType, contract.id, operationKey, canonicalHash, admin.admin_id);
    return { payload: ordPaidInvoicePayloadById(db, payloadId)!, replayed: false };
  });
  return run.immediate();
};

/** Records manual VK submission + ERIR reconciliation and locks the payload - the terminal, never-again-mutable fact. */
export const recordOrdPaidInvoiceReconciliation = (db: Database.Database, payloadId: string, vkOperationExternalId: string, erirCode: string): OrdPaidInvoicePayloadRow => {
  const run = db.transaction((): OrdPaidInvoicePayloadRow => {
    gate(db);
    const payload = ordPaidInvoicePayloadById(db, payloadId);
    if (!payload) throw new OrdPaidInvoiceError("AGENT_REFERRALS_ORD_PAID_INVOICE_PAYLOAD_NOT_FOUND", 404, payloadId);
    if (payload.lock_state === "EXTERNALLY_LOCKED") throw new OrdPaidInvoiceError("AGENT_REFERRALS_ORD_PAID_INVOICE_PAYLOAD_LOCKED", 409, payloadId);
    const changed = db.prepare(`UPDATE ord_paid_invoice_payloads SET submission_state = 'SUBMITTED', vk_operation_external_id = ?, erir_code = ?, lock_state = 'EXTERNALLY_LOCKED'
      WHERE id = ? AND lock_state = 'MUTABLE'`).run(vkOperationExternalId, erirCode, payloadId);
    if (changed.changes !== 1) throw new OrdPaidInvoiceError("AGENT_REFERRALS_ORD_PAID_INVOICE_PAYLOAD_CONCURRENT_CONFLICT", 409, payloadId);
    return ordPaidInvoicePayloadById(db, payloadId)!;
  });
  return run.immediate();
};
