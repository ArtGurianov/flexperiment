import type Database from "better-sqlite3";
import {
  CertificationCapabilityError,
  type CertificationCapability, type CertificationCapabilityStore,
} from "./capability";
import {
  CertificationRunError, directionAtLeast, phaseAtLeast,
  type BusinessCommand, type CertificationFailure, type CertificationPhase, type CertificationRun,
  type CertificationRunMutation, type CertificationRunStore, type CleanupDirection, type SupersededCommand,
} from "./run";

/**
 * The durable half of the certification authority.
 *
 * The schema already refuses a backwards phase, a rewritten failure, a replaced
 * armed command and an edited evidence identifier. What lives here is the
 * compare-and-set: one guarded UPDATE per mutation, whose `changes === 1` is
 * the proof that this caller advanced the revision it had read. Two runners can
 * both pass a read; only one can win the write.
 */

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const json = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

type RunRow = Record<string, unknown>;

const toRun = (row: RunRow): CertificationRun => ({
  runId: String(row.run_id),
  revision: Number(row.revision),
  releaseSha: String(row.release_sha),
  phase: String(row.phase) as CertificationPhase,
  direction: String(row.direction) as CleanupDirection,
  startedAt: String(row.started_at),
  pendingCommand: json<BusinessCommand>(text(row.pending_command)),
  supersededCommand: json<SupersededCommand>(text(row.superseded_command)),
  failure: row.failure_outcome === null || row.failure_outcome === undefined
    ? null
    : { outcome: String(row.failure_outcome) as CertificationFailure["outcome"], code: String(row.failure_code), recordedAt: String(row.failure_recorded_at) },
  occurrenceId: text(row.occurrence_id),
  quoteId: text(row.quote_id),
  statusId: text(row.status_id),
  orderId: text(row.order_id),
  paymentId: text(row.payment_id),
  bookingId: text(row.booking_id),
  ticketId: text(row.ticket_id),
  refundObligationId: text(row.refund_obligation_id),
  refundId: text(row.refund_id),
  humanTicketVerifiedAt: text(row.human_ticket_verified_at),
  completedAt: text(row.completed_at),
});

/** Every mutable field, and the column that holds it. */
const RUN_FIELDS: ReadonlyArray<readonly [keyof CertificationRunMutation, string]> = [
  ["phase", "phase"], ["direction", "direction"],
  ["occurrenceId", "occurrence_id"], ["quoteId", "quote_id"], ["statusId", "status_id"],
  ["orderId", "order_id"], ["paymentId", "payment_id"], ["bookingId", "booking_id"],
  ["ticketId", "ticket_id"], ["refundObligationId", "refund_obligation_id"], ["refundId", "refund_id"],
  ["humanTicketVerifiedAt", "human_ticket_verified_at"], ["completedAt", "completed_at"],
];

export class SqliteCertificationRunStore implements CertificationRunStore {
  constructor(private readonly db: Database.Database) {}

  create(run: CertificationRun): CertificationRun {
    if (this.load(run.runId)) throw new CertificationRunError("CERTIFICATION_RUN_ALREADY_EXISTS", run.runId);
    // A run may be created already carrying evidence - a resumed fixture, a
    // recovery handed the state it found - so every field is written, not just
    // the six that identify it.
    this.db.prepare(`INSERT INTO certification_runs(run_id, revision, release_sha, phase, direction, started_at,
        pending_command, superseded_command, failure_outcome, failure_code, failure_recorded_at,
        occurrence_id, quote_id, status_id, order_id, payment_id, booking_id, ticket_id,
        refund_obligation_id, refund_id, human_ticket_verified_at, completed_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.runId, run.releaseSha, run.phase, run.direction, run.startedAt,
      run.pendingCommand ? JSON.stringify(run.pendingCommand) : null,
      run.supersededCommand ? JSON.stringify(run.supersededCommand) : null,
      run.failure?.outcome ?? null, run.failure?.code ?? null, run.failure?.recordedAt ?? null,
      run.occurrenceId ?? null, run.quoteId ?? null, run.statusId ?? null, run.orderId ?? null,
      run.paymentId ?? null, run.bookingId ?? null, run.ticketId ?? null,
      run.refundObligationId ?? null, run.refundId ?? null,
      run.humanTicketVerifiedAt ?? null, run.completedAt ?? null,
    );
    return this.required(run.runId);
  }

  load(runId: string): CertificationRun | undefined {
    const row = this.db.prepare("SELECT * FROM certification_runs WHERE run_id = ?").get(runId) as RunRow | undefined;
    return row ? toRun(row) : undefined;
  }

  update(runId: string, expectedRevision: number, mutation: CertificationRunMutation): CertificationRun {
    const current = this.load(runId);
    if (!current) throw new CertificationRunError("CERTIFICATION_RUN_NOT_FOUND", runId);

    // The same refusals the in-memory authority gives, in the same words. The
    // triggers behind this enforce the identical rules and are the backstop
    // against a raw UPDATE - but a caller that went through the store should be
    // told which rule it broke, not that some transition was illegal.
    const next = { ...current, ...mutation };
    if (!phaseAtLeast(next.phase, current.phase)) throw new CertificationRunError("CERTIFICATION_RUN_PHASE_REGRESSED", next.phase);
    if (!directionAtLeast(next.direction, current.direction)) throw new CertificationRunError("CERTIFICATION_RUN_DIRECTION_REGRESSED", next.direction);
    if (next.releaseSha !== current.releaseSha) throw new CertificationRunError("CERTIFICATION_RUN_RELEASE_IMMUTABLE");
    // The first failure is the one the operator is told about; a later step
    // failing while it recovers must not rewrite why the run failed.
    if (current.failure && JSON.stringify(next.failure ?? null) !== JSON.stringify(current.failure)) {
      throw new CertificationRunError("CERTIFICATION_RUN_FAILURE_IMMUTABLE");
    }

    const assignments = ["revision = revision + 1"];
    const values: (string | number | null)[] = [];
    for (const [key, column] of RUN_FIELDS) {
      if (!(key in mutation)) continue;
      assignments.push(`${column} = ?`);
      values.push((mutation[key] ?? null) as string | null);
    }
    if ("pendingCommand" in mutation) {
      assignments.push("pending_command = ?");
      values.push(mutation.pendingCommand ? JSON.stringify(mutation.pendingCommand) : null);
    }
    if ("supersededCommand" in mutation) {
      assignments.push("superseded_command = ?");
      values.push(mutation.supersededCommand ? JSON.stringify(mutation.supersededCommand) : null);
    }
    if ("failure" in mutation) {
      assignments.push("failure_outcome = ?", "failure_code = ?", "failure_recorded_at = ?");
      values.push(mutation.failure?.outcome ?? null, mutation.failure?.code ?? null, mutation.failure?.recordedAt ?? null);
    }

    // The revision is in the WHERE clause, so the loser of a race is told
    // rather than overwritten - the read that preceded this call proves nothing.
    const changed = this.db.prepare(`UPDATE certification_runs SET ${assignments.join(", ")}
      WHERE run_id = ? AND revision = ?`).run(...values, runId, expectedRevision);
    if (changed.changes !== 1) throw new CertificationRunError("CERTIFICATION_RUN_REVISION_CONFLICT", `${current.revision}`);
    return this.required(runId);
  }

  private required(runId: string): CertificationRun {
    const run = this.load(runId);
    if (!run) throw new CertificationRunError("CERTIFICATION_RUN_NOT_FOUND", runId);
    return run;
  }
}

const toCapability = (row: Record<string, unknown>): CertificationCapability => ({
  id: String(row.id),
  runId: String(row.run_id),
  deploymentSessionId: String(row.deployment_session_id),
  releaseSha: String(row.release_sha),
  maxAmountKopecks: Number(row.max_amount_kopecks),
  expiresAt: String(row.expires_at),
  // The column is still called `nonce` - the baseline is frozen - and it holds
  // the bearer's digest. What it stores cannot be presented.
  nonceDigest: String(row.nonce),
  consumedAt: text(row.consumed_at),
  retiredAt: text(row.retired_at),
});

export class SqliteCertificationCapabilityStore implements CertificationCapabilityStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * One live capability per fence, and the index is what says so.
   *
   * The slot is a stored fact, so an expired capability still occupies it until
   * something retires it. Retiring the old one and inserting the new one is a
   * single transaction: a crash between them would either leave the fence with
   * no capability and no record of why, or free the slot for a caller that
   * never got one.
   */
  issue(capability: CertificationCapability, now: Date): CertificationCapability {
    const run = this.db.transaction(() => {
      const live = this.db.prepare(`SELECT id, expires_at FROM certification_capabilities
        WHERE deployment_session_id = ? AND consumed_at IS NULL AND retired_at IS NULL`)
        .get(capability.deploymentSessionId) as { id: string; expires_at: string } | undefined;
      if (live) {
        if (Date.parse(live.expires_at) > now.getTime()) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_ALREADY_LIVE", live.id);
        // Retirement is refused by the schema before expiry, so this is the one
        // moment it is permitted - and the stamp is the database's own clock
        // rather than a caller's, which cannot then claim the future.
        this.db.prepare(`UPDATE certification_capabilities SET retired_at = ${NOW_SQL} WHERE id = ?`).run(live.id);
      }
      this.db.prepare(`INSERT INTO certification_capabilities(id, run_id, deployment_session_id, release_sha,
          max_amount_kopecks, expires_at, nonce, consumed_at, retired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
        capability.id, capability.runId, capability.deploymentSessionId, capability.releaseSha,
        capability.maxAmountKopecks, capability.expiresAt, capability.nonceDigest,
      );
      return this.required(capability.id);
    });
    return this.db.inTransaction ? run() : run.immediate();
  }

  get(id: string): CertificationCapability | undefined {
    const row = this.db.prepare("SELECT * FROM certification_capabilities WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toCapability(row) : undefined;
  }

  /**
   * Spent in the caller's own transaction - the checkout's - so the capability
   * and the order it admitted commit together or not at all.
   *
   * `consumed_at IS NULL AND retired_at IS NULL` is in the WHERE clause, which
   * is what makes this one-shot: a second spender finds no row to change.
   */
  spend(id: string, now: Date): CertificationCapability {
    const changed = this.db.prepare(`UPDATE certification_capabilities SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND retired_at IS NULL`).run(now.toISOString(), id);
    if (changed.changes !== 1) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_NOT_SPENDABLE", id);
    return this.required(id);
  }

  private required(id: string): CertificationCapability {
    const capability = this.get(id);
    if (!capability) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_NOT_FOUND", id);
    return capability;
  }
}
