import type Database from "better-sqlite3";
import { id } from "./crypto";
import { OutboxAuthorityError, emailDispatchDrained, outboxAuthority, type DispatchEpoch } from "./outbox-authority";
import { LEGACY_EXHAUSTION_ERROR } from "./outbox-attempt-store";

/**
 * The one-way transfer of attempt authority: LEGACY -> ATTEMPT.
 *
 * Everything below happens in ONE transaction - the assertions, the refresh,
 * the backfill, the validation and the CAS. That is what makes the
 * serialization argument hold: a legacy writer either commits before this
 * transaction and is captured by the snapshot, or it waits and finds authority
 * already ATTEMPT with the 0040 freeze trigger over it. There is no
 * interleaving in which a legacy write lands after the read meant to capture
 * it.
 *
 * Identity is validation material, never an update target. The five immutable
 * fields - id, message_id, attempt_no, provider_idempotence_key, requested_at -
 * are checked and the transaction aborts on disagreement. Refreshing them would
 * be rewriting what an attempt IS, and the provider key in particular is the
 * one field whose rewrite turns a replay into a second email.
 */

export type ActivationResult = {
  activated: boolean;
  replayed: boolean;
  revision: number;
  /** Historical messages that had no attempt row at all. */
  backfilled: number;
  /** Shadow attempts created by attempt-aware enqueue, synced from LEGACY. */
  refreshed: number;
  /**
   * Settled attempts carrying no settlement instant, because the legacy row
   * records none.
   */
  settled_without_completion: number;
  /**
   * Attempts whose legacy row proves the reconciliation budget ran out, but
   * for which no exhaustion instant exists to carry over.
   */
  exhausted_without_timestamp: number;
};

/**
 * Legacy state -> attempt #1 outcome.
 *
 * NULL where nothing was established. UNRESOLVED is deliberately absent from
 * the attempt: it is message-level ambiguity, and settling it here would forbid
 * later provider evidence from ever resolving it.
 */
const OUTCOME_FROM_LEGACY = `CASE
    WHEN o.status IN ('ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED') THEN 'ACCEPTED'
    WHEN o.status = 'FAILED' AND o.delivery_outcome = 'KNOWN_FAILED' THEN 'KNOWN_FAILED'
    ELSE NULL
  END`;

/**
 * When THIS SEND settled, and only from a legacy column that actually means
 * that.
 *
 * `sent_at` is exactly the instant the provider accepted, so it is the
 * acceptance instant even for a message that later BOUNCED - the bounce is a
 * message fact and belongs nowhere near the attempt's completion. A refusal has
 * no legacy counterpart at all: there is no failed_at, and stamping the cutover
 * clock would assert the send failed at activation time, which is false
 * evidence in an append-only history. It stays NULL and is counted instead.
 */
const COMPLETED_AT_FROM_LEGACY = `CASE
    WHEN o.status IN ('ACCEPTED', 'SENT', 'DELIVERED', 'BOUNCED') THEN o.sent_at
    ELSE NULL
  END`;

/**
 * Failure evidence is mapped SEPARATELY from outcome, and only where the legacy
 * columns actually hold evidence about the send.
 *
 * Copying `last_error` unconditionally would undo the taxonomy the five seams
 * established, in two specific ways:
 *
 *   SKIPPED       legacy `last_error` is the suppression reason - a
 *                 message-level fact such as a consent withdrawal. Seam 4
 *                 deliberately stopped writing it under ATTEMPT: it is not a
 *                 provider or send failure and must not become one.
 *
 *   UNRESOLVED    legacy exhaustion writes UNISENDER_SEND_UNKNOWN_ATTEMPT_LIMIT_
 *                 REACHED into `last_error` and SEND_UNKNOWN_ATTEMPT_LIMIT into
 *                 `provider_error_code`. That is the scheduler's own budget
 *                 decision wearing provider clothes. Seam 3 records exhaustion
 *                 as `reconciliation_exhausted_at` and nothing else.
 *
 * What remains is the evidence that IS about this send:
 *
 *   FAILED + KNOWN_FAILED   UNISENDER_HTTP_REJECTED plus the provider's own
 *                           code and message - a refusal the provider stated.
 *   SEND_UNKNOWN            UNISENDER_TRANSPORT_AMBIGUOUS, provider fields
 *                           already NULL - per-send ambiguity, exactly what the
 *                           ATTEMPT branch of deferAmbiguousSend writes.
 *
 * Everything else is NULL, which also matches the runtime directly: acceptance
 * clears failure evidence in both authorities.
 */
const FAILURE_EVIDENCE_APPLIES = `(
    (o.status = 'FAILED' AND o.delivery_outcome = 'KNOWN_FAILED')
    OR o.status = 'SEND_UNKNOWN'
  )`;

const FAILURE_CODE_FROM_LEGACY = `CASE
    WHEN ${FAILURE_EVIDENCE_APPLIES} THEN o.last_error
    ELSE NULL
  END`;

/** Canonical, never a concatenated string: this becomes historical evidence. */
const FAILURE_DETAIL_FROM_LEGACY = `CASE
    WHEN NOT ${FAILURE_EVIDENCE_APPLIES} THEN NULL
    WHEN o.provider_error_code IS NULL AND o.provider_error_message IS NULL THEN NULL
    ELSE json_object('provider_error_code', o.provider_error_code, 'provider_error_message', o.provider_error_message)
  END`;

/**
 * What "0041 is present" actually means.
 *
 * A table-name lookup is a proxy for this property, and the counterexample is
 * cheap: apply 0041, drop email_outbox_legacy_attempt_freeze_guard, fence, drain
 * and activate. The flip succeeds, and the store is left ATTEMPT-authoritative
 * with legacy attempt writes UNFROZEN - the one thing the whole cutover exists
 * to prevent. The enforcement objects are the migration; the table is only
 * where the rows go.
 *
 * The two facts NOT listed are the ones the transaction proves by using them:
 * the CAS fails closed if the authority CHECK still forbids 'ATTEMPT', and the
 * audit insert fails closed if the event vocabulary still forbids
 * 'AUTHORITY_ACTIVATED'. Either aborts the whole transaction, so asserting them
 * separately would restate a guarantee already held.
 */
const REQUIRED_SCHEMA_OBJECTS = [
  "outbox_attempt",
  // Structural: one unsettled attempt per message. Without it a resend can be
  // inserted beside a send whose outcome was never established.
  "outbox_attempt_active_unique",
  "outbox_attempt_identity_immutable_guard",
  "outbox_attempt_settled_immutable_guard",
  "outbox_attempt_delete_guard",
  // 0040's guards, dropped and recreated by 0041 around the authority rebuild.
  // The freeze guard is the one that becomes load-bearing at the instant this
  // transaction commits.
  "email_outbox_dispatch_pause_guard",
  "email_outbox_legacy_attempt_freeze_guard",
] as const;

const MIGRATION = "0041_outbox_attempt.sql";

const assertSchemaPresent = (db: Database.Database) => {
  const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(MIGRATION);
  if (!applied) throw new OutboxAuthorityError("OUTBOX_ACTIVATION_SCHEMA_MISSING", 409, MIGRATION);

  const placeholders = REQUIRED_SCHEMA_OBJECTS.map(() => "?").join(", ");
  const found = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`)
    .all(...REQUIRED_SCHEMA_OBJECTS) as Array<{ name: string }>).map((row) => row.name));
  const missing = REQUIRED_SCHEMA_OBJECTS.filter((name) => !found.has(name));
  // Named, because a refusal that cannot say which object is gone costs an
  // operator a manual schema diff in the middle of a cutover.
  if (missing.length) throw new OutboxAuthorityError("OUTBOX_ACTIVATION_SCHEMA_INCOMPLETE", 409, missing.join(", "));
};

const assertOrFail = (condition: boolean, code: string) => {
  if (!condition) throw new OutboxAuthorityError(code, 409);
};

const count = (db: Database.Database, sql: string): number =>
  Number((db.prepare(sql).get() as { n: number }).n);

/**
 * Replay branches BEFORE any refresh or backfill.
 *
 * Once authority is ATTEMPT the legacy columns are frozen and the attempt rows
 * are the authority, so re-running the sync would copy a stale snapshot over
 * live history. A matching activation by the same epoch reconciles as success;
 * a different epoch, or a missing audit line, fails closed.
 */
const replay = (db: Database.Database, epoch: DispatchEpoch, revision: number): ActivationResult => {
  const event = db.prepare(`SELECT owner_release_id, owner_generation FROM outbox_authority_events
    WHERE action = 'AUTHORITY_ACTIVATED' ORDER BY revision DESC LIMIT 1`).get() as
    { owner_release_id: string; owner_generation: number | null } | undefined;
  // Authority is ATTEMPT with nothing in the audit stream saying how it got
  // there. That is an inconsistent control plane, not a replay.
  assertOrFail(Boolean(event), "OUTBOX_ACTIVATION_AUDIT_MISSING");
  assertOrFail(
    event!.owner_release_id === epoch.release_id && (event!.owner_generation ?? null) === (epoch.generation ?? null),
    "OUTBOX_ACTIVATION_OWNER_CONFLICT",
  );
  return { activated: false, replayed: true, revision, backfilled: 0, refreshed: 0, settled_without_completion: 0, exhausted_without_timestamp: 0 };
};

export const activateAttemptAuthority = (
  db: Database.Database,
  epoch: DispatchEpoch,
  input: { expected_revision: number; reason: string },
): ActivationResult => {
  // Not a convenience: every assertion below is only meaningful if nothing can
  // commit between it and the CAS.
  if (!db.inTransaction) throw new OutboxAuthorityError("OUTBOX_ACTIVATION_TRANSACTION_REQUIRED", 500);

  assertSchemaPresent(db);

  const authority = outboxAuthority(db);
  if (authority.attempt_authority === "ATTEMPT") return replay(db, epoch, authority.revision);

  assertOrFail(authority.email_dispatch_paused, "OUTBOX_ACTIVATION_DISPATCH_NOT_FENCED");
  // The fence must be held by THIS cutover. Holding a fence someone else owns
  // is the case CAS cannot cover.
  assertOrFail(
    authority.dispatch_owner_release_id === epoch.release_id
      && (authority.dispatch_owner_generation ?? null) === (epoch.generation ?? null),
    "OUTBOX_DISPATCH_OWNER_CONFLICT",
  );
  assertOrFail(authority.revision === input.expected_revision, "OUTBOX_AUTHORITY_REVISION_CONFLICT");

  // Exclusion is not quiescence. The fence stops the next send from starting;
  // this proves the last one finished.
  assertOrFail(emailDispatchDrained(db).drained, "OUTBOX_ACTIVATION_NOT_DRAINED");

  // Under LEGACY the only attempt writer is enqueue, which creates exactly one
  // unsettled attempt #1. Anything else means a binary wrote attempt facts
  // while they were not authoritative - precisely the old/new disagreement this
  // cutover exists to serialize - and the sync below would silently preserve it
  // because it skips settled rows.
  assertOrFail(count(db, "SELECT COUNT(*) AS n FROM outbox_attempt WHERE attempt_no <> 1") === 0,
    "OUTBOX_ACTIVATION_UNEXPECTED_SUCCESSOR_ATTEMPT");
  assertOrFail(count(db, "SELECT COUNT(*) AS n FROM outbox_attempt WHERE outcome IS NOT NULL") === 0,
    "OUTBOX_ACTIVATION_UNEXPECTED_SETTLED_ATTEMPT");

  // A lease in the attempt store would survive the flip as a claim by a worker
  // that no longer exists, and the drain check above reads only the legacy
  // columns.
  assertOrFail(count(db, "SELECT COUNT(*) AS n FROM outbox_attempt WHERE lease_owner IS NOT NULL") === 0,
    "OUTBOX_ACTIVATION_ATTEMPT_STILL_LEASED");

  // The remaining two mutable columns, which the sync does NOT write.
  //
  // Together with the refresh below and the identity validation, this makes the
  // treatment of outbox_attempt total: every column is either identity
  // (validated, never written), refreshed from LEGACY, or asserted absent here.
  // Without this pair a shadow attempt could carry a non-authoritative
  // lease_expires_at or reconciliation_exhausted_at straight through the flip
  // and become authoritative history - and reconciliation_exhausted_at in
  // particular has no legacy source, so there is nothing honest to refresh it
  // from. Refusing an unexpected value is the fail-closed answer; inventing one
  // is not.
  assertOrFail(count(db, `SELECT COUNT(*) AS n FROM outbox_attempt
    WHERE lease_expires_at IS NOT NULL OR reconciliation_exhausted_at IS NOT NULL`) === 0,
    "OUTBOX_ACTIVATION_UNEXPECTED_SHADOW_STATE");

  // Refresh first, then backfill: the two sets are disjoint at this point, so
  // the reported counts stay meaningful and a freshly backfilled row is never
  // rewritten by a query that was never about it.
  //
  // Only mutable progress and evidence is written. The identity columns are
  // absent from this statement by construction, and the 0041 identity trigger
  // stands behind that.
  const refreshed = db.prepare(`UPDATE outbox_attempt AS t
    SET started_at = (SELECT o.send_started_at FROM email_outbox o WHERE o.id = t.message_id),
        provider_request_started_at = (SELECT o.provider_request_started_at FROM email_outbox o WHERE o.id = t.message_id),
        completed_at = (SELECT ${COMPLETED_AT_FROM_LEGACY} FROM email_outbox o WHERE o.id = t.message_id),
        provider_job_id = (SELECT o.job_id FROM email_outbox o WHERE o.id = t.message_id),
        send_try_count = (SELECT COALESCE(o.attempts, 0) FROM email_outbox o WHERE o.id = t.message_id),
        next_retry_at = (SELECT o.next_attempt_at FROM email_outbox o WHERE o.id = t.message_id),
        outcome = (SELECT ${OUTCOME_FROM_LEGACY} FROM email_outbox o WHERE o.id = t.message_id),
        failure_code = (SELECT ${FAILURE_CODE_FROM_LEGACY} FROM email_outbox o WHERE o.id = t.message_id),
        failure_detail = (SELECT ${FAILURE_DETAIL_FROM_LEGACY} FROM email_outbox o WHERE o.id = t.message_id)
    WHERE t.attempt_no = 1 AND t.outcome IS NULL`).run().changes;

  // Messages predating attempt-aware enqueue get their attempt #1 here, once.
  // requested_at is the message's own creation instant - the moment the send
  // was requested - and is never touched again.
  const backfilled = db.prepare(`INSERT INTO outbox_attempt(
      id, message_id, attempt_no, provider_idempotence_key, requested_at,
      started_at, provider_request_started_at, completed_at, provider_job_id,
      send_try_count, next_retry_at, outcome, failure_code, failure_detail)
    SELECT lower(hex(randomblob(16))), o.id, 1, o.provider_idempotence_key, o.created_at,
      o.send_started_at, o.provider_request_started_at, ${COMPLETED_AT_FROM_LEGACY}, o.job_id,
      COALESCE(o.attempts, 0), o.next_attempt_at, ${OUTCOME_FROM_LEGACY},
      ${FAILURE_CODE_FROM_LEGACY}, ${FAILURE_DETAIL_FROM_LEGACY}
    FROM email_outbox o
    WHERE NOT EXISTS (SELECT 1 FROM outbox_attempt a WHERE a.message_id = o.id)`).run().changes;

  // Global validation. Everything here is a whole-table statement, not a
  // per-row one: the property being established is about the store, and a
  // check that only covers the rows this transaction happened to touch would
  // not establish it.
  assertOrFail(count(db, `SELECT COUNT(*) AS n FROM email_outbox o
    WHERE NOT EXISTS (SELECT 1 FROM outbox_attempt a WHERE a.message_id = o.id AND a.attempt_no = 1)`) === 0,
    "OUTBOX_ACTIVATION_MESSAGE_WITHOUT_ATTEMPT");

  // Attempt #1's key must still be the one the message carries as its
  // compatibility shadow. A mismatch means the two stores disagree about what
  // was sent to the provider, which no refresh may paper over - after the flip
  // the attempt key is what a retry would be made under.
  assertOrFail(count(db, `SELECT COUNT(*) AS n FROM outbox_attempt a
    JOIN email_outbox o ON o.id = a.message_id
    WHERE a.attempt_no = 1 AND a.provider_idempotence_key IS NOT o.provider_idempotence_key`) === 0,
    "OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH");

  assertOrFail(count(db, `SELECT COUNT(*) AS n FROM outbox_attempt
    WHERE id IS NULL OR message_id IS NULL OR attempt_no IS NULL
      OR provider_idempotence_key IS NULL OR requested_at IS NULL`) === 0,
    "OUTBOX_ACTIVATION_IDENTITY_INCOMPLETE");

  assertOrFail(count(db, `SELECT COUNT(*) AS n FROM (
    SELECT message_id FROM outbox_attempt WHERE outcome IS NULL GROUP BY message_id HAVING COUNT(*) > 1)`) === 0,
    "OUTBOX_ACTIVATION_AMBIGUOUS_ATTEMPT");

  // Two numbers the cutover records instead of two values it would have to
  // invent. Same principle in both cases: the legacy row establishes that
  // something happened without establishing when.
  const settledWithoutCompletion = count(db,
    "SELECT COUNT(*) AS n FROM outbox_attempt WHERE outcome IS NOT NULL AND completed_at IS NULL");
  const exhaustedWithoutTimestamp = Number((db.prepare(`SELECT COUNT(*) AS n FROM outbox_attempt a
    JOIN email_outbox o ON o.id = a.message_id
    WHERE a.reconciliation_exhausted_at IS NULL
      AND o.status = 'FAILED' AND o.delivery_outcome = 'UNRESOLVED'
      AND o.last_error = ?`).get(LEGACY_EXHAUSTION_ERROR) as { n: number }).n);

  // The CAS restates every precondition it depends on, so it is the single
  // statement that either performs the transition or does nothing.
  const changed = db.prepare(`UPDATE outbox_authority
    SET attempt_authority = 'ATTEMPT', revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE singleton = 1 AND attempt_authority = 'LEGACY' AND revision = ?
      AND email_dispatch_paused = 1 AND dispatch_owner_release_id = ?
      AND dispatch_owner_generation IS ?`)
    .run(input.expected_revision, epoch.release_id, epoch.generation ?? null);
  assertOrFail(changed.changes === 1, "OUTBOX_AUTHORITY_REVISION_CONFLICT");

  const next = outboxAuthority(db);
  db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision)
    VALUES (?, 'AUTHORITY_ACTIVATED', ?, ?, ?, ?)`)
    .run(id(), epoch.release_id, epoch.generation ?? null, input.reason, next.revision);

  return {
    activated: true, replayed: false, revision: next.revision,
    backfilled, refreshed,
    settled_without_completion: settledWithoutCompletion,
    exhausted_without_timestamp: exhaustedWithoutTimestamp,
  };
};
