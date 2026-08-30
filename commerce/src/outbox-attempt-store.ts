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
    , next_retry_at FROM outbox_attempt WHERE message_id = ? AND outcome IS NULL`).all(messageId) as Array<Record<string, unknown>>;
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
