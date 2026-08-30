import type Database from "better-sqlite3";
import { id } from "./crypto";
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

export type ClaimedAttempt = {
  attempt_id: string;
  attempt_no: number;
  provider_idempotence_key: string;
  send_try_count: number;
};

/**
 * The unsettled attempt a dispatchable message must have.
 *
 * Fails closed rather than choosing. The partial unique index makes "more than
 * one" unrepresentable, but "none" is representable and means the message and
 * its history disagree - which must stop dispatch rather than silently proceed
 * against a message-level key.
 */
export const requireUnsettledAttempt = (db: Database.Database, messageId: string): ClaimedAttempt => {
  const rows = db.prepare(`SELECT id, attempt_no, provider_idempotence_key, send_try_count
    FROM outbox_attempt WHERE message_id = ? AND outcome IS NULL`).all(messageId) as Array<Record<string, unknown>>;
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
  // The message transition is identical in both authority states, and the 0040
  // dispatch fence still intercepts it - which is what stops a rogue claim
  // crossing the provider boundary while dispatch is fenced, ATTEMPT or not.
  const messageClaim = attemptAuthorityIsActive(db)
    ? db.prepare(`UPDATE email_outbox SET status = 'SENDING'
        WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN')
          AND superseded_at IS NULL
          AND (status = 'PENDING' OR next_attempt_at IS NULL OR next_attempt_at <= ?)`)
        .run(message.id, timestamp)
    : db.prepare(`UPDATE email_outbox SET status = 'SENDING', lease_owner = ?, lease_expires_at = datetime('now', '+120 seconds'), send_started_at = COALESCE(send_started_at, ?), provider_request_started_at = ?, next_attempt_at = NULL, attempts = attempts + 1
        WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN')
          AND superseded_at IS NULL
          AND (status = 'PENDING' OR next_attempt_at IS NULL OR next_attempt_at <= ?)`)
        .run(leaseOwner, timestamp, timestamp, message.id, timestamp);

  if (!messageClaim.changes) return undefined;

  if (!attemptAuthorityIsActive(db)) {
    // Under LEGACY the message row holds the authoritative key; attempt #1 is a
    // shadow and is deliberately not advanced. Activation refreshes it.
    return {
      attempt_id: "",
      attempt_no: 1,
      provider_idempotence_key: message.provider_idempotence_key,
      send_try_count: 0,
    };
  }

  const attempt = requireUnsettledAttempt(db, message.id);
  db.prepare(`UPDATE outbox_attempt
    SET lease_owner = ?, lease_expires_at = datetime('now', '+120 seconds'),
        started_at = COALESCE(started_at, ?), provider_request_started_at = ?,
        next_retry_at = NULL, send_try_count = send_try_count + 1
    WHERE id = ? AND outcome IS NULL`).run(leaseOwner, timestamp, timestamp, attempt.attempt_id);
  return { ...attempt, send_try_count: attempt.send_try_count + 1 };
};
