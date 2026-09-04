import type Database from "better-sqlite3";
import { distributionProjection } from "./agent-referrals-distribution";
import { isOrdReportingTailComplete, OrdReportingError } from "./agent-referrals-ord-reporting";
import { currentUsableNpdCheck } from "./agent-referrals-npd";

/**
 * Phase 9 amendment round-2 fix (finding #4): the operator review surface
 * the original Phase 9 plan calls "reporting-tail queues, missing-evidence
 * sweeps, NPD reconciliation, operator review reminders". Every item here is
 * a LIVE derived read, never a second stored queue table that could drift
 * from the evidence it summarizes - the same "current is always derived"
 * convention this codebase already applies to every other projection
 * (distributionProjection, currentEffectiveRewardSnapshot, ...). The worker
 * (agent-referrals-worker-sweep.ts) calls this same function every cycle
 * and logs the totals, so the reminder is genuinely produced on a
 * deadline-driven cadence even though nothing is written to disk; the admin
 * UI (`/agent-referrals` review queue tab) calls it again on every load for
 * the interactive, item-level view. Both read the identical live facts, so
 * they can never disagree.
 *
 * No VK network call of any kind. No new commercial/provider authority -
 * every field here is read-only.
 */

const MAX_ITEMS_PER_CATEGORY = 50;

export type AgentReferralsReviewQueue = {
  distributions_review_required: string[];
  distributions_removal_overdue: string[];
  distributions_reporting_tail_incomplete: string[];
  acts_awaiting_presentation: string[];
  payment_attempts_payout_unknown: string[];
  npd_reconciliation_needed: string[];
  partners_profile_pending_verification: string[];
  partners_framework_not_issued: string[];
};

export type AgentReferralsReviewQueueCounts = { [K in keyof AgentReferralsReviewQueue]: number };

const allDistributionIds = (db: Database.Database): string[] =>
  (db.prepare("SELECT id, engagement_id FROM engagement_distributions").all() as { id: string; engagement_id: string }[]).map((row) => row.id);

/** Every distribution whose CURRENT revision's compliance state is REVIEW_REQUIRED (a channel-policy violation or an authority-interval violation at the moment it was reported/corrected). */
const distributionsReviewRequired = (db: Database.Database): string[] =>
  allDistributionIds(db).filter((id) => distributionProjection(db, id).compliance_state === "REVIEW_REQUIRED").slice(0, MAX_ITEMS_PER_CATEGORY);

/** Every distribution whose removal state has reached OVERDUE_REMOVAL or REMOVAL_UNVERIFIED - the worker's own sweep already produces OVERDUE_REMOVAL; REMOVAL_UNVERIFIED is an explicit admin classification (markRemovalUnverified). */
const distributionsRemovalOverdue = (db: Database.Database): string[] =>
  allDistributionIds(db).filter((id) => {
    const state = distributionProjection(db, id).removal_state;
    return state === "OVERDUE_REMOVAL" || state === "REMOVAL_UNVERIFIED";
  }).slice(0, MAX_ITEMS_PER_CATEGORY);

/**
 * Every distribution whose reporting tail is not yet complete as of `atIso`
 * - reuses isOrdReportingTailComplete exactly (never a second, divergent
 * completeness calculation). A distribution published with NO resolvable
 * creative authority at all (AGENT_REFERRALS_ORD_REPORTING_FORMAT_UNRESOLVED
 * - the NO_AUTHORITY case in agent-referrals-distribution.ts's own
 * resolveHistoricalCreativeAuthority) has no format to derive a reporting
 * basis from in the first place; it is excluded from THIS category, not
 * silently treated as complete - that fact is already surfaced under
 * distributions_review_required, whose compliance_state classification
 * covers exactly this case.
 */
const distributionsReportingTailIncomplete = (db: Database.Database, atIso: string): string[] =>
  allDistributionIds(db).filter((id) => {
    try { return !isOrdReportingTailComplete(db, id, atIso); }
    catch (error) { if (error instanceof OrdReportingError) return false; throw error; }
  }).slice(0, MAX_ITEMS_PER_CATEGORY);

/** Acts generated (ACT_PREPARED) but not yet presented to the partner - nothing else can proceed (acceptance, payment) until this happens. */
const actsAwaitingPresentation = (db: Database.Database): string[] =>
  (db.prepare("SELECT id FROM settlement_acts WHERE presented_at IS NULL LIMIT ?").all(MAX_ITEMS_PER_CATEGORY) as { id: string }[]).map((row) => row.id);

/** Payment attempts left PAYOUT_UNKNOWN - never auto-retried; resolved only by durable provider evidence (recordPaymentMade or recordConfirmedNotMade). */
const paymentAttemptsPayoutUnknown = (db: Database.Database): string[] =>
  (db.prepare("SELECT id FROM payment_attempts WHERE status = 'PAYOUT_UNKNOWN' LIMIT ?").all(MAX_ITEMS_PER_CATEGORY) as { id: string }[]).map((row) => row.id);

/**
 * Settlements under NPD whose act is accepted and undisputed - genuinely
 * payable - but with no fresh, usable NPD status check on file right now,
 * so beginPayment() would refuse. Surfaced so an operator can run a fresh
 * FNS check (recordNpdStatusCheck) before the partner notices a stalled
 * payout.
 */
const npdReconciliationNeeded = (db: Database.Database): string[] => {
  const candidates = db.prepare(`
    SELECT rs.id AS settlement_id, rs.partner_identity_id AS partner_identity_id
    FROM reward_settlements rs
    JOIN settlement_acts act ON act.settlement_id = rs.id
    JOIN settlement_act_acceptances acc ON acc.act_id = act.id
    LEFT JOIN settlement_act_disputes dis ON dis.act_id = act.id
    WHERE rs.settlement_flow = 'AGENT_REFERRALS' AND rs.status = 'PREPARED' AND rs.tax_mode_snapshot = 'NPD'
      AND act.presented_at IS NOT NULL AND dis.id IS NULL
    LIMIT ?
  `).all(MAX_ITEMS_PER_CATEGORY * 4) as { settlement_id: string; partner_identity_id: string }[];
  return candidates.filter((row) => !currentUsableNpdCheck(db, row.partner_identity_id)).map((row) => row.settlement_id).slice(0, MAX_ITEMS_PER_CATEGORY);
};

const partnersProfilePendingVerification = (db: Database.Database): string[] =>
  (db.prepare("SELECT id FROM partner_identities WHERE onboarding_state = 'PROFILE_SUBMITTED' AND destroyed_at IS NULL LIMIT ?").all(MAX_ITEMS_PER_CATEGORY) as { id: string }[]).map((row) => row.id);

const partnersFrameworkNotIssued = (db: Database.Database): string[] =>
  (db.prepare("SELECT id FROM partner_identities WHERE onboarding_state = 'PROFILE_VERIFIED' AND destroyed_at IS NULL LIMIT ?").all(MAX_ITEMS_PER_CATEGORY) as { id: string }[]).map((row) => row.id);

export const agentReferralsReviewQueue = (db: Database.Database, atIso: string): AgentReferralsReviewQueue => ({
  distributions_review_required: distributionsReviewRequired(db),
  distributions_removal_overdue: distributionsRemovalOverdue(db),
  distributions_reporting_tail_incomplete: distributionsReportingTailIncomplete(db, atIso),
  acts_awaiting_presentation: actsAwaitingPresentation(db),
  payment_attempts_payout_unknown: paymentAttemptsPayoutUnknown(db),
  npd_reconciliation_needed: npdReconciliationNeeded(db),
  partners_profile_pending_verification: partnersProfilePendingVerification(db),
  partners_framework_not_issued: partnersFrameworkNotIssued(db),
});

export const agentReferralsReviewQueueCounts = (queue: AgentReferralsReviewQueue): AgentReferralsReviewQueueCounts =>
  Object.fromEntries(Object.entries(queue).map(([key, value]) => [key, value.length])) as AgentReferralsReviewQueueCounts;
