import type Database from "better-sqlite3";
import { lastActivatedEngagementRevision } from "./agent-referrals-engagement";
import { distributionsForEngagement, distributionProjection, requireRemoval, markOverdueRemoval, DistributionError } from "./agent-referrals-distribution";
import { recoverStuckPaymentAttempts } from "./agent-referrals-payment";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Worker deadline sweeps (Phase 9 amendment §11): deterministic, idempotent,
 * NO VK network call of any kind, and no new commercial/provider authority
 * of its own - every write here calls an existing, already-reviewed admin
 * command (agent-referrals-distribution.ts / agent-referrals-payment.ts)
 * exactly as an operator would, attributed to a fixed SYSTEM admin actor.
 * `AdminPrincipal` is a plain authorization-context value in this codebase
 * (never a session token), so constructing one for the worker's own
 * deterministic, evidence-bearing writes is the same pattern release
 * control's own internal callers already use - it grants no browser
 * session and cannot originate from an HTTP request.
 *
 * Every genuinely time-driven "is X done" question this sweep does NOT
 * cover (reporting-tail completeness, missing statistics, stale act/
 * payment review) is intentionally left as a live read the admin dashboard
 * computes on every load (isOrdReportingTailComplete, latestNpdStatusCheck,
 * distributionProjection, ...) rather than a second, sweep-written queue
 * table that could drift from the very evidence it summarizes - this
 * codebase's own "current is always derived, never a stored pointer"
 * convention, applied to worker output too.
 */

const SYSTEM_ADMIN: AdminPrincipal = { realm: "ADMIN", admin_id: "system-worker" };

/**
 * How long a distribution may sit in REMOVAL_REQUIRED/REMOVAL_CLAIMED
 * before the sweep escalates it to OVERDUE_REMOVAL. An operational policy
 * default this PR chooses, not a legally pinned figure - the plan (§B-5d)
 * requires that removal be tracked and overdue distributions surfaced, but
 * fixes no exact deadline. Deliberately generous (72h) so a partner who
 * responds within a normal business cycle is never wrongly escalated.
 */
export const REMOVAL_OVERDUE_GRACE_MS = 72 * 60 * 60_000;

/** How long a payment_attempts row may sit IN_PROGRESS before the sweep resolves it to PAYOUT_UNKNOWN - see recoverStuckPaymentAttempts's own fail-closed contract. Deliberately longer than the legacy 120s payment-creation threshold: this models a manual/operator payout, not an automated capture. */
export const PAYMENT_ATTEMPT_STALE_MS = 30 * 60_000;

export type AgentReferralsWorkerSweepResult = {
  removal_required_marked: number;
  removal_overdue_marked: number;
  payment_attempts_recovered: number;
};

const engagementIdsWithEndedPublication = (db: Database.Database): string[] =>
  (db.prepare(`SELECT DISTINCT e.id FROM engagements e
    WHERE e.lifecycle_state IN ('ACTIVE', 'SUSPENDED', 'CLOSED')`).all() as { id: string }[])
    .map((row) => row.id);

/** Every distribution belonging to an engagement whose ACTIVE (last-activated) revision's publication window has ended, and which has no removal event yet at all, gets REMOVAL_REQUIRED. */
const sweepRemovalRequired = (db: Database.Database): number => {
  let marked = 0;
  for (const engagementId of engagementIdsWithEndedPublication(db)) {
    const revision = lastActivatedEngagementRevision(db, engagementId);
    if (!revision || new Date(revision.publication_end_at).getTime() > Date.now()) continue;
    for (const distribution of distributionsForEngagement(db, engagementId)) {
      const projection = distributionProjection(db, distribution.id);
      if (projection.removal_state !== null) continue;
      try {
        requireRemoval(db, SYSTEM_ADMIN, distribution.id, "AGENT_REFERRALS_WORKER_PUBLICATION_WINDOW_ENDED");
        marked += 1;
      } catch (error) {
        // A concurrent admin/partner action may have already advanced this
        // distribution's removal lifecycle since the projection read above -
        // never fatal to the sweep, exactly like the legacy worker's own
        // per-item try/catch around individually-racing rows.
        if (!(error instanceof DistributionError)) throw error;
      }
    }
  }
  return marked;
};

/** Every distribution still REMOVAL_REQUIRED/REMOVAL_CLAIMED past the grace window gets OVERDUE_REMOVAL, so it surfaces on the admin review queue. */
const sweepRemovalOverdue = (db: Database.Database, atMs: number): number => {
  let marked = 0;
  const candidates = db.prepare(`SELECT DISTINCT distribution_id FROM engagement_distribution_events WHERE event_kind IN ('REMOVAL_REQUIRED', 'REMOVAL_CLAIMED')`).all() as { distribution_id: string }[];
  for (const { distribution_id: distributionId } of candidates) {
    const projection = distributionProjection(db, distributionId);
    if (projection.removal_state !== "REMOVAL_REQUIRED" && projection.removal_state !== "REMOVAL_CLAIMED") continue;
    const lastEvent = db.prepare(`SELECT occurred_at FROM engagement_distribution_events WHERE distribution_id = ? AND event_kind = ? ORDER BY event_sequence DESC LIMIT 1`)
      .get(distributionId, projection.removal_state) as { occurred_at: string } | undefined;
    if (!lastEvent) continue;
    const ageMs = atMs - new Date(lastEvent.occurred_at).getTime();
    if (ageMs < REMOVAL_OVERDUE_GRACE_MS) continue;
    try {
      markOverdueRemoval(db, SYSTEM_ADMIN, distributionId, "AGENT_REFERRALS_WORKER_REMOVAL_GRACE_PERIOD_ELAPSED");
      marked += 1;
    } catch (error) {
      if (!(error instanceof DistributionError)) throw error;
    }
  }
  return marked;
};

/**
 * DORMANT short-circuits to an all-zero no-op before touching any of the
 * three gated commands below - `dormant-ready` requires zero Agent
 * Referrals business records to exist at all, so there is provably nothing
 * for any of them to find, and each one's own suspension-policy gate would
 * otherwise throw AGENT_REFERRALS_FEATURE_DORMANT on every single tick
 * (MATURATION_RECOVERY_REPORTING_TAIL classes are permitted under ACTIVE
 * and SUSPENDED, refused only under DORMANT). Checked once here rather than
 * relying on each command's own internal gate to no-op, so a DORMANT
 * deployment's worker log stays silent instead of one exception per cycle.
 */
export const runAgentReferralsWorkerSweep = (db: Database.Database, atMs = Date.now()): AgentReferralsWorkerSweepResult => {
  if (agentReferralsFeatureState(db).state === "DORMANT") {
    return { removal_required_marked: 0, removal_overdue_marked: 0, payment_attempts_recovered: 0 };
  }
  return {
    removal_required_marked: sweepRemovalRequired(db),
    removal_overdue_marked: sweepRemovalOverdue(db, atMs),
    payment_attempts_recovered: recoverStuckPaymentAttempts(db, PAYMENT_ATTEMPT_STALE_MS, atMs),
  };
};
