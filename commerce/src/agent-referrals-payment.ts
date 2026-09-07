import type Database from "better-sqlite3";
import { id, now } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { agentReferralsSettlementById } from "./agent-referrals-settlement";
import { settlementActForSettlement, actAcceptanceForAct, actDisputeForAct } from "./agent-referrals-act";
import { currentUsableNpdCheck } from "./agent-referrals-npd";
import { currentEffectiveRewardSnapshot } from "./agent-referrals-reward-registry";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * §B-6/Phase 7 payment authority.
 *
 * PaymentAuthorization is a capability, not a status field: beginPayment()
 * re-resolves and rechecks every load-bearing prerequisite in the SAME
 * transaction that irreversibly mints the authorization AND creates its one
 * attempt - nothing here trusts a fact established at settlement/act time
 * to still hold. The migration's own relational-consistency guard on
 * payment_authorizations is the structural backstop; the checks in this
 * module exist only to fail with a clean code before ever reaching a raw
 * SQLite constraint error.
 *
 * Attempt settlement always precedes settlement projection ("settle the
 * attempt before projecting the settlement", per outbox-attempt-store.ts's
 * identical ordering rationale) - recordPaymentMade updates payment_attempts
 * first and reward_settlements second, in the same transaction, so a crash
 * between the two can never leave a settlement SETTLED with no MADE attempt
 * behind it; at worst the attempt is MADE while the settlement projection is
 * retried (idempotently) on the next call.
 */

export class PaymentError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type PaymentAuthorizationRow = {
  id: string;
  settlement_id: string;
  act_id: string;
  amount_kopecks: number;
  payout_profile_revision_id: string;
  npd_status_check_id: string | null;
  created_by_admin_id: string;
  created_at: string;
};

export type PaymentAttemptStatus = "IN_PROGRESS" | "MADE" | "PAYOUT_UNKNOWN" | "CONFIRMED_NOT_MADE";

export type PaymentAttemptRow = {
  id: string;
  payment_authorization_id: string;
  settlement_id: string;
  status: PaymentAttemptStatus;
  amount_kopecks: number;
  started_at: string;
  made_at: string | null;
  payout_unknown_at: string | null;
  confirmed_not_made_at: string | null;
  evidence_ref: string | null;
  created_at: string;
};

const AUTH_COLUMNS = "id, settlement_id, act_id, amount_kopecks, payout_profile_revision_id, npd_status_check_id, created_by_admin_id, created_at";
const ATTEMPT_COLUMNS = "id, payment_authorization_id, settlement_id, status, amount_kopecks, started_at, made_at, payout_unknown_at, confirmed_not_made_at, evidence_ref, created_at";

export const paymentAuthorizationById = (db: Database.Database, authorizationId: string): PaymentAuthorizationRow | null =>
  (db.prepare(`SELECT ${AUTH_COLUMNS} FROM payment_authorizations WHERE id = ?`).get(authorizationId) as PaymentAuthorizationRow | undefined) ?? null;

export const paymentAttemptById = (db: Database.Database, attemptId: string): PaymentAttemptRow | null =>
  (db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE id = ?`).get(attemptId) as PaymentAttemptRow | undefined) ?? null;

/** The one attempt currently occupying the "active" slot for a settlement (not CONFIRMED_NOT_MADE) - at most one, by the migration's partial UNIQUE index. */
export const activePaymentAttempt = (db: Database.Database, settlementId: string): PaymentAttemptRow | null =>
  (db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE settlement_id = ? AND status != 'CONFIRMED_NOT_MADE'`)
    .get(settlementId) as PaymentAttemptRow | undefined) ?? null;

export const paymentAttemptsForSettlement = (db: Database.Database, settlementId: string): PaymentAttemptRow[] =>
  db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM payment_attempts WHERE settlement_id = ? ORDER BY started_at ASC, id ASC`).all(settlementId) as PaymentAttemptRow[];

export type BeginPaymentResult = { authorization: PaymentAuthorizationRow; attempt: PaymentAttemptRow };

/**
 * BEGIN_PAYMENT: re-resolves and rechecks in one transaction -
 *   settlement PREPARED, not superseded by a later one
 *   exact act presented + accepted + undisputed
 *   payout profile still the current usable revision
 *   for NPD: a fresh ACTIVE npd_status_check on file right now
 *   for OTHER: no fabricated NPD authority required
 * - then irreversibly mints the authorization and its one attempt
 * together. A second concurrent BEGIN_PAYMENT for the same settlement
 * collides on payment_attempts_active_unique and is refused, never
 * silently ignored.
 */
export const beginPayment = (db: Database.Database, admin: AdminPrincipal, settlementId: string): BeginPaymentResult => {
  const run = db.transaction((): BeginPaymentResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "PAYMENT_AUTHORIZATION");
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "PAYMENT_EXECUTION");

    const settlement = agentReferralsSettlementById(db, settlementId);
    if (!settlement) throw new PaymentError("AGENT_REFERRALS_SETTLEMENT_NOT_FOUND", 404, settlementId);
    if (settlement.status !== "PREPARED") throw new PaymentError("AGENT_REFERRALS_PAYMENT_SETTLEMENT_NOT_PAYABLE", 409, settlement.status);
    const superseded = db.prepare("SELECT 1 FROM reward_settlements WHERE supersedes_settlement_id = ?").get(settlementId);
    if (superseded) throw new PaymentError("AGENT_REFERRALS_PAYMENT_SETTLEMENT_SUPERSEDED", 409, settlementId);
    // Fresh recheck that this settlement's pinned E is STILL the
    // engagement's current one, right now - closes the seam where a
    // reward correction ran through PR6's bare primitive directly
    // (bypassing correctPartnerRewardWithSettlement, which would have
    // cancelled this settlement) and left it PREPARED-but-stale. The
    // migration's own payment_authorizations guard re-proves this
    // identically and is the real structural backstop; this is the clean
    // error code before ever reaching it.
    const currentE = currentEffectiveRewardSnapshot(db, settlement.engagement_id);
    if (!currentE || currentE.id !== settlement.effective_reward_snapshot_id) {
      throw new PaymentError("AGENT_REFERRALS_PAYMENT_SETTLEMENT_STALE_EFFECTIVE_SNAPSHOT", 409, settlementId);
    }

    const act = settlementActForSettlement(db, settlementId);
    if (!act || !act.presented_at) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ACT_NOT_PRESENTED", 409, settlementId);
    if (!actAcceptanceForAct(db, act.id)) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ACT_NOT_ACCEPTED", 409, act.id);
    if (actDisputeForAct(db, act.id)) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ACT_DISPUTED", 409, act.id);

    let npdStatusCheckId: string | null = null;
    if (settlement.tax_mode_snapshot === "NPD") {
      const check = currentUsableNpdCheck(db, settlement.partner_identity_id);
      if (!check) throw new PaymentError("AGENT_REFERRALS_PAYMENT_NPD_CHECK_UNAVAILABLE", 409, settlement.partner_identity_id);
      npdStatusCheckId = check.id;
    }

    const authorizationId = id();
    try {
      db.prepare(`INSERT INTO payment_authorizations(id, settlement_id, act_id, amount_kopecks, payout_profile_revision_id, npd_status_check_id, created_by_admin_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(authorizationId, settlementId, act.id, settlement.amount_kopecks, settlement.payout_profile_revision_id, npdStatusCheckId, admin.admin_id);

      const attemptId = id();
      db.prepare(`INSERT INTO payment_attempts(id, payment_authorization_id, settlement_id, status, amount_kopecks) VALUES (?, ?, ?, 'IN_PROGRESS', ?)`)
        .run(attemptId, authorizationId, settlementId, settlement.amount_kopecks);

      return { authorization: paymentAuthorizationById(db, authorizationId)!, attempt: paymentAttemptById(db, attemptId)! };
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: payment_attempts/.test(error.message)) {
        throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_ALREADY_ACTIVE", 409, settlementId);
      }
      throw error;
    }
  });
  return run.immediate();
};

const projectSettlementFromMadeAttempt = (db: Database.Database, settlementId: string): void => {
  const settlement = agentReferralsSettlementById(db, settlementId)!;
  if (settlement.tax_mode_snapshot === "OTHER") {
    db.prepare("UPDATE reward_settlements SET status = 'SETTLED', payment_made_at = ?, settled_at = ? WHERE id = ? AND status = 'PREPARED'").run(now(), now(), settlementId);
  } else {
    db.prepare("UPDATE reward_settlements SET status = 'PENDING_DOCUMENT', payment_made_at = ? WHERE id = ? AND status = 'PREPARED'").run(now(), settlementId);
  }
};

export type RecordAttemptOutcomeResult = { attempt: PaymentAttemptRow; replayed: boolean };

/**
 * Settle the attempt first, then project the settlement - never the
 * other order (see module header). Reachable from IN_PROGRESS (a
 * synchronous confirmation) OR from PAYOUT_UNKNOWN (later durable
 * reconciliation evidence proving the payout DID complete) - never
 * automatically, only via this explicit, evidence-bearing call. This is
 * the resolve-in-the-other-direction counterpart to recordConfirmedNotMade:
 * an unresolved payout must be resolvable by proof either way, never
 * permanently stuck merely because the first evidence to arrive was
 * ambiguous.
 */
export const recordPaymentMade = (db: Database.Database, admin: AdminPrincipal, attemptId: string, evidenceRef: string): RecordAttemptOutcomeResult => {
  void admin;
  const run = db.transaction((): RecordAttemptOutcomeResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "PAYMENT_EXECUTION");
    const before = paymentAttemptById(db, attemptId);
    if (!before) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_NOT_FOUND", 404, attemptId);
    if (before.status === "MADE") return { attempt: before, replayed: true };
    const changed = db.prepare("UPDATE payment_attempts SET status = 'MADE', made_at = ?, evidence_ref = ? WHERE id = ? AND status IN ('IN_PROGRESS', 'PAYOUT_UNKNOWN')").run(now(), evidenceRef, attemptId);
    if (!changed.changes) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_TRANSITION_ILLEGAL", 409, `${before.status}->MADE`);
    projectSettlementFromMadeAttempt(db, before.settlement_id);
    return { attempt: paymentAttemptById(db, attemptId)!, replayed: false };
  });
  return run.immediate();
};

/** IN_PROGRESS -> PAYOUT_UNKNOWN. No retry from here except via recordConfirmedNotMade once durable evidence exists. No settlement projection. */
export const recordPayoutUnknown = (db: Database.Database, admin: AdminPrincipal, attemptId: string, evidenceRef: string): RecordAttemptOutcomeResult => {
  void admin;
  const run = db.transaction((): RecordAttemptOutcomeResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "PAYMENT_EXECUTION");
    const before = paymentAttemptById(db, attemptId);
    if (!before) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_NOT_FOUND", 404, attemptId);
    if (before.status === "PAYOUT_UNKNOWN") return { attempt: before, replayed: true };
    const changed = db.prepare("UPDATE payment_attempts SET status = 'PAYOUT_UNKNOWN', payout_unknown_at = ?, evidence_ref = ? WHERE id = ? AND status = 'IN_PROGRESS'").run(now(), evidenceRef, attemptId);
    if (!changed.changes) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_TRANSITION_ILLEGAL", 409, `${before.status}->PAYOUT_UNKNOWN`);
    return { attempt: paymentAttemptById(db, attemptId)!, replayed: false };
  });
  return run.immediate();
};

/**
 * IN_PROGRESS or PAYOUT_UNKNOWN -> CONFIRMED_NOT_MADE. Only durable/
 * provider evidence that genuinely proves absence of payment belongs here
 * - never a timeout, never an automatic decision. Frees the
 * payment_attempts_active_unique slot for a fresh authorization/attempt on
 * the same settlement.
 */
export const recordConfirmedNotMade = (db: Database.Database, admin: AdminPrincipal, attemptId: string, evidenceRef: string): RecordAttemptOutcomeResult => {
  void admin;
  const run = db.transaction((): RecordAttemptOutcomeResult => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "PAYMENT_RECONCILIATION");
    const before = paymentAttemptById(db, attemptId);
    if (!before) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_NOT_FOUND", 404, attemptId);
    if (before.status === "CONFIRMED_NOT_MADE") return { attempt: before, replayed: true };
    const changed = db.prepare("UPDATE payment_attempts SET status = 'CONFIRMED_NOT_MADE', confirmed_not_made_at = ?, evidence_ref = ? WHERE id = ? AND status IN ('IN_PROGRESS', 'PAYOUT_UNKNOWN')")
      .run(now(), evidenceRef, attemptId);
    if (!changed.changes) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_TRANSITION_ILLEGAL", 409, `${before.status}->CONFIRMED_NOT_MADE`);
    return { attempt: paymentAttemptById(db, attemptId)!, replayed: false };
  });
  return run.immediate();
};

/**
 * Fail-closed crash recovery: any IN_PROGRESS attempt older than the
 * staleness threshold resolves to PAYOUT_UNKNOWN, never MADE and never
 * CONFIRMED_NOT_MADE - "a process that dies leaving IN_PROGRESS resolves
 * to PAYOUT_UNKNOWN on restart", mirroring
 * payments.state='CREATE_UNKNOWN''s read-only, never-re-POST recovery
 * exactly. This is the ONLY automatic transition in the whole attempt
 * lifecycle; every other edge requires an explicit evidence-bearing call.
 */
export const recoverStuckPaymentAttempts = (db: Database.Database, staleThresholdMs: number, atMs = Date.now()): number => {
  const run = db.transaction((): number => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "PAYMENT_RECONCILIATION");
    const threshold = new Date(atMs - staleThresholdMs).toISOString();
    // julianday(), never raw TEXT comparison: started_at is SQLite's own
    // "YYYY-MM-DD HH:MM:SS" (CURRENT_TIMESTAMP default), while threshold is
    // ISO 8601 "YYYY-MM-DDTHH:MM:SS.sssZ" - a space sorts before 'T', so a
    // plain string comparison reads a LATER started_at as "earlier" than an
    // EARLIER threshold and would sweep fresh attempts as stale.
    const stale = db.prepare("SELECT id FROM payment_attempts WHERE status = 'IN_PROGRESS' AND julianday(started_at) <= julianday(?)").all(threshold) as Array<{ id: string }>;
    for (const attempt of stale) {
      db.prepare("UPDATE payment_attempts SET status = 'PAYOUT_UNKNOWN', payout_unknown_at = ?, evidence_ref = 'CRASH_RECOVERY_TIMEOUT' WHERE id = ? AND status = 'IN_PROGRESS'").run(now(), attempt.id);
    }
    return stale.length;
  });
  return run.immediate();
};

export type NpdReceiptRow = { id: string; payment_attempt_id: string; settlement_id: string; receipt_reference: string; evidence_ref: string; created_by_admin_id: string; created_at: string };

export const npdReceiptForAttempt = (db: Database.Database, attemptId: string): NpdReceiptRow | null =>
  (db.prepare("SELECT id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id, created_at FROM npd_receipts WHERE payment_attempt_id = ?")
    .get(attemptId) as NpdReceiptRow | undefined) ?? null;

/**
 * MADE -> PENDING_DOCUMENT -> valid receipt -> SETTLED (NPD only). A
 * missing receipt never retries payment, never erases MADE, never turns
 * the payout back to UNKNOWN - it only unblocks this one document-
 * completion projection. Bound to the exact attempt id, so one
 * settlement/payment's receipt can never close another.
 */
export const recordNpdReceipt = (
  db: Database.Database,
  admin: AdminPrincipal,
  paymentAttemptId: string,
  receiptReference: string,
  evidenceRef: string,
): { receipt: NpdReceiptRow; replayed: boolean } => {
  const run = db.transaction((): { receipt: NpdReceiptRow; replayed: boolean } => {
    assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "NPD_RECEIPT_PROCESSING");
    const existing = npdReceiptForAttempt(db, paymentAttemptId);
    if (existing) return { receipt: existing, replayed: true };
    const attempt = paymentAttemptById(db, paymentAttemptId);
    if (!attempt) throw new PaymentError("AGENT_REFERRALS_PAYMENT_ATTEMPT_NOT_FOUND", 404, paymentAttemptId);
    if (attempt.status !== "MADE") throw new PaymentError("AGENT_REFERRALS_NPD_RECEIPT_ATTEMPT_NOT_MADE", 409, attempt.status);
    const settlement = agentReferralsSettlementById(db, attempt.settlement_id);
    if (!settlement || settlement.tax_mode_snapshot !== "NPD") throw new PaymentError("AGENT_REFERRALS_NPD_RECEIPT_NOT_NPD_FLOW", 409, attempt.settlement_id);

    const receiptId = id();
    db.prepare(`INSERT INTO npd_receipts(id, payment_attempt_id, settlement_id, receipt_reference, evidence_ref, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(receiptId, paymentAttemptId, attempt.settlement_id, receiptReference, evidenceRef, admin.admin_id);
    db.prepare(`UPDATE reward_settlements SET status = 'SETTLED', document_confirmed = 1, document_reference = ?, document_confirmed_at = ?, settled_at = ?
      WHERE id = ? AND status = 'PENDING_DOCUMENT' AND settlement_flow = 'AGENT_REFERRALS'`)
      .run(receiptReference, now(), now(), attempt.settlement_id);
    return { receipt: npdReceiptForAttempt(db, paymentAttemptId)!, replayed: false };
  });
  return run.immediate();
};
