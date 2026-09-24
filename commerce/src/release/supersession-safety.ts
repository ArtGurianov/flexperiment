import type Database from "better-sqlite3";

/**
 * Whether a session's certification of one release may be left behind.
 *
 * Carrying a session forward abandons its current target's certification. That
 * is only safe when nothing that certification did is still in motion. "Its run
 * failed and has nothing pending" is not that proof: a failed run can hold an
 * immutable failure and no pending command while a payment it made is still
 * resolving, or captured and not yet refunded. So the answer is read from the
 * state that matters, for every run the session certified this release with:
 *
 *   - there is at least one. A release whose certification was never even
 *     created - revision N deployed, then a failure before its capability was
 *     issued - is less eligible to abandon than one that never ran, not more.
 *     `forward-deploy` with that same candidate resumes it instead;
 *   - the run is terminal: it recorded a failure, or it is COMPLETE. A run that
 *     simply never ran is not a certification that can be abandoned - leaving
 *     it would supersede a release nobody tried to certify;
 *   - no command is pending;
 *   - every catalogue fixture it created is CLOSED and HIDDEN;
 *   - no payment is unresolved (CREATING, CREATE_UNKNOWN), and each ended
 *     CANCELLED, EXPIRED or REFUNDED;
 *   - no captured amount remains unrefunded;
 *   - no refund is in flight, and every refund obligation is FULFILLED.
 *
 * Returns why not, or undefined.
 */
export const supersessionDefect = (db: Database.Database, sessionId: string, releaseSha: string): string | undefined => {
  const runs = (db.prepare(`SELECT DISTINCT run_id FROM certification_capabilities
    WHERE deployment_session_id = ? AND release_sha = ? ORDER BY run_id`).all(sessionId, releaseSha) as { run_id: string }[])
    .map((row) => row.run_id);
  if (runs.length === 0) return `CERTIFICATION_NOT_STARTED:${releaseSha}`;

  for (const runId of runs) {
    const run = db.prepare("SELECT pending_command, failure_outcome, phase, completed_at FROM certification_runs WHERE run_id = ?").get(runId) as
      { pending_command: string | null; failure_outcome: string | null; phase: string; completed_at: string | null } | undefined;
    if (!run) return `RUN_MISSING:${runId}`;
    // Terminal first, then its effects: being terminal alone proves nothing
    // about money or fixtures, which are checked below either way.
    const terminal = run.failure_outcome !== null || (run.phase === "COMPLETE" && run.completed_at !== null);
    if (!terminal) return `RUN_NOT_TERMINAL:${runId}`;
    if (run.pending_command) return `COMMAND_PENDING:${runId}`;

    const fixtures = db.prepare(`SELECT DISTINCT m.occurrence_id, o.sales_status, o.visibility
      FROM certification_catalogue_mutations m LEFT JOIN occurrences o ON o.id = m.occurrence_id
      WHERE m.run_id = ?`).all(runId) as { occurrence_id: string; sales_status: string | null; visibility: string | null }[];
    for (const fixture of fixtures) {
      if (fixture.sales_status !== "CLOSED" || fixture.visibility !== "HIDDEN") return `FIXTURE_NOT_SHUT:${fixture.occurrence_id}`;
    }

    const payments = db.prepare(`SELECT p.id, p.state, p.status, COALESCE(p.captured_amount_kopecks, 0) AS captured
      FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.certification_run_id = ?`).all(runId) as
      { id: string; state: string; status: string; captured: number }[];
    for (const payment of payments) {
      if (payment.state === "CREATING" || payment.state === "CREATE_UNKNOWN") return `PAYMENT_UNRESOLVED:${payment.id}`;
      if (!["CANCELLED", "EXPIRED", "REFUNDED"].includes(payment.status)) return `PAYMENT_NOT_TERMINAL:${payment.id}:${payment.status}`;
      const inFlight = db.prepare(`SELECT COUNT(*) AS n FROM refunds WHERE payment_id = ? AND status NOT IN ('SUCCEEDED', 'FAILED')`).get(payment.id) as { n: number };
      if (inFlight.n) return `REFUND_IN_FLIGHT:${payment.id}`;
      const refunded = db.prepare("SELECT COALESCE(SUM(amount_kopecks), 0) AS n FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'").get(payment.id) as { n: number };
      if (refunded.n !== payment.captured) return `CAPTURE_NOT_REFUNDED:${payment.id}`;
      const open = db.prepare("SELECT COUNT(*) AS n FROM refund_obligations WHERE payment_id = ? AND status <> 'FULFILLED'").get(payment.id) as { n: number };
      if (open.n) return `REFUND_OBLIGATION_OPEN:${payment.id}`;
    }
  }
  return undefined;
};

/**
 * The session holds a capability nobody spent that has not expired. It
 * occupies the one live slot, so the next revision could not be given its own
 * capability - and finding that out at the last step would be after production
 * had already moved. Refused before anything changes instead.
 */
export const liveCapabilityBlocking = (db: Database.Database, sessionId: string, now: Date): string | undefined => {
  const live = db.prepare(`SELECT id, expires_at FROM certification_capabilities
    WHERE deployment_session_id = ? AND consumed_at IS NULL AND retired_at IS NULL`).get(sessionId) as { id: string; expires_at: string } | undefined;
  if (live && Date.parse(live.expires_at) > now.getTime()) return `${live.id} expires ${live.expires_at}`;
  return undefined;
};
