import type Database from "better-sqlite3";
import { outboxAuthority } from "./outbox-authority";

/**
 * The selector-aware seam for attempt facts.
 *
 * Every function here MUST be called from inside the transaction that performs
 * the write it governs. The selector is read there, never cached and never read
 * before the transaction opens: a provider callback continues while dispatch is
 * fenced and can genuinely race the activation CAS, so a selector read outside
 * the governing transaction reintroduces exactly the interleaving that
 * BEGIN IMMEDIATE exists to remove.
 *
 * The split is by AUTHORITY, not by table:
 *
 *   message facts    status, delivery_outcome, sent_at, delivered_at,
 *                    bounced_at, suppression, supersession, ops acknowledgement
 *                    -> always email_outbox, in both authority states
 *
 *   attempt facts    lease, retry scheduling, provider job id, send try count,
 *                    per-send error, settlement
 *                    -> email_outbox legacy columns under LEGACY
 *                    -> outbox_attempt under ATTEMPT
 *
 * Several legacy statements mix both in one UPDATE. Under ATTEMPT those become
 * two writes in one transaction rather than one rewritten statement.
 */

export class OutboxAttemptError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
  }
}

/** Read inside the governing transaction. Never hoisted, never cached. */
export const attemptAuthorityIsActive = (db: Database.Database): boolean =>
  outboxAuthority(db).attempt_authority === "ATTEMPT";

/**
 * Executable, not documentary. The ATTEMPT claim moves the message and then
 * requires an attempt: outside a transaction a missing attempt would throw with
 * the message durably left in SENDING, which is the state nothing recovers
 * from cleanly.
 */
const requireTransaction = (db: Database.Database) => {
  if (!db.inTransaction) throw new OutboxAttemptError("OUTBOX_ATTEMPT_TRANSACTION_REQUIRED", 500);
};

/**
 * Candidate scan, authority-aware.
 *
 * Retry eligibility is an attempt fact. Under ATTEMPT the legacy
 * next_attempt_at is frozen and stale, so scanning on it both hides due retries
 * and admits early ones - and the freeze trigger is silent, because reading a
 * legacy column writes nothing. This is a hint only: the claim re-checks
 * eligibility inside its own transaction, which stays the authority.
 */
export const dispatchCandidates = (db: Database.Database, timestamp: string, limit: number) =>
  attemptAuthorityIsActive(db)
    ? db.prepare(`SELECT o.* FROM email_outbox o
        WHERE o.superseded_at IS NULL AND (
          o.status = 'PENDING'
          OR (o.status = 'SEND_UNKNOWN' AND EXISTS (
            SELECT 1 FROM outbox_attempt a
            WHERE a.message_id = o.id AND a.outcome IS NULL
              AND (a.next_retry_at IS NULL OR a.next_retry_at <= ?)))
        )
        ORDER BY o.created_at LIMIT ?`).all(timestamp, limit)
    : db.prepare(`SELECT * FROM email_outbox
        WHERE superseded_at IS NULL AND (
          status = 'PENDING'
          OR (status = 'SEND_UNKNOWN' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        )
        ORDER BY created_at LIMIT ?`).all(timestamp, limit);

/**
 * Discriminated so a later seam cannot mistake a LEGACY placeholder for a real
 * attempt identity. Under LEGACY there is no attempt row to name, and
 * send_try_count is the message's own counter AFTER the claim - reporting a
 * constant there would be a latent exhaustion bug the moment seam 3 trusts it.
 */
export type ClaimedAttempt =
  | { authority: "LEGACY"; attempt_id: null; attempt_no: 1; provider_idempotence_key: string; send_try_count: number }
  | { authority: "ATTEMPT"; attempt_id: string; attempt_no: number; provider_idempotence_key: string; send_try_count: number };

/**
 * The unsettled attempt a dispatchable message must have.
 *
 * Fails closed rather than choosing. The partial unique index makes "more than
 * one" unrepresentable, but "none" is representable and means the message and
 * its history disagree - which must stop dispatch rather than silently proceed
 * against a message-level key.
 */
export const requireUnsettledAttempt = (db: Database.Database, messageId: string) => {
  const rows = db.prepare(`SELECT id, attempt_no, provider_idempotence_key, send_try_count
    , next_retry_at, provider_job_id FROM outbox_attempt WHERE message_id = ? AND outcome IS NULL`).all(messageId) as Array<Record<string, unknown>>;
  if (rows.length === 0) throw new OutboxAttemptError("OUTBOX_ATTEMPT_MISSING");
  // Unrepresentable while the partial unique index exists; asserted anyway
  // because silently picking one would be the worst possible recovery.
  if (rows.length > 1) throw new OutboxAttemptError("OUTBOX_ATTEMPT_AMBIGUOUS");
  const row = rows[0]!;
  return {
    attempt_id: String(row.id),
    attempt_no: Number(row.attempt_no),
    provider_idempotence_key: String(row.provider_idempotence_key),
    send_try_count: Number(row.send_try_count),
    next_retry_at: row.next_retry_at === null || row.next_retry_at === undefined ? null : String(row.next_retry_at),
    provider_job_id: row.provider_job_id === null || row.provider_job_id === undefined ? null : String(row.provider_job_id),
  };
};

/**
 * Claim a message for dispatch, returning the AUTHORITATIVE attempt identity.
 *
 * The provider key comes from the claim rather than from the pre-claim message
 * snapshot. Under LEGACY those are the same value, so using the snapshot would
 * be accidentally correct for attempt #1 and wrong the moment a resend creates
 * attempt #2 with its own key.
 *
 * Returns undefined when the message was not claimable, matching the previous
 * `changes === 0` contract.
 */
export const claimForDispatch = (
  db: Database.Database,
  message: { id: string; provider_idempotence_key: string },
  leaseOwner: string,
  timestamp: string,
): ClaimedAttempt | undefined => {
  requireTransaction(db);

  if (!attemptAuthorityIsActive(db)) {
    const claimed = db.prepare(`UPDATE email_outbox SET status = 'SENDING', lease_owner = ?, lease_expires_at = datetime('now', '+120 seconds'), send_started_at = COALESCE(send_started_at, ?), provider_request_started_at = ?, next_attempt_at = NULL, attempts = attempts + 1
      WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN')
        AND superseded_at IS NULL
        AND (status = 'PENDING' OR next_attempt_at IS NULL OR next_attempt_at <= ?)`)
      .run(leaseOwner, timestamp, timestamp, message.id, timestamp);
    if (!claimed.changes) return undefined;
    // The message row is the authority under LEGACY, including its own try
    // counter - reporting a constant here would be a latent exhaustion bug.
    const attempts = db.prepare("SELECT attempts FROM email_outbox WHERE id = ?").get(message.id) as { attempts: number };
    return {
      authority: "LEGACY",
      attempt_id: null,
      attempt_no: 1,
      provider_idempotence_key: message.provider_idempotence_key,
      send_try_count: Number(attempts.attempts),
    };
  }

  // Under ATTEMPT, claimability is decided WITHOUT reading a frozen legacy
  // column. next_attempt_at is stale after activation, and reading it writes
  // nothing - so the freeze trigger stays silent while the decision is wrong in
  // both directions: hiding due retries and admitting early ones.
  const current = db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(message.id) as
    { status: string; superseded_at: string | null } | undefined;
  if (!current || current.superseded_at !== null) return undefined;
  if (current.status !== "PENDING" && current.status !== "SEND_UNKNOWN") return undefined;

  const attempt = requireUnsettledAttempt(db, message.id);
  const due = current.status === "PENDING" || attempt.next_retry_at === null || attempt.next_retry_at <= timestamp;
  if (!due) return undefined;

  // The message transition is performed in both authority states, so the
  // production-proven 0040 dispatch fence remains the exclusion mechanism on
  // both sides of the authority CAS.
  const claimed = db.prepare(`UPDATE email_outbox SET status = 'SENDING'
    WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN') AND superseded_at IS NULL`).run(message.id);
  if (!claimed.changes) return undefined;

  db.prepare(`UPDATE outbox_attempt
    SET lease_owner = ?, lease_expires_at = datetime('now', '+120 seconds'),
        started_at = COALESCE(started_at, ?), provider_request_started_at = ?,
        next_retry_at = NULL, send_try_count = send_try_count + 1
    WHERE id = ? AND outcome IS NULL`).run(leaseOwner, timestamp, timestamp, attempt.attempt_id);
  return {
    authority: "ATTEMPT",
    attempt_id: attempt.attempt_id,
    attempt_no: attempt.attempt_no,
    provider_idempotence_key: attempt.provider_idempotence_key,
    send_try_count: attempt.send_try_count + 1,
  };
};

/**
 * Whether the attempt settlement won its CAS, and whether the message accepted
 * the resulting projection. The two are distinct: a settlement can win while
 * the message legitimately refuses, when consent was withdrawn mid-flight.
 */
export type SettlementResult = { attempt_settled: boolean; message_updated: boolean };

/**
 * Provider acceptance.
 *
 * Message facts stay on email_outbox in both authority states: status is
 * message lifecycle, not attempt state. What moves is the per-send evidence -
 * the provider job id, the lease, the cleared error and retry scheduling.
 *
 * Returns false when the message was no longer acceptable, which happens when
 * consent was withdrawn while send() was in flight. The provider call cannot be
 * recalled, so its job id is still recorded as durable evidence and the local
 * row is never revived.
 */
export const recordProviderAcceptance = (
  db: Database.Database,
  message: { id: string },
  claimed: ClaimedAttempt,
  jobId: string,
): SettlementResult => {
  requireTransaction(db);

  if (claimed.authority === "LEGACY") {
    const accepted = db.prepare(`UPDATE email_outbox
      SET status = 'ACCEPTED', job_id = ?, lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = NULL, last_error = NULL, provider_error_code = NULL, provider_error_message = NULL
      WHERE id = ? AND status = 'SENDING' AND suppressed_at IS NULL AND superseded_at IS NULL`).run(jobId, message.id);
    if (accepted.changes) return { attempt_settled: true, message_updated: true };
    db.prepare(`UPDATE email_outbox SET job_id = COALESCE(job_id, ?), lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND (suppressed_at IS NOT NULL OR superseded_at IS NOT NULL)`).run(jobId, message.id);
    // Under LEGACY the message IS the authority, so its refusal is the
    // settlement's refusal.
    return { attempt_settled: false, message_updated: false };
  }

  // The attempt settlement is the AUTHORITY CAS and therefore goes first. With
  // the message projected first, a late contradictory settlement moved the
  // message while the attempt refused to change - leaving message and history
  // disagreeing, which is precisely the split this design exists to prevent.
  const settled = db.prepare(`UPDATE outbox_attempt
    SET outcome = 'ACCEPTED', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        provider_job_id = ?, lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL,
        failure_code = NULL, failure_detail = NULL
    WHERE id = ? AND outcome IS NULL`).run(jobId, claimed.attempt_id);
  if (!settled.changes) return { attempt_settled: false, message_updated: false };

  // Only now project onto the message. It may legitimately refuse: consent can
  // be withdrawn while send() is in flight, and the provider call cannot be
  // recalled - so the attempt stays ACCEPTED while the message is not revived.
  const accepted = db.prepare(`UPDATE email_outbox SET status = 'ACCEPTED'
    WHERE id = ? AND status = 'SENDING' AND suppressed_at IS NULL AND superseded_at IS NULL`).run(message.id);
  return { attempt_settled: true, message_updated: accepted.changes > 0 };
};

/**
 * A received HTTP response refusing this dispatch.
 *
 * Authoritative evidence, never converted into an ambiguous replay: the message
 * becomes FAILED + KNOWN_FAILED and the attempt settles KNOWN_FAILED.
 *
 * failure_detail is canonical JSON rather than a concatenated string, because
 * it becomes historical evidence and should have exactly one representation.
 */
export const recordProviderRefusal = (
  db: Database.Database,
  message: { id: string },
  claimed: ClaimedAttempt,
  refusal: { providerCode?: string | null; providerMessage?: string | null },
): SettlementResult => {
  requireTransaction(db);

  if (claimed.authority === "LEGACY") {
    const failed = db.prepare(`UPDATE email_outbox
      SET status = 'FAILED', delivery_outcome = 'KNOWN_FAILED', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
          last_error = 'UNISENDER_HTTP_REJECTED', provider_error_code = ?, provider_error_message = ?
      WHERE id = ? AND status = 'SENDING'`).run(refusal.providerCode ?? null, refusal.providerMessage ?? null, message.id);
    return { attempt_settled: failed.changes > 0, message_updated: failed.changes > 0 };
  }

  // Attempt settlement first, for the same reason as acceptance: it is the
  // authority CAS, not an immutability convenience applied after the message
  // has already moved.
  const settled = db.prepare(`UPDATE outbox_attempt
    SET outcome = 'KNOWN_FAILED', completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
        lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL,
        failure_code = 'UNISENDER_HTTP_REJECTED', failure_detail = ?
    WHERE id = ? AND outcome IS NULL`)
    .run(JSON.stringify({ provider_error_code: refusal.providerCode ?? null, provider_error_message: refusal.providerMessage ?? null }), claimed.attempt_id);
  if (!settled.changes) return { attempt_settled: false, message_updated: false };

  const failed = db.prepare(`UPDATE email_outbox SET status = 'FAILED', delivery_outcome = 'KNOWN_FAILED'
    WHERE id = ? AND status = 'SENDING'`).run(message.id);
  return { attempt_settled: true, message_updated: failed.changes > 0 };
};

/**
 * Provider identity for a SEND_UNKNOWN reconciliation lookup.
 *
 * A reader, and one no trigger can protect: after activation the message's
 * job_id and provider_idempotence_key are frozen compatibility fields, so
 * looking up under them would ask the provider about the wrong request - or
 * about attempt #1 when attempt #2 is the one in flight - while writing
 * nothing and firing nothing.
 */
export const providerLookupIdentity = (
  db: Database.Database,
  message: { id: string; job_id: unknown; provider_idempotence_key: unknown },
): { jobId: string | null; idempotencyKey: string } => {
  if (!attemptAuthorityIsActive(db)) {
    return {
      jobId: message.job_id === null || message.job_id === undefined ? null : String(message.job_id),
      idempotencyKey: String(message.provider_idempotence_key),
    };
  }
  const attempt = requireUnsettledAttempt(db, message.id);
  return { jobId: attempt.provider_job_id, idempotencyKey: attempt.provider_idempotence_key };
};

/**
 * A resolved attempt identity, carried across an external provider call.
 *
 * Identity is resolved once, inside a transaction, and then passed forward -
 * never rediscovered from message_id after the call returns. Between the two,
 * authority can flip and the current attempt can change, so evidence retrieved
 * for one attempt must never be applied to another.
 */
export type AttemptRef =
  | { authority: "LEGACY" }
  | { authority: "ATTEMPT"; attempt_id: string };

export const resolveAttemptRef = (db: Database.Database, messageId: string): AttemptRef =>
  attemptAuthorityIsActive(db) ? { authority: "ATTEMPT", attempt_id: requireUnsettledAttempt(db, messageId).attempt_id } : { authority: "LEGACY" };

/** The try count the exhaustion decision is made against, per authority. */
export const sendTryCount = (db: Database.Database, message: { id: string; attempts: unknown }): number =>
  attemptAuthorityIsActive(db) ? requireUnsettledAttempt(db, message.id).send_try_count : Number(message.attempts);

const AMBIGUOUS = "UNISENDER_TRANSPORT_AMBIGUOUS";
const EXHAUSTED_ERROR = "UNISENDER_SEND_UNKNOWN_ATTEMPT_LIMIT_REACHED";
const EXHAUSTED_CODE = "SEND_UNKNOWN_ATTEMPT_LIMIT";
const EXHAUSTED_MESSAGE = "Ambiguous email dispatch retry limit reached.";

/**
 * Which supersession category this write is allowed to act on.
 *
 * Named rather than a boolean because the previous boolean was wrong twice: it
 * checked `suppressed_at` while being called `requireUnsuperseded`, and the
 * loop that had selected SUPERSEDED rows passed it, dropping the
 * `superseded_at IS NOT NULL` recheck the original statement carried. The scan
 * happens before the per-row transaction, so the write must revalidate its own
 * category.
 */
export type SupersessionGuard = "ANY" | "REQUIRE_SUPERSEDED" | "REQUIRE_UNSUPERSEDED";

type WriteGuard = { supersession: SupersessionGuard; requireUnsuppressed: boolean };

const guardClause = ({ supersession, requireUnsuppressed }: WriteGuard) =>
  (requireUnsuppressed ? " AND suppressed_at IS NULL" : "")
  + (supersession === "REQUIRE_SUPERSEDED" ? " AND superseded_at IS NOT NULL"
    : supersession === "REQUIRE_UNSUPERSEDED" ? " AND superseded_at IS NULL" : "");

/**
 * Whether a carried reference still names this message's unsettled attempt.
 *
 * Checked BEFORE any message mutation, in the same BEGIN IMMEDIATE as the
 * writes, so it cannot go stale between the check and them. Without this the
 * message could be projected on behalf of an attempt that had already settled
 * while its successor - the genuinely current one - went untouched, which is
 * the same split seam 2 fixed on the settlement paths.
 */
const carriedRefIsCurrent = (db: Database.Database, messageId: string, ref: AttemptRef): boolean => {
  if (ref.authority === "LEGACY") return true;
  return Boolean(db.prepare(`SELECT 1 FROM outbox_attempt
    WHERE id = ? AND message_id = ? AND outcome IS NULL`).get(ref.attempt_id, messageId));
};

/** Reschedule a still-ambiguous send. The message stays SEND_UNKNOWN either way. */
export const deferAmbiguousObservation = (
  db: Database.Database,
  message: { id: string },
  ref: AttemptRef,
  retryAt: string,
) => {
  requireTransaction(db);
  if (ref.authority === "LEGACY") {
    db.prepare(`UPDATE email_outbox SET next_attempt_at = ? WHERE id = ? AND status = 'SEND_UNKNOWN'`).run(retryAt, message.id);
    return;
  }
  db.prepare(`UPDATE outbox_attempt SET next_retry_at = ? WHERE id = ? AND outcome IS NULL`).run(retryAt, ref.attempt_id);
};

/**
 * The automatic reconciliation budget is spent.
 *
 * The attempt does NOT settle. Nothing was established - that is the entire
 * point of UNRESOLVED - and settling it would make later evidence unable to
 * resolve it, which 0039 exists to prevent. The message records the ambiguity;
 * the attempt records only that automatic reconciliation stopped.
 */
export const failExhaustedAmbiguous = (
  db: Database.Database,
  message: { id: string },
  ref: AttemptRef,
  fromStatus: "SEND_UNKNOWN" | "SENDING",
  guard: WriteGuard = { supersession: "ANY", requireUnsuppressed: false },
) => {
  requireTransaction(db);
  if (!carriedRefIsCurrent(db, message.id, ref)) return;
  const clause = guardClause(guard);

  if (ref.authority === "LEGACY") {
    db.prepare(`UPDATE email_outbox
      SET status = 'FAILED', delivery_outcome = 'UNRESOLVED', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
          last_error = ?, provider_error_code = ?, provider_error_message = ?
      WHERE id = ? AND status = ?${clause}`).run(EXHAUSTED_ERROR, EXHAUSTED_CODE, EXHAUSTED_MESSAGE, message.id, fromStatus);
    return;
  }
  const moved = db.prepare(`UPDATE email_outbox SET status = 'FAILED', delivery_outcome = 'UNRESOLVED'
    WHERE id = ? AND status = ?${clause}`).run(message.id, fromStatus);
  if (!moved.changes) return;
  db.prepare(`UPDATE outbox_attempt
    SET lease_owner = NULL, lease_expires_at = NULL, next_retry_at = NULL,
        reconciliation_exhausted_at = COALESCE(reconciliation_exhausted_at, CURRENT_TIMESTAMP)
    WHERE id = ? AND outcome IS NULL`).run(ref.attempt_id);
};

/** A send whose outcome could not be established, returning to the ambiguous state. */
export const deferAmbiguousSend = (
  db: Database.Database,
  message: { id: string },
  ref: AttemptRef,
  retryAt: string | null,
  guard: WriteGuard,
) => {
  requireTransaction(db);
  if (!carriedRefIsCurrent(db, message.id, ref)) return;
  const clause = guardClause(guard);

  if (ref.authority === "LEGACY") {
    db.prepare(`UPDATE email_outbox
      SET status = 'SEND_UNKNOWN', lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = ?, last_error = ?, provider_error_code = NULL, provider_error_message = NULL
      WHERE id = ? AND status = 'SENDING'${clause}`).run(retryAt, AMBIGUOUS, message.id);
    return;
  }
  const moved = db.prepare(`UPDATE email_outbox SET status = 'SEND_UNKNOWN'
    WHERE id = ? AND status = 'SENDING'${clause}`).run(message.id);
  if (!moved.changes) return;
  db.prepare(`UPDATE outbox_attempt
    SET lease_owner = NULL, lease_expires_at = NULL, next_retry_at = ?, failure_code = ?, failure_detail = NULL
    WHERE id = ? AND outcome IS NULL`).run(retryAt, AMBIGUOUS, ref.attempt_id);
};

/** The attempt a claim actually took, for carrying across the send() call. */
export const claimedAttemptRef = (claimed: ClaimedAttempt): AttemptRef =>
  claimed.authority === "ATTEMPT" ? { authority: "ATTEMPT", attempt_id: claimed.attempt_id } : { authority: "LEGACY" };

/**
 * Sends whose lease has expired, per authority.
 *
 * Another reader no trigger protects: under ATTEMPT the lease lives on the
 * attempt, so scanning email_outbox.lease_expires_at would return nothing and
 * crashed sends would never be recovered - silently, forever.
 */
export const staleLeasedSends = (db: Database.Database, timestamp: string, superseded: boolean) => {
  const supersededClause = superseded ? "IS NOT NULL" : "IS NULL";
  return attemptAuthorityIsActive(db)
    ? db.prepare(`SELECT o.id, a.send_try_count AS attempts FROM email_outbox o
        JOIN outbox_attempt a ON a.message_id = o.id AND a.outcome IS NULL
        WHERE o.status = 'SENDING' AND o.suppressed_at IS NULL AND o.superseded_at ${supersededClause}
          AND a.lease_expires_at < ?`).all(timestamp) as Array<{ id: string; attempts: number }>
    : db.prepare(`SELECT id, attempts FROM email_outbox
        WHERE status = 'SENDING' AND suppressed_at IS NULL AND superseded_at ${supersededClause}
          AND lease_expires_at < ?`).all(timestamp) as Array<{ id: string; attempts: number }>;
};
