import type Database from "better-sqlite3";
import type { ReleaseCandidate } from "../release/candidate";
import type { CertificationRun } from "./run";
import { SqliteCertificationRunStore } from "./store-sqlite";
import { currentBindingIn } from "../release/forward-target";

/**
 * A second certification for a deploy session, when - and only when - the
 * first one provably did nothing.
 *
 * One run per session is the rule, and the reason is money: a fresh run per
 * invocation would make every restart a new certification, and a restart after
 * a payment must continue that payment, not begin another. So a failed run is
 * reconciled, never replaced.
 *
 * Attempt 5 (2026-09-23) found the case the rule did not anticipate. `certify`
 * armed the release and its very first command, CREATE_OCCURRENCE, was refused
 * by the runtime. The run recorded an immutable failure and shut a catalogue it
 * had never opened. After arming there is no rollback, and a failed run can
 * never pass - so a release whose certification had touched nothing at all had
 * no way to finish.
 *
 * The retry replaces the rule's reason, not the rule. It exists only where
 * everything the first run could have done is durably provable as not done:
 * the catalogue mutation and its ledger row commit in one transaction, so no
 * ledger row means no occurrence; an order for a certification run cannot
 * exist without that run's ledger row (`certification_order_matches_occurrence_run`);
 * and a capability that was never spent admitted no checkout. It is bounded to
 * exactly one retry, `-a2`, and it is not a counter.
 */

export const certificationRunId = (deploymentSessionId: string): string => `certification-${deploymentSessionId}`;

export const retryRunId = (deploymentSessionId: string): string => `${certificationRunId(deploymentSessionId)}-a2`;

/**
 * The certification run for a forward revision of a session.
 *
 * Revision 0 - the session's own target - keeps the original id, so existing
 * runs keep their meaning. A release the session was carried forward to gets
 * its own run: nothing certified for one target counts for another.
 */
export const revisionRunId = (deploymentSessionId: string, revision: number): string =>
  revision === 0 ? certificationRunId(deploymentSessionId) : `${certificationRunId(deploymentSessionId)}-r${revision}`;

/**
 * The run the session is certifying with now: the current forward revision's,
 * or at revision 0 its no-effect retry once one exists, otherwise its first.
 */
export const effectiveCertificationRunId = (db: Database.Database, deploymentSessionId: string): string => {
  const revision = currentBindingIn(db, deploymentSessionId)?.revision ?? 0;
  if (revision > 0) return revisionRunId(deploymentSessionId, revision);
  return new SqliteCertificationRunStore(db).load(retryRunId(deploymentSessionId))
    ? retryRunId(deploymentSessionId)
    : certificationRunId(deploymentSessionId);
};

type SessionRow = {
  state: string; rollback_authority: string; deployment_gate_closed: number;
  target_sha: string; candidate_id: string | null;
};

const EVIDENCE: readonly (keyof CertificationRun)[] = [
  "occurrenceId", "quoteId", "statusId", "orderId", "paymentId", "bookingId", "ticketId",
  "refundObligationId", "refundId", "humanTicketVerifiedAt", "completedAt",
];

/**
 * Why `run` does not qualify for a no-effect retry, or undefined if it does.
 *
 * Every condition is a durable fact read inside the caller's transaction. The
 * session half says the release is exactly where attempt 5 left it: armed,
 * fenced, in recovery, for this candidate. The run half says the run failed
 * before its first effect. The ledger, order and capability halves say nothing
 * reached the runtime's side under this run's name.
 *
 * A superseded CREATE_OCCURRENCE is expected, not a defect: cleanup keeps the
 * armed intent as a forensic record precisely when it retires it, and the empty
 * ledger is what proves it never landed.
 */
export const noEffectDefect = (
  db: Database.Database,
  deploymentSessionId: string,
  run: CertificationRun,
  candidate: ReleaseCandidate,
): string | undefined => {
  const session = db.prepare(`SELECT state, rollback_authority, deployment_gate_closed, target_sha, candidate_id
    FROM deploy_sessions WHERE id = ?`).get(deploymentSessionId) as SessionRow | undefined;
  if (!session) return "SESSION_NOT_FOUND";
  if (session.state !== "RECOVERY_REQUIRED") return `SESSION_STATE_${session.state}`;
  if (session.rollback_authority !== "NEW_LINEAGE_ONLY") return `SESSION_AUTHORITY_${session.rollback_authority}`;
  if (session.deployment_gate_closed !== 1) return "SESSION_GATE_OPEN";
  if (session.target_sha !== candidate.sha || session.candidate_id !== candidate.id) return "SESSION_CANDIDATE_MISMATCH";

  if (run.releaseSha !== candidate.sha) return "RUN_RELEASE_MISMATCH";
  if (!run.failure) return "RUN_NOT_FAILED";
  if (run.phase !== "NEW") return `RUN_PHASE_${run.phase}`;
  if (run.direction !== "CATALOGUE_CLEAN") return `RUN_DIRECTION_${run.direction}`;
  if (run.pendingCommand) return "RUN_COMMAND_PENDING";
  if (run.supersededCommand && run.supersededCommand.command.kind !== "CREATE_OCCURRENCE") {
    return `RUN_SUPERSEDED_${run.supersededCommand.command.kind}`;
  }
  const evidence = EVIDENCE.find((field) => run[field] !== null && run[field] !== undefined);
  if (evidence) return `RUN_EVIDENCE_${String(evidence)}`;

  const ledger = db.prepare("SELECT COUNT(*) AS n FROM certification_catalogue_mutations WHERE run_id = ?").get(run.runId) as { n: number };
  if (ledger.n !== 0) return "CATALOGUE_LEDGER_PRESENT";
  const orders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE certification_run_id = ?").get(run.runId) as { n: number };
  if (orders.n !== 0) return "CERTIFICATION_ORDER_PRESENT";
  const checkouts = db.prepare(`SELECT COUNT(*) AS n FROM checkout_idempotency ci JOIN orders o ON o.id = ci.order_id
    WHERE o.certification_run_id = ?`).get(run.runId) as { n: number };
  if (checkouts.n !== 0) return "CHECKOUT_IDEMPOTENCY_PRESENT";

  // Exactly the one capability the first run was issued: never spent, never
  // replaced. Any other shape means something already acted on this session.
  const capabilities = db.prepare(`SELECT run_id, release_sha, consumed_at, retired_at FROM certification_capabilities
    WHERE deployment_session_id = ?`).all(deploymentSessionId) as
    { run_id: string; release_sha: string; consumed_at: string | null; retired_at: string | null }[];
  if (capabilities.length !== 1) return `CAPABILITY_COUNT_${capabilities.length}`;
  const [capability] = capabilities;
  if (capability.run_id !== run.runId) return "CAPABILITY_RUN_MISMATCH";
  if (capability.release_sha !== candidate.sha) return "CAPABILITY_RELEASE_MISMATCH";
  if (capability.consumed_at) return "CAPABILITY_CONSUMED";
  if (capability.retired_at) return "CAPABILITY_REPLACED";
  return undefined;
};
