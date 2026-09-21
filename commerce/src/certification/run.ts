/**
 * The certification run: a durable, revisioned authority over one real-money
 * pass through production.
 *
 * Two properties carry the weight. The run is advanced only by compare-and-set
 * on its revision, so two runners that both read it cannot both move it - the
 * loser is told rather than silently overwriting the winner. And a business
 * effect is armed as one command before the request leaves, so a runner that
 * dies mid-flight leaves something that can be re-issued as itself rather than
 * a question nobody can answer.
 */
import { CERTIFICATION_PHASE_ORDER, CLEANUP_DIRECTION_ORDER, rankOf } from "./ranks";

export type CertificationPhase =
  | "NEW"
  | "OCCURRENCE_CREATED"
  | "OCCURRENCE_PUBLISHED"
  | "OCCURRENCE_OPEN"
  | "QUOTE_READY"
  | "CHECKOUT_SUBMITTING"
  | "CHECKOUT_CREATED"
  | "ORDER_IDENTIFIED"
  | "PAYMENT_PROVEN"
  | "TICKET_EMAIL_DELIVERED"
  | "BOOKING_CANCELLED"
  | "BOOKING_CANCELLED_EMAIL_DELIVERED"
  | "REFUND_SUCCEEDED"
  | "REFUND_EMAIL_DELIVERED"
  | "OCCURRENCE_CLEANED"
  | "COMPLETE";



/**
 * How far the run has travelled, and it only travels one way.
 *
 * `FINANCIAL_EFFECT_POSSIBLE` is entered before the first checkout, not after
 * a payment is seen: by the time a payment can be observed it is already too
 * late to have recorded that one might exist. `CLEANUP_STARTED` is entered
 * before the first destructive catalogue mutation, so a crash at any later
 * point can never resolve into reopening the catalogue.
 */
export type CleanupDirection = "NORMAL" | "FINANCIAL_EFFECT_POSSIBLE" | "CLEANUP_STARTED" | "CATALOGUE_CLEAN";


/** The operator-supplied half of the fixture. Not the customer's data, so it is persisted. */
export type OccurrenceDraft = {
  readonly cityId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly venueDisclosureText: string;
  readonly venueAnnounceBy: string;
};

/**
 * A business command is an effect that must be repeated *exactly* if it is
 * repeated at all, so each one carries everything needed to re-issue it. A key
 * without the revision it was minted against replays as a blind overwrite of
 * whatever is there now; a revision without its key replays as a second
 * command. They are one object because they are one fact.
 *
 * Catalogue cleanup is deliberately not here. Closing and hiding are monotonic
 * safety operations whose goal is a state, not a repetition of a historical
 * request - re-deriving the current revision for them is correct, and giving
 * them the same shape as a business command is what previously made "which
 * commands survive cleanup" an impossible question to answer.
 */
export type CreateOccurrenceCommand = { readonly kind: "CREATE_OCCURRENCE"; readonly idempotencyKey: string; readonly draft: OccurrenceDraft };
export type PublishOccurrenceCommand = { readonly kind: "PUBLISH_OCCURRENCE"; readonly idempotencyKey: string; readonly occurrenceId: string; readonly expectedRevision: number };
export type OpenSalesCommand = { readonly kind: "OPEN_SALES"; readonly idempotencyKey: string; readonly occurrenceId: string; readonly expectedRevision: number };
/**
 * The customer's data is never stored, only its digest: a resumed run proves
 * the re-entered body is byte-identical instead of creating a second checkout
 * for one that merely looks like it.
 */
export type CreateCheckoutCommand = { readonly kind: "CREATE_CHECKOUT"; readonly idempotencyKey: string; readonly quoteId: string; readonly requestSha256: string };
export type CancelBookingCommand = { readonly kind: "CANCEL_BOOKING"; readonly idempotencyKey: string; readonly bookingId: string };

export type BusinessCommand =
  | CreateOccurrenceCommand
  | PublishOccurrenceCommand
  | OpenSalesCommand
  | CreateCheckoutCommand
  | CancelBookingCommand;

export type BusinessCommandKind = BusinessCommand["kind"];

/**
 * Commands that only ever put something sellable in front of the public. Once
 * cleanup has begun they may never execute again - but their record is kept,
 * because the key they were armed with is how a reconciliation finds out
 * whether the request got through.
 *
 * A checkout is deliberately not among them. By the time one is armed the
 * request may already have created an order and spent the capability, with
 * only the response lost; retiring the command would leave a run stuck in
 * CHECKOUT_SUBMITTING with no way to learn its own status id. It survives
 * cleanup like a cancellation does, and the server decides what re-issuing it
 * means: an existing order is returned, and a new one is refused - which is
 * itself the proof that no checkout exists.
 */
const SUPERSEDED_BY_CLEANUP = new Set<BusinessCommandKind>(["CREATE_OCCURRENCE", "PUBLISH_OCCURRENCE", "OPEN_SALES"]);

/** The phase each command belongs to. Offered at any other, its effect has already been consumed. */
const COMMAND_PHASE: Record<BusinessCommandKind, CertificationPhase> = {
  CREATE_OCCURRENCE: "NEW",
  PUBLISH_OCCURRENCE: "OCCURRENCE_CREATED",
  OPEN_SALES: "OCCURRENCE_PUBLISHED",
  CREATE_CHECKOUT: "CHECKOUT_SUBMITTING",
  CANCEL_BOOKING: "TICKET_EMAIL_DELIVERED",
};

/**
 * Why this run can never be a PASS, recorded once and never rewritten.
 *
 * It is deliberately separate from `direction`. A catalogue that has been shut
 * says nothing about whether the certification succeeded - the happy path shuts
 * it too, as its last step. Reading a closed catalogue as a failed run turned a
 * crash between two durable transitions into a permanent failure of a
 * certification that had actually worked.
 */
export type CertificationFailure = {
  readonly outcome: "FAILED" | "INCOMPLETE";
  readonly code: string;
  readonly recordedAt: string;
};

export type SupersededCommand = {
  readonly command: BusinessCommand;
  readonly reason:
    /** Retired when cleanup began: it would only reopen the catalogue. */
    | "CLEANUP_SUPERSEDED_CATALOGUE_OPENING"
    /** Re-issued after cleanup and refused, which proves no order was ever created. */
    | "CLEANUP_PROVED_CHECKOUT_ABSENT";
};

export type CertificationRun = {
  readonly runId: string;
  /** Advanced by one on every accepted mutation. The only thing writers compete on. */
  readonly revision: number;
  /** The exact revision being certified. A run does not survive it changing. */
  readonly releaseSha: string;
  readonly phase: CertificationPhase;
  readonly direction: CleanupDirection;
  readonly startedAt: string;

  readonly pendingCommand?: BusinessCommand | null;
  /** Kept for forensics after cleanup retires an intent that must not execute. */
  readonly supersededCommand?: SupersededCommand | null;
  /** Present once the run has lost its claim to a PASS. Write-once. */
  readonly failure?: CertificationFailure | null;

  readonly occurrenceId?: string | null;
  readonly quoteId?: string | null;
  readonly statusId?: string | null;
  readonly orderId?: string | null;
  readonly paymentId?: string | null;
  readonly bookingId?: string | null;
  readonly ticketId?: string | null;
  readonly refundObligationId?: string | null;
  readonly refundId?: string | null;

  /** A human said they opened the mailbox and the ticket. Nothing else can assert this. */
  readonly humanTicketVerifiedAt?: string | null;
  readonly completedAt?: string | null;
};

export type CertificationRunMutation = Partial<Omit<CertificationRun, "runId" | "revision" | "releaseSha" | "startedAt">>;

export class CertificationRunError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CertificationRunError";
  }
}

/**
 * The durable authority. `update` takes the revision the caller believes it is
 * changing and decides in the same operation that writes: reading a run and
 * then writing it back are two steps, and two runners can both pass the read.
 * In P9 this is one guarded UPDATE whose `changes === 1` is the only proof
 * that this caller is the one that advanced it.
 */
export interface CertificationRunStore {
  create(run: CertificationRun): CertificationRun;
  load(runId: string): CertificationRun | undefined;
  update(runId: string, expectedRevision: number, mutation: CertificationRunMutation): CertificationRun;
}

// Both orders come from `ranks.ts`, which the migrations are tested against.
// A second copy here is how the application's idea of "later" drifts from the
// database's, in the direction where a regression the guard should refuse gets
// waved through.
export const directionAtLeast = (direction: CleanupDirection, least: CleanupDirection): boolean =>
  rankOf(CLEANUP_DIRECTION_ORDER, direction) >= rankOf(CLEANUP_DIRECTION_ORDER, least);

export const phaseAtLeast = (phase: CertificationPhase, least: CertificationPhase): boolean =>
  rankOf(CERTIFICATION_PHASE_ORDER, phase) >= rankOf(CERTIFICATION_PHASE_ORDER, least);

/**
 * Commands that exist to find out what happened to money, rather than to make
 * progress. A failed run is still allowed to issue them.
 */
const FINANCIAL_COMMANDS = new Set<BusinessCommandKind>(["CREATE_CHECKOUT", "CANCEL_BOOKING"]);

/** Whether this command may be armed or re-issued at all, given where the run has got to. */
export const commandPermitted = (run: CertificationRun, kind: BusinessCommandKind): string | undefined => {
  if (SUPERSEDED_BY_CLEANUP.has(kind) && directionAtLeast(run.direction, "CLEANUP_STARTED")) return "CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN";
  // Once a run has failed, its phase no longer describes progress, so binding
  // a reconciliation to one would mean a captured rouble could not be refunded
  // because the failure happened at the wrong step.
  if (run.failure && FINANCIAL_COMMANDS.has(kind)) return undefined;
  if (COMMAND_PHASE[kind] !== run.phase) return "CERTIFICATION_COMMAND_PHASE_INVALID";
  return undefined;
};

/** Two commands are the same command when every field of them agrees. */
export const sameCommand = (left: BusinessCommand | null | undefined, right: BusinessCommand): boolean =>
  Boolean(left) && JSON.stringify(left) === JSON.stringify(right);

/**
 * Turns the run cleanup-only in one write, retiring an intent that must not
 * execute while keeping its record.
 *
 * A pending cancellation is left exactly where it is. An ambiguous
 * cancellation followed by an emergency close is the case this exists for: the
 * catalogue has to shut, and the exact command and key still have to be there
 * afterwards, because that is what a reconciliation needs to find out whether
 * a customer was charged.
 */
export const enterCleanup = (store: CertificationRunStore, run: CertificationRun): CertificationRun => {
  if (directionAtLeast(run.direction, "CLEANUP_STARTED")) return run;
  const pending = run.pendingCommand;
  const supersede = pending && SUPERSEDED_BY_CLEANUP.has(pending.kind);
  return store.update(run.runId, run.revision, {
    direction: "CLEANUP_STARTED",
    ...(supersede ? { pendingCommand: null, supersededCommand: { command: pending, reason: "CLEANUP_SUPERSEDED_CATALOGUE_OPENING" as const } } : {}),
  });
};

export type RecoveryAction =
  /** Production is not the revision this run was started against. */
  | { readonly kind: "BLOCKED_BASELINE" }
  /** An interrupted command exists; re-issue that exact command and nothing else. */
  | { readonly kind: "REPLAY_PENDING"; readonly command: BusinessCommand }
  /** The run cannot pass. Reconcile what it may have done and report what it already decided. */
  | { readonly kind: "RECOVER_FAILED_RUN"; readonly failure: CertificationFailure }
  /** Cleanup began and the catalogue is not provably shut yet. */
  | { readonly kind: "CLEAN_CATALOGUE" }
  | { readonly kind: "WRITE_MANIFEST" }
  | { readonly kind: "REPORT_COMPLETE" }
  | { readonly kind: "CONTINUE" };

/**
 * What a resumed run may do next, decided from the persisted record alone.
 *
 * `baselineVerified` is answered first because every branch below can re-issue
 * a command against production, and a run resumed onto a different revision
 * would be replaying commands composed for a system that is no longer there.
 *
 * The cleanup consequence is asymmetric, which is the subtle part: an
 * emergency close can happen while a payment is in flight, so recovering the
 * financial side stays permitted afterwards - a captured payment must still be
 * refunded. Only the catalogue direction is one-way.
 */
export const planRecovery = (run: CertificationRun, baselineVerified: boolean): RecoveryAction => {
  if (!baselineVerified) return { kind: "BLOCKED_BASELINE" };

  if (run.pendingCommand) {
    const forbidden = commandPermitted(run, run.pendingCommand.kind);
    if (forbidden) throw new CertificationRunError(forbidden, run.pendingCommand.kind);
    return { kind: "REPLAY_PENDING", command: run.pendingCommand };
  }

  // A recorded failure outranks the phase, but not the pending command above:
  // re-issuing that is how the run finds out what it did before it failed.
  if (run.failure) return { kind: "RECOVER_FAILED_RUN", failure: run.failure };

  // Cleanup that began and did not finish is the next thing to do, whatever
  // phase the run happened to reach before it started.
  if (run.direction === "CLEANUP_STARTED") return { kind: "CLEAN_CATALOGUE" };
  if (run.phase === "REFUND_EMAIL_DELIVERED") return { kind: "CLEAN_CATALOGUE" };
  if (run.phase === "OCCURRENCE_CLEANED") return { kind: "WRITE_MANIFEST" };
  if (run.phase === "COMPLETE") return { kind: "REPORT_COMPLETE" };
  return { kind: "CONTINUE" };
};

/**
 * Test-only storage. P9 supplies the SQLite adapter; the monotonicity checks
 * below become CHECK constraints and the revision guard becomes the UPDATE's
 * own WHERE clause.
 */
export class InMemoryCertificationRunStore implements CertificationRunStore {
  #runs = new Map<string, CertificationRun>();

  create(run: CertificationRun): CertificationRun {
    if (this.#runs.has(run.runId)) throw new CertificationRunError("CERTIFICATION_RUN_ALREADY_EXISTS", run.runId);
    const created = { ...run, revision: 1 };
    this.#runs.set(run.runId, created);
    return created;
  }

  load(runId: string): CertificationRun | undefined { return this.#runs.get(runId); }

  update(runId: string, expectedRevision: number, mutation: CertificationRunMutation): CertificationRun {
    const current = this.#runs.get(runId);
    if (!current) throw new CertificationRunError("CERTIFICATION_RUN_NOT_FOUND", runId);
    // The loser of a race is told, not overwritten. Silently accepting the
    // second writer is how two runners each believe they own the money.
    if (current.revision !== expectedRevision) throw new CertificationRunError("CERTIFICATION_RUN_REVISION_CONFLICT", `${current.revision}`);

    const next = { ...current, ...mutation, revision: current.revision + 1 };
    if (!phaseAtLeast(next.phase, current.phase)) throw new CertificationRunError("CERTIFICATION_RUN_PHASE_REGRESSED", next.phase);
    if (!directionAtLeast(next.direction, current.direction)) throw new CertificationRunError("CERTIFICATION_RUN_DIRECTION_REGRESSED", next.direction);
    if (next.releaseSha !== current.releaseSha) throw new CertificationRunError("CERTIFICATION_RUN_RELEASE_IMMUTABLE");
    // The first failure is the one the operator is told about. A later step
    // that fails while reconciling must not rewrite the reason the run failed.
    if (current.failure && JSON.stringify(next.failure ?? null) !== JSON.stringify(current.failure)) throw new CertificationRunError("CERTIFICATION_RUN_FAILURE_IMMUTABLE");

    this.#runs.set(runId, next);
    return next;
  }
}
