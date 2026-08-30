import type Database from "better-sqlite3";
import { parseUtcTimestamp } from "./utc-timestamp";

/**
 * Identity-bound evidence that the certification order's own mail was
 * dispatched under attempt authority.
 *
 * The population-level version of this proof - "settled_accepted went up" -
 * passes for the wrong reason. A late provider callback settling an unrelated
 * older SEND_UNKNOWN increments the same counter, so a broken ATTEMPT dispatch
 * path reads as green. This resolves the exact messages of the exact certified
 * order and reports facts about those attempts.
 *
 * The order id is resolved from the durable ledger, never accepted as an input.
 * An operator able to name the order could otherwise prove dispatch with an
 * unrelated one.
 *
 * The ordering comparison is done here rather than by the caller because the
 * two timestamps are in different formats: outbox_authority_events.created_at
 * is SQLite's CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS") while the runtime writes
 * ISO-8601 with an offset. Comparing those lexically is the unsound comparison
 * this codebase has already been bitten by once, so both go through
 * parseUtcTimestamp.
 */

export type CertificationDispatchMessage = {
  outbox_id: string;
  type: string;
  status: string;
  suppressed: boolean;
  superseded: boolean;
  attempt: {
    id: string;
    attempt_no: number;
    outcome: string | null;
    started_at: string | null;
    provider_request_started_at: string | null;
    completed_at: string | null;
    provider_job_id: string | null;
  } | null;
};

/**
 * Why the target is unusable, each one directly proven by the rows.
 *
 * `queued_unstarted === false` has several possible causes and only one of them
 * is "already started". Deriving that from the negation would put a stronger
 * claim in an append-only ledger than the evidence supports, so the cause is
 * computed explicitly or not named at all.
 */
export type CertificationDispatchTargetDefect =
  | "CERTIFICATION_DISPATCH_TARGET_MISSING"
  | "CERTIFICATION_DISPATCH_TARGET_ALL_SUPPRESSED"
  | "CERTIFICATION_DISPATCH_TARGET_ATTEMPT_MISSING"
  | "CERTIFICATION_DISPATCH_TARGET_ALREADY_SETTLED"
  | "CERTIFICATION_DISPATCH_TARGET_ALREADY_STARTED"
  | "CERTIFICATION_DISPATCH_TARGET_NOT_QUEUED_UNSTARTED";

export type CertificationDispatchEvidence = {
  release_id: string;
  order_id: string | null;
  unfenced_at: string | null;
  messages: CertificationDispatchMessage[];
  /** Null exactly when queued_unstarted is true. */
  target_defect: CertificationDispatchTargetDefect | null;
  /**
   * Ready to be the proof target: at least one message, and every one of them
   * carries attempt #1, unsettled and never started. Checked BEFORE activation,
   * because the existence of the proof target is knowable while the transfer is
   * still reversible.
   */
  queued_unstarted: boolean;
  /**
   * The proof itself: at least one of those exact attempts is ACCEPTED with its
   * send started after the durable DISPATCH_UNFENCED event, and none of them is
   * still sitting unstarted.
   */
  dispatched_after_unfence: boolean;
};

/**
 * Exact, terminal provider-refusal evidence for the post-activation recovery
 * seam.  This is intentionally narrower than the normal dispatch proof: an
 * ACCEPTED attempt proves completion, whereas this object proves the one
 * observed UniSender refusal that justifies containing a broken ATTEMPT plane.
 */
export type PostActivationEmailProviderDefectEvidence = {
  release_id: string;
  order_id: string | null;
  unfenced_at: string | null;
  ticket_attempt: {
    outbox_id: string;
    message_status: string;
    message_delivery_outcome: string | null;
    attempt_count: number;
    attempt_id: string | null;
    attempt_no: number | null;
    outcome: string | null;
    started_at: string | null;
    failure_code: string | null;
    provider_error_code: string | null;
  } | null;
  /** True only for the exact evidence this recovery is permitted to record. */
  exact: boolean;
};

/** The order id from the durable CERTIFIED transition, or null if not certified. */
const certifiedOrderId = (db: Database.Database, releaseId: string): string | null => {
  const events = db.prepare("SELECT details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC")
    .all(releaseId) as Array<{ details_json: string }>;
  let orderId: string | null = null;
  for (const event of events) {
    try {
      const envelope = JSON.parse(event.details_json) as { certification_evidence?: { order_id?: unknown } };
      const candidate = envelope.certification_evidence?.order_id;
      // Last wins: a recovered generation recertifies, and the proof belongs to
      // the certification this epoch actually ended on.
      if (typeof candidate === "string" && candidate) orderId = candidate;
    } catch { continue; }
  }
  return orderId;
};

/**
 * This epoch's unfence, not the newest one in the table.
 *
 * Fence ownership serializes unfence, so today there is no normal path on which
 * another epoch's event could be read here - but every other read in this
 * module is bound to the certified order, and an identity-bound proof that
 * takes one global maximum has a hole waiting for the next change.
 */
const lastUnfenceAt = (db: Database.Database, releaseId: string): string | null => {
  const row = db.prepare(`SELECT created_at FROM outbox_authority_events
    WHERE action = 'DISPATCH_UNFENCED' AND owner_release_id = ? AND owner_generation IS NULL
    ORDER BY revision DESC, created_at DESC LIMIT 1`).get(releaseId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
};

const after = (value: string | null, boundary: string | null): boolean => {
  if (!value || !boundary) return false;
  const at = parseUtcTimestamp(value);
  const from = parseUtcTimestamp(boundary);
  return at !== null && from !== null && at >= from;
};

/** This recovery needs a strict ordering, not the inclusive completion proof. */
const strictlyAfter = (value: string | null, boundary: string | null): boolean => {
  if (!value || !boundary) return false;
  const at = parseUtcTimestamp(value);
  const from = parseUtcTimestamp(boundary);
  return at !== null && from !== null && at > from;
};

const providerErrorCode = (failureDetail: unknown): string | null => {
  if (typeof failureDetail !== "string") return null;
  try {
    const parsed = JSON.parse(failureDetail) as { provider_error_code?: unknown };
    return typeof parsed.provider_error_code === "string" ? parsed.provider_error_code : null;
  } catch { return null; }
};

/**
 * Ordered from the most specific cause to the least, so the first match is the
 * one the rows actually prove. The final case is the honest fallback: the target
 * is not queued-and-unstarted and this function cannot say more than that.
 */
const targetDefect = (
  all: CertificationDispatchMessage[],
  live: CertificationDispatchMessage[],
): CertificationDispatchTargetDefect | null => {
  if (all.length === 0) return "CERTIFICATION_DISPATCH_TARGET_MISSING";
  if (live.length === 0) return "CERTIFICATION_DISPATCH_TARGET_ALL_SUPPRESSED";
  if (live.some((message) => message.attempt === null || message.attempt.attempt_no !== 1)) return "CERTIFICATION_DISPATCH_TARGET_ATTEMPT_MISSING";
  if (live.some((message) => message.attempt!.outcome !== null)) return "CERTIFICATION_DISPATCH_TARGET_ALREADY_SETTLED";
  if (live.some((message) => message.attempt!.started_at !== null || message.attempt!.provider_request_started_at !== null)) return "CERTIFICATION_DISPATCH_TARGET_ALREADY_STARTED";
  return null;
};

export const certificationDispatchEvidence = (db: Database.Database, releaseId: string): CertificationDispatchEvidence => {
  const orderId = certifiedOrderId(db, releaseId);
  const unfencedAt = lastUnfenceAt(db, releaseId);
  const empty = {
    release_id: releaseId, order_id: orderId, unfenced_at: unfencedAt, messages: [],
    target_defect: "CERTIFICATION_DISPATCH_TARGET_MISSING" as const,
    queued_unstarted: false, dispatched_after_unfence: false,
  };
  if (!orderId) return empty;
  const attemptStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox_attempt'").get();
  if (!attemptStore) return empty;

  // Bound to the order through payload_ref, which is what every order-scoped
  // enqueue carries, plus the payload itself for the templates that reference
  // the order indirectly.
  const rows = db.prepare(`SELECT o.id, o.type, o.status, o.suppressed_at, o.superseded_at,
      a.id AS attempt_id, a.attempt_no, a.outcome, a.started_at, a.provider_request_started_at,
      a.completed_at, a.provider_job_id
    FROM email_outbox o
    LEFT JOIN outbox_attempt a ON a.message_id = o.id AND a.attempt_no = 1
    WHERE o.payload_ref = ? OR json_extract(o.payload_snapshot, '$.order_id') = ?
    ORDER BY o.created_at, o.id`).all(orderId, orderId) as Array<Record<string, unknown>>;

  const messages: CertificationDispatchMessage[] = rows.map((row) => ({
    outbox_id: String(row.id),
    type: String(row.type),
    status: String(row.status),
    suppressed: row.suppressed_at !== null,
    superseded: row.superseded_at !== null,
    attempt: row.attempt_id === null || row.attempt_id === undefined ? null : {
      id: String(row.attempt_id),
      attempt_no: Number(row.attempt_no),
      outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
      started_at: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
      provider_request_started_at: row.provider_request_started_at === null || row.provider_request_started_at === undefined ? null : String(row.provider_request_started_at),
      completed_at: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
      provider_job_id: row.provider_job_id === null || row.provider_job_id === undefined ? null : String(row.provider_job_id),
    },
  }));

  const live = messages.filter((message) => !message.suppressed && !message.superseded);
  const queued_unstarted = live.length > 0 && live.every((message) =>
    message.attempt !== null && message.attempt.attempt_no === 1 && message.attempt.outcome === null
    && message.attempt.started_at === null && message.attempt.provider_request_started_at === null);
  const dispatched_after_unfence = live.length > 0
    && live.some((message) => message.attempt?.outcome === "ACCEPTED" && after(message.attempt.started_at, unfencedAt))
    // Nothing left behind: a partially dispatched backlog is not a proof.
    && live.every((message) => message.attempt !== null && message.attempt.started_at !== null);

  return { release_id: releaseId, order_id: orderId, unfenced_at: unfencedAt, messages, target_defect: targetDefect(messages, live), queued_unstarted, dispatched_after_unfence };
};

/**
 * Recomputes the recovery evidence from durable order, outbox, attempt and
 * authority-event rows. No order, message, failure code or provider response
 * is accepted from a controller request.
 */
export const postActivationEmailProviderDefectEvidence = (db: Database.Database, releaseId: string): PostActivationEmailProviderDefectEvidence => {
  const orderId = certifiedOrderId(db, releaseId);
  const unfencedAt = lastUnfenceAt(db, releaseId);
  const empty = {
    release_id: releaseId, order_id: orderId, unfenced_at: unfencedAt,
    ticket_attempt: null, exact: false,
  };
  if (!orderId) return empty;
  const attemptStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox_attempt'").get();
  if (!attemptStore) return empty;

  // One order may create several messages, but the release proof target is its
  // one live contractual TICKET. Multiple live TICKET rows are ambiguous, not
  // an invitation to select whichever happened to be refused.
  const rows = db.prepare(`SELECT o.id AS outbox_id, o.status AS message_status, o.delivery_outcome AS message_delivery_outcome,
      (SELECT COUNT(*) FROM outbox_attempt attempts WHERE attempts.message_id = o.id) AS attempt_count,
      a.id AS attempt_id, a.attempt_no, a.outcome, a.started_at, a.failure_code, a.failure_detail
    FROM email_outbox o
    LEFT JOIN outbox_attempt a ON a.message_id = o.id AND a.attempt_no = 1
    WHERE (o.payload_ref = ? OR json_extract(o.payload_snapshot, '$.order_id') = ?)
      AND o.type = 'TICKET' AND o.suppressed_at IS NULL AND o.superseded_at IS NULL
    ORDER BY o.created_at, o.id`).all(orderId, orderId) as Array<Record<string, unknown>>;
  if (rows.length !== 1) return empty;
  const row = rows[0];
  const ticket_attempt = {
    outbox_id: String(row.outbox_id),
    message_status: String(row.message_status),
    message_delivery_outcome: row.message_delivery_outcome === null || row.message_delivery_outcome === undefined ? null : String(row.message_delivery_outcome),
    // `1` proves both that the failed certification attempt is attempt #1 and
    // that no later resend can have accepted or remain unsettled.
    attempt_count: Number(row.attempt_count),
    attempt_id: row.attempt_id === null || row.attempt_id === undefined ? null : String(row.attempt_id),
    attempt_no: row.attempt_no === null || row.attempt_no === undefined ? null : Number(row.attempt_no),
    outcome: row.outcome === null || row.outcome === undefined ? null : String(row.outcome),
    started_at: row.started_at === null || row.started_at === undefined ? null : String(row.started_at),
    failure_code: row.failure_code === null || row.failure_code === undefined ? null : String(row.failure_code),
    provider_error_code: providerErrorCode(row.failure_detail),
  };
  const exact = ticket_attempt.message_status === "FAILED" && ticket_attempt.message_delivery_outcome === "KNOWN_FAILED"
    && ticket_attempt.attempt_count === 1 && ticket_attempt.attempt_id !== null && ticket_attempt.attempt_no === 1
    && strictlyAfter(ticket_attempt.started_at, unfencedAt)
    && ticket_attempt.outcome === "KNOWN_FAILED"
    && ticket_attempt.failure_code === "UNISENDER_HTTP_REJECTED"
    && ticket_attempt.provider_error_code === "1588";
  return { release_id: releaseId, order_id: orderId, unfenced_at: unfencedAt, ticket_attempt, exact };
};
