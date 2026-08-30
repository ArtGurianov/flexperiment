import type Database from "better-sqlite3";
import { canonical, canonicalV2, decryptTicketCapability, emailHash, encryptTicketCapability, id, now, publicId, publicOrderNumber, sha256 } from "./crypto";
import { EmailProviderRejectedError, EventDumpCreateRejectedError, isEmailDeliveryEvidenceProvider, type EmailProvider, type UnisenderDumpEvent, UNISENDER_EVENT_DUMP_EVENT_LIMIT, UnconfiguredEmailProvider } from "./email-provider";
import { parseLegalManifest, type LegalManifest } from "./legal-manifest";
import { LegalReleasePublishError, loadCanonicalLegalRelease, publishLegalRelease, verifyCurrentLegalSourceHashes } from "./legal-release";
import { providerErrorEvidence, type PaymentProvider } from "./provider";
import { ReleaseControlError, ReleaseSalesGate, type CandidateAcquireRequest, type CandidateAdoptRequest, type CandidateAbortRequest, type CandidateCompleteRequest, type CandidateHeadSnapshot, type CandidatePhaseRequest, type CertificationEvidenceRequest, type CertificationLeaseRequest, type CertificationOrderContext, type CertificationRetryRequest, type ReleaseControlRequest, type RuntimeReadinessDefectRequest, releaseRuntimeEvidence } from "./release-control";
import { checkoutRequestSchema, promoMergedSchema, type CheckoutRequest, type ParticipantAgeBand } from "./types";
import { PromoPricingError, pricePromo } from "./promo-pricing";
import { basisPointsOf } from "./basis-points";
import { findCityBySlug } from "../../lib/city-catalog";
import { purchaseStatus, type PurchaseStatus } from "./purchase-status";
import { parseUtcTimestamp } from "./utc-timestamp";
import { assertNewOrdersOpen as assertGateOpen, emergencySalesPaused as gateEmergencyPaused, newOrdersBlocked as gateBlocked } from "./sales-gate";
import { claimForDispatch, deferAmbiguousObservation, deferAmbiguousSend, dispatchCandidates, failExhaustedAmbiguous, providerLookupIdentity, recordProviderAcceptance, recordProviderRefusal, applyProviderObservation, claimedAttemptRef, reconcileHistoricalHttp403, resolveAttemptRef, skipObsoletePendingMessage, supersedeQueuedMessage, suppressMessageDispatch, sendTryCount, staleLeasedSends, type AttemptRef } from "./outbox-attempt-store";
import { activateAttemptAuthority as runAttemptAuthorityActivation, activationEvidence } from "./outbox-activation";
import { OutboxAuthorityError, emailDispatchDrained, emailDispatchFenced, fenceEmailDispatch, lastAuthorityEvent, outboxAuthority, unfenceEmailDispatch, unknownAppliedMigrations, type DispatchEpoch } from "./outbox-authority";

type Row = Record<string, unknown>;
const one = <T extends Row>(db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined;
const many = <T extends Row>(db: Database.Database, sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[];
const legalManifest = (raw: unknown): LegalManifest => {
  try { return parseLegalManifest(raw); }
  catch { throw new DomainError("LEGAL_RELEASE_INVALID", 503); }
};

export class DomainError extends Error {
  constructor(readonly code: string, readonly status = 400, message = code) { super(message); }
}

/** Event Dump is deliberately slow recovery, never a replacement send path. */
export const UNISENDER_EVENT_DUMP_GRACE_MS = 5 * 60 * 1_000;
export const UNISENDER_EVENT_DUMP_POLL_MS = 15 * 1_000;
export const UNISENDER_EVENT_DUMP_REEXPORT_MS = 5 * 60 * 1_000;
export const UNISENDER_EVENT_DUMP_MAX_POLL_BACKOFF_MS = 2 * 60 * 1_000;
export const UNISENDER_EVENT_DUMP_MAX_CREATES_PER_EIGHT_HOURS = 9;
/** Keep a conservative slot below Unisender's documented max of ten dumps. */
export const UNISENDER_EVENT_DUMP_MAX_EXISTING_PROVIDER_DUMPS = 9;
export const UNISENDER_EVENT_DUMP_MAX_POLL_ATTEMPTS = 20;
export const UNISENDER_EVENT_DUMP_CREATE_PROBE_INITIAL_BACKOFF_MS = 5 * 60 * 1_000;
export const UNISENDER_EVENT_DUMP_CREATE_PROBE_MAX_BACKOFF_MS = 60 * 60 * 1_000;

export function withImmediateTransaction<T>(db: Database.Database, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const result = operation(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

const isPromoEligible = (promo: Row | undefined) => Boolean(promo && promo.status === "ACTIVE" && (promo.agent_id === null || promo.agent_enabled === 1));
const activeAgentBySlug = (db: Database.Database, slug: string | undefined) => slug
  ? one(db, "SELECT id, slug, default_reward_type, default_reward_value FROM agents WHERE slug = ? AND enabled = 1", slug)
  : undefined;
const promoPrice = (price: number, type: unknown, value: unknown) => {
  try { return pricePromo(price, type, value); }
  catch (error) {
    if (error instanceof PromoPricingError) throw new DomainError(error.code, error.code === "PROMO_ZERO_PRICE_NOT_ALLOWED" ? 409 : 422);
    throw error;
  }
};
const isMinorAgeBand = (ageBand: ParticipantAgeBand) => ageBand !== "ADULT";
const requiresAccompanimentForAgeBand = (ageBand: ParticipantAgeBand) => ageBand === "MINOR_UNDER_14";
const checkoutRequestHashV2 = (input: CheckoutRequest) => `v2:${sha256(canonicalV2(input))}`;
type DirectAnonymousCheckoutRequest = Omit<CheckoutRequest, "participant_age_band"> & { participant_age_band: string };
type CheckoutInput = DirectAnonymousCheckoutRequest;

// HTTP callers already pass this schema; direct domain callers use the same
// strict authority, so they cannot silently discard deprecated fields or hash
// a differently-normalized request.
const normalizeCheckoutInput = (input: unknown): CheckoutRequest => {
  const parsed = checkoutRequestSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("CHECKOUT_REQUEST_INVALID", 422);
  return parsed.data;
};

const formatOccurrenceDateTime = (value: unknown, timeZone: unknown) => {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return "уточняется";
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone: String(timeZone || "UTC") }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};

export type PublicOccurrence = {
  id: string;
  city: string;
  city_title: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  price_kopecks: number;
  availability: number;
  sales_status: "OPEN" | "PAUSED" | "CLOSED";
  fulfillment_status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  purchase_status: PurchaseStatus;
  venue: {
    status: "CONFIRMED" | "TO_BE_ANNOUNCED";
    name: string | null;
    address: string | null;
    disclosure_text: string | null;
    announce_by: string | null;
  };
};

const nullableString = (value: unknown) => value == null ? null : String(value);

/**
 * The marketing catalogue is intentionally narrower than both the occurrence
 * row and checkout's immutable venue disclosure. In particular,
 * `venue_public` is enforced here and never leaves the API as a client-side
 * policy flag.
 */
export const publicOccurrence = (occurrence: Row, newOrdersBlocked: boolean, nowMs: number): PublicOccurrence => {
  const venueStatus = occurrence.venue_status === "TO_BE_ANNOUNCED" ? "TO_BE_ANNOUNCED" : "CONFIRMED";
  const exposeConfirmedVenue = venueStatus === "CONFIRMED" && Number(occurrence.venue_public) === 1;
  const salesStatus = occurrence.sales_status === "PAUSED" ? "PAUSED" : occurrence.sales_status === "CLOSED" ? "CLOSED" : "OPEN";
  const fulfillmentStatus = occurrence.fulfillment_status === "COMPLETED" ? "COMPLETED" : occurrence.fulfillment_status === "CANCELLED" ? "CANCELLED" : "SCHEDULED";
  return {
    id: String(occurrence.id),
    city: String(occurrence.city),
    city_title: String(occurrence.city_title),
    title: String(occurrence.title),
    starts_at: String(occurrence.starts_at),
    ends_at: String(occurrence.ends_at),
    timezone: String(occurrence.timezone),
    price_kopecks: Number(occurrence.price_kopecks),
    availability: Number(occurrence.availability),
    sales_status: salesStatus,
    fulfillment_status: fulfillmentStatus,
    purchase_status: purchaseStatus({
      salesStatus,
      fulfillmentStatus,
      startsAtMs: parseUtcTimestamp(String(occurrence.starts_at)),
      nowMs,
      availability: Number(occurrence.availability),
      newOrdersBlocked,
    }),
    venue: venueStatus === "CONFIRMED"
      ? { status: venueStatus, name: exposeConfirmedVenue ? nullableString(occurrence.venue_name) : null, address: exposeConfirmedVenue ? nullableString(occurrence.venue_address) : null, disclosure_text: null, announce_by: null }
      : { status: venueStatus, name: null, address: null, disclosure_text: nullableString(occurrence.venue_disclosure_text), announce_by: nullableString(occurrence.venue_announce_by) },
  };
};

const occurrenceState = (occurrence: Row) => `${occurrence.visibility}:${occurrence.sales_status}`;
const allowedOccurrenceStateTransitions = new Set([
  // One-way recovery for legacy rows written before the SQLite invariant.
  "HIDDEN:OPEN->HIDDEN:CLOSED",
  "HIDDEN:PAUSED->HIDDEN:CLOSED",
  "HIDDEN:CLOSED->PUBLISHED:CLOSED",
  "PUBLISHED:CLOSED->PUBLISHED:OPEN",
  "PUBLISHED:CLOSED->HIDDEN:CLOSED",
  "PUBLISHED:OPEN->PUBLISHED:PAUSED",
  "PUBLISHED:OPEN->PUBLISHED:CLOSED",
  "PUBLISHED:PAUSED->PUBLISHED:OPEN",
  "PUBLISHED:PAUSED->PUBLISHED:CLOSED",
]);

const isAllowedOccurrenceStateTransition = (before: Row, after: Row) => {
  const previous = occurrenceState(before);
  const next = occurrenceState(after);
  return previous === next || allowedOccurrenceStateTransitions.has(`${previous}->${next}`);
};

type OccurrenceCustomerSnapshot = {
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  venue_status: "CONFIRMED" | "TO_BE_ANNOUNCED";
  venue_name: string | null;
  venue_address: string | null;
  venue_disclosure_text: string | null;
  venue_announce_by: string | null;
};

export type OccurrenceRevisionClassification = {
  changed: boolean;
  notificationMaterial: boolean;
  refundMaterial: boolean;
  materialChanges: Array<{ kind: string; field: keyof OccurrenceCustomerSnapshot; before: unknown; after: unknown }>;
  before: OccurrenceCustomerSnapshot;
  after: OccurrenceCustomerSnapshot;
};

type CorruptOccurrenceNotification = { outboxId: string; revisionId: string };
type PendingOccurrenceUpdateBaseline =
  | { before: OccurrenceCustomerSnapshot; revisionIds: string[]; recoveredCorruptNotifications: CorruptOccurrenceNotification[]; corruptNotifications?: never }
  | { before?: never; revisionIds?: never; recoveredCorruptNotifications?: never; corruptNotifications: CorruptOccurrenceNotification[] };

const occurrenceCustomerSnapshot = (value: Row): OccurrenceCustomerSnapshot => ({
  title: String(value.title),
  starts_at: String(value.starts_at),
  ends_at: String(value.ends_at),
  timezone: String(value.timezone),
  venue_status: value.venue_status === "CONFIRMED" ? "CONFIRMED" : "TO_BE_ANNOUNCED",
  venue_name: value.venue_name == null ? null : String(value.venue_name),
  venue_address: value.venue_address == null ? null : String(value.venue_address),
  venue_disclosure_text: value.venue_disclosure_text == null ? null : String(value.venue_disclosure_text),
  venue_announce_by: value.venue_announce_by == null ? null : String(value.venue_announce_by),
});

const isOccurrenceCustomerSnapshot = (value: unknown): value is OccurrenceCustomerSnapshot => {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.title === "string"
    && typeof snapshot.starts_at === "string"
    && typeof snapshot.ends_at === "string"
    && typeof snapshot.timezone === "string"
    && (snapshot.venue_status === "CONFIRMED" || snapshot.venue_status === "TO_BE_ANNOUNCED")
    && [null, "string"].includes(snapshot.venue_name === null ? null : typeof snapshot.venue_name)
    && [null, "string"].includes(snapshot.venue_address === null ? null : typeof snapshot.venue_address)
    && [null, "string"].includes(snapshot.venue_disclosure_text === null ? null : typeof snapshot.venue_disclosure_text)
    && [null, "string"].includes(snapshot.venue_announce_by === null ? null : typeof snapshot.venue_announce_by);
};

/**
 * Classifies persisted, normalized occurrence facts. It deliberately does not
 * infer commercial consequences from a requested patch: callers must persist
 * the candidate first and pass its resulting values here.
 */
export function classifyOccurrenceRevision(beforeValue: Row, afterValue: Row): OccurrenceRevisionClassification {
  const before = occurrenceCustomerSnapshot(beforeValue);
  const after = occurrenceCustomerSnapshot(afterValue);
  const fields = Object.keys(before) as Array<keyof OccurrenceCustomerSnapshot>;
  const kinds: Record<keyof OccurrenceCustomerSnapshot, string> = {
    title: "OCCURRENCE_TITLE_CHANGED",
    starts_at: "OCCURRENCE_START_CHANGED",
    ends_at: "OCCURRENCE_END_CHANGED",
    timezone: "OCCURRENCE_TIMEZONE_CHANGED",
    venue_status: "VENUE_STATUS_CHANGED",
    venue_name: "VENUE_NAME_CHANGED",
    venue_address: "VENUE_ADDRESS_CHANGED",
    venue_disclosure_text: "VENUE_DISCLOSURE_CHANGED",
    venue_announce_by: "VENUE_ANNOUNCEMENT_DEADLINE_CHANGED",
  };
  const materialChanges = fields.filter((field) => before[field] !== after[field])
    .map((field) => ({ kind: kinds[field], field, before: before[field], after: after[field] }));
  const changed = materialChanges.length > 0;
  const changedField = (field: keyof OccurrenceCustomerSnapshot) => before[field] !== after[field];
  const confirmedVenueChanged = before.venue_status === "CONFIRMED" && (
    after.venue_status !== "CONFIRMED"
    || changedField("venue_name")
    || changedField("venue_address")
  );
  const deadlineMovedLater = before.venue_announce_by !== null
    && after.venue_announce_by !== null
    && new Date(after.venue_announce_by).getTime() > new Date(before.venue_announce_by).getTime();
  return {
    changed,
    notificationMaterial: changed,
    refundMaterial: changedField("starts_at")
      || changedField("ends_at")
      || changedField("timezone")
      || confirmedVenueChanged
      || deadlineMovedLater,
    materialChanges,
    before,
    after,
  };
}

// A stale PREPARED allocation is an operational-review condition, never a
// timeout-based cancellation. Keep this explicit and shared by the worker and
// Admin read model.
export const STALE_PREPARED_SETTLEMENT_MS = 30 * 60 * 1_000;
export const CITY_INTEREST_SWEEP_BATCH_SIZE = 50;
export const EMAIL_SEND_UNKNOWN_MAX_ATTEMPTS = 8;
export const EMAIL_SEND_UNKNOWN_INITIAL_BACKOFF_MS = 60 * 1_000;
export const EMAIL_SEND_UNKNOWN_MAX_BACKOFF_MS = 60 * 60 * 1_000;
export const CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS = 8;
export const CREATE_UNKNOWN_LOOKUP_WINDOW_MS = 8 * 24 * 60 * 60 * 1_000;
export const CREATE_UNKNOWN_LOOKUP_INITIAL_BACKOFF_MS = 60 * 1_000;
export const CREATE_UNKNOWN_LOOKUP_MAX_BACKOFF_MS = 60 * 60 * 1_000;
export const EMAIL_ATTENTION_STATUSES = ["FAILED", "BOUNCED", "SEND_UNKNOWN"] as const;
const emailAttentionStatusUnqualifiedSql = "status IN ('FAILED', 'BOUNCED', 'SEND_UNKNOWN')";
const emailAttentionStatusSql = `e.${emailAttentionStatusUnqualifiedSql}`;
const emailAttentionPredicateSql = `${emailAttentionStatusSql} AND e.ops_acknowledged_at IS NULL`;
const emailAttentionSql = (where: string) => `SELECT
    e.id, e.type, e.status, e.attempts, e.created_at, e.sent_at, e.delivered_at, e.bounced_at,
    e.provider_error_code, e.provider_error_message,
    e.ops_acknowledged_at, e.ops_acknowledged_reason,
    CASE WHEN ${emailAttentionPredicateSql} THEN 1 ELSE 0 END AS requires_attention,
    COALESCE(direct_order.id, ticket_order.id, refund_order.id) AS order_id,
    COALESCE(direct_order.public_order_number, ticket_order.public_order_number, refund_order.public_order_number) AS public_order_number
  FROM email_outbox e
  LEFT JOIN orders direct_order ON direct_order.id = e.payload_ref
  LEFT JOIN tickets ticket ON ticket.id = e.payload_ref
  LEFT JOIN bookings ticket_booking ON ticket_booking.id = ticket.booking_id
  LEFT JOIN orders ticket_order ON ticket_order.id = ticket_booking.order_id
  LEFT JOIN refunds refund ON refund.id = e.payload_ref
  LEFT JOIN orders refund_order ON refund_order.id = refund.order_id
  WHERE ${where}
  ORDER BY e.ops_acknowledged_at IS NULL DESC, e.created_at DESC, e.id DESC`;

const cityInterestExpiry = (timestamp: string) => {
  const date = new Date(timestamp);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString();
};

export class CommerceDomain {
  constructor(
    readonly db: Database.Database,
    readonly provider: PaymentProvider,
    readonly emailProvider: EmailProvider = new UnconfiguredEmailProvider(),
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Joins the caller's transaction via a nested savepoint, or opens one.
   *
   * Suppression and supersession are reached both from inside the claim
   * transaction and from bare lifecycle sweeps, so neither "the caller has a
   * transaction" nor "the caller does not" is an invariant. Same shape as
   * enqueueEmail, for the same reason.
   */
  private atomically<T>(operation: () => T): T {
    const run = this.db.transaction(operation);
    return this.db.inTransaction ? run() : run.immediate();
  }

  private releaseSalesGate() { return new ReleaseSalesGate(this.db); }

  // Enforcement itself lives in sales-gate.ts so the release-sensitive surface
  // stays nameable: this file changes for ordinary work, that one does not.
  /**
   * Read-only, and public so the release controller can observe the operator's
   * emergency latch without holding admin credentials. Latching stays an admin
   * action: a release controller able to stop sales would also be able to
   * refund, cancel and mutate, which is far wider authority than driving a
   * release needs. Observation is enough to refuse to complete into open sales.
   */
  emergencySalesPaused() { return gateEmergencyPaused(this.db); }

  /**
   * Outbox authority control. Fencing email dispatch is a deployment-mechanism
   * act, not a business one: it delays mail during an authority migration and
   * touches nothing a customer can buy, refund or cancel. It is therefore held
   * by release control rather than admin - unlike the emergency sales stop,
   * which is absolute and business-facing and stays with an operator.
   *
   * There is deliberately no method here that moves attempt_authority.
   */
  /**
   * The whole outbox control surface a cutover controller needs, in one read:
   * the durable selector, drain evidence, the last authority transition, and
   * store convergence.
   *
   * `attempts` is null on a runtime without the attempt table, and that is
   * load-bearing - before the 0041-aware candidate is live, the field's absence
   * is what proves the old runtime is still answering.
   */
  outboxAuthority() {
    return {
      ...outboxAuthority(this.db),
      dispatch: emailDispatchDrained(this.db),
      last_event: lastAuthorityEvent(this.db),
      attempts: activationEvidence(this.db),
    };
  }

  /**
   * Mapped here rather than in the HTTP layer, the way ReleaseControlError is:
   * DomainError lives in this module, so outbox-authority.ts cannot import it
   * without a cycle. Without the mapping an owner conflict surfaced as HTTP 500
   * INTERNAL_ERROR - the refusal was correct and its reason was discarded,
   * which is the same defect the shared release API client was built to fix,
   * one layer lower.
   */
  private mapOutboxAuthority<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (error instanceof OutboxAuthorityError) throw new DomainError(error.code, error.status, error.message);
      throw error;
    }
  }

  fenceEmailDispatch(input: { expected_revision: number; reason: string }, epoch: DispatchEpoch) {
    return this.mapOutboxAuthority(() =>
      withImmediateTransaction(this.db, () => ({ ...fenceEmailDispatch(this.db, input, epoch), dispatch: emailDispatchDrained(this.db) })));
  }

  /**
   * The one-way LEGACY -> ATTEMPT transfer. Held by release control, like the
   * fence, and for the same reason: it is a deployment-mechanism act, not a
   * business one.
   */
  activateAttemptAuthority(input: { expected_revision: number; reason: string }, epoch: DispatchEpoch) {
    return this.mapOutboxAuthority(() => withImmediateTransaction(this.db, () => runAttemptAuthorityActivation(this.db, epoch, input)));
  }

  unfenceEmailDispatch(input: { expected_revision: number; reason: string }, epoch: DispatchEpoch) {
    return this.mapOutboxAuthority(() =>
      withImmediateTransaction(this.db, () => ({ ...unfenceEmailDispatch(this.db, input, epoch), dispatch: emailDispatchDrained(this.db) })));
  }
  private newOrdersBlocked() { return gateBlocked(this.db); }

  releaseControlStatus() { return this.releaseSalesGate().status(); }
  releaseControlCompletion(releaseId: string) { return this.releaseSalesGate().completion(releaseId); }
  promoCandidateHead(): CandidateHeadSnapshot {
    try { return this.releaseSalesGate().candidateHead(); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  acquireReleaseControl(input: ReleaseControlRequest) {
    try { return this.releaseSalesGate().acquire(input); }
    catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      throw error;
    }
  }

  acquirePromoCandidate(input: CandidateAcquireRequest) {
    try { return this.releaseSalesGate().acquireCandidate(input); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  adoptPromoCandidate(input: CandidateAdoptRequest) {
    try { return this.releaseSalesGate().adoptCandidate(input); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  changePromoCandidatePhase(input: CandidatePhaseRequest) {
    try { return this.releaseSalesGate().changeCandidatePhase(input); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  markPromoCandidateRuntimeReadinessDefect(input: RuntimeReadinessDefectRequest) {
    try { return this.releaseSalesGate().markRuntimeReadinessDefect(input, () => this.releaseRuntimeEvidence()); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  abortPromoCandidate(input: CandidateAbortRequest) {
    try { return this.releaseSalesGate().abortCandidate(input, () => this.releaseRuntimeEvidence()); }
    catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      throw error;
    }
  }

  completePromoCandidate(input: CandidateCompleteRequest) {
    try { return this.releaseSalesGate().completeCandidate(input, () => this.releaseRuntimeEvidence()); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  activatePromoCertificationLease(input: CertificationLeaseRequest) {
    try { return this.releaseSalesGate().activateCertificationLease(input); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  certifyPromoCandidate(input: CertificationEvidenceRequest) {
    try { return this.releaseSalesGate().certifyCandidate(input); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  retryPromoCertification(input: CertificationRetryRequest) {
    try { return this.releaseSalesGate().retryCertification(input); }
    catch (error) { if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status); throw error; }
  }

  pauseNewOrders(input: ReleaseControlRequest) {
    try { return this.releaseSalesGate().pause(input); }
    catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      throw error;
    }
  }

  replayCheckout(input: unknown, idempotencyKey: string) {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", 400);
    const replay = one(this.db, `SELECT ci.canonical_request_hash, o.public_status_id AS status_id, p.state, p.status, p.payment_url
      FROM checkout_idempotency ci JOIN orders o ON o.id = ci.order_id JOIN payments p ON p.order_id = o.id
      WHERE ci.idempotency_key_hash = ?`, sha256(idempotencyKey));
    if (!replay) throw new DomainError("IDEMPOTENCY_REPLAY_NOT_FOUND", 404);
    if (!String(replay.canonical_request_hash).startsWith("v2:")) throw new DomainError("IDEMPOTENCY_CONTRACT_SUPERSEDED", 409);
    const parsed = checkoutRequestSchema.safeParse(input);
    const matches = parsed.success && replay.canonical_request_hash === checkoutRequestHashV2(parsed.data);
    if (!matches) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
    return this.checkoutResult(replay);
  }

  updateReleaseControlExpectations(input: ReleaseControlRequest) {
    try { return this.releaseSalesGate().updateExpectations(input); }
    catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      throw error;
    }
  }

  publishCandidateLegalRelease(input: ReleaseControlRequest) {
    try {
      this.releaseSalesGate().assertPausedOwner(input);
      const filename = `commerce/legal/production-manifest.${input.expected.legal_version}.draft.json`;
      const candidate = loadCanonicalLegalRelease(filename);
      if (candidate.version !== input.expected.legal_version) throw new DomainError("LEGAL_CANDIDATE_VERSION_MISMATCH", 409);
      const result = publishLegalRelease(this.db, candidate, { expectedManifestSha256: input.expected.legal_manifest_sha256 });
      return { ...result, release_id: input.release_id };
    } catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      if (error instanceof LegalReleasePublishError) throw new DomainError(error.code, 409);
      throw error;
    }
  }

  assertNewOrdersOpen(context?: CertificationOrderContext) {
    try { return assertGateOpen(this.db, context); }
    catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      throw error;
    }
  }

  releaseRuntimeEvidence() {
    return releaseRuntimeEvidence(this.db, {
      sourceCommit: process.env.SOURCE_COMMIT,
      currentLegalCopiesMatch: (manifest) => {
        try { verifyCurrentLegalSourceHashes(manifest); return true; } catch { return false; }
      },
    });
  }

  reopenNewOrders(input: ReleaseControlRequest) {
    try { return this.releaseSalesGate().reopen(input, this.releaseRuntimeEvidence()); }
    catch (error) {
      if (error instanceof ReleaseControlError) throw new DomainError(error.code, error.status);
      throw error;
    }
  }

  private publicOccurrences(where: string, options: { catalogue: boolean }, ...params: unknown[]) {
    const newOrdersBlocked = this.newOrdersBlocked();
    const nowMs = this.clock();
    return many(this.db, `SELECT
        o.id, c.slug AS city, c.title AS city_title, o.title, o.starts_at, o.ends_at,
        o.timezone, o.price_kopecks, o.sales_status, o.fulfillment_status,
        o.venue_status, o.venue_name, o.venue_address, o.venue_public,
        o.venue_disclosure_text, o.venue_announce_by,
        (o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED'))) AS availability
      FROM cities c
      JOIN occurrences o ON o.city_id = c.id
      WHERE o.visibility = 'PUBLISHED'
        ${options.catalogue ? "AND o.fulfillment_status = 'SCHEDULED'" : ""}
        AND ${where}
      ORDER BY c.title, o.starts_at`, ...params)
      .map((entry) => publicOccurrence(entry, newOrdersBlocked, nowMs))
      .filter((entry) => !options.catalogue || parseUtcTimestamp(entry.starts_at) > nowMs);
  }

  tour() {
    return this.publicOccurrences("1 = 1", { catalogue: true });
  }

  occurrence(occurrenceId: string) {
    const found = this.publicOccurrences("o.id = ?", { catalogue: false }, occurrenceId)[0];
    if (!found) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    return found;
  }

  legalConfig() {
    const release = one(this.db, "SELECT id, version, effective_at, manifest_json FROM legal_releases WHERE active = 1");
    if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
    const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
    return { ...release, manifest, occurrence_notifications_available: this.occurrenceNotificationsAvailable(manifest, String(release.version)) };
  }

  private occurrenceNotificationsAvailable(manifest?: LegalManifest, activeVersion?: string) {
    const active = manifest ?? (() => {
      const release = one(this.db, "SELECT manifest_json, version FROM legal_releases WHERE active = 1");
      if (release) activeVersion = String(release.version);
      return release ? legalManifest(JSON.parse(String(release.manifest_json))) : undefined;
    })();
    if (!active || activeVersion !== "2026-08-28.1") return false;
    try { verifyCurrentLegalSourceHashes(active); } catch { return false; }
    return active.documents.PRIVACY_POLICY.sha256 === "642d11458733e8c1e5bfb28d0cde7f917a276dfcb3e32dc52adc34fac6326339"
      && active.documents.PD_CONSENT.sha256 === "acdb8a31a846c1c697cfd977fb67f24e75d280ab72cb6fbce5bbf0146d4ba5b6";
  }

  salesControl() {
    const emergency = one(this.db, `SELECT sales_paused, revision, paused_at, paused_reason, paused_by_admin_id
      FROM emergency_sales_gate WHERE singleton = 1`)!;
    let releasePaused: boolean;
    try { this.releaseSalesGate().assertNewOrdersOpen(); releasePaused = false; }
    catch (error) { if (error instanceof ReleaseControlError) releasePaused = true; else throw error; }
    return {
      id: "emergency-sales-gate", effective_status: this.emergencySalesPaused() || releasePaused ? "PAUSED" : "OPEN",
      emergency: { sales_paused: Boolean(emergency.sales_paused), revision: Number(emergency.revision), paused_at: emergency.paused_at, paused_reason: emergency.paused_reason, paused_by_admin_id: emergency.paused_by_admin_id },
      release_paused: releasePaused,
    };
  }

  pauseEmergencySales(input: { expected_revision: number; reason: string }, adminId: string, idempotencyKey: string) {
    return this.withAdminCommandV2("emergency-sales-pause", idempotencyKey, adminId, "emergency-sales-gate", input, input.reason, "EMERGENCY_SALES_PAUSED", "emergency_sales_gate", () => {
      const timestamp = new Date(this.clock()).toISOString();
      const changed = this.db.prepare(`UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1,
        paused_at = ?, paused_reason = ?, paused_by_admin_id = ?, updated_at = ? WHERE singleton = 1 AND revision = ?`).run(timestamp, input.reason, adminId, timestamp, input.expected_revision).changes;
      if (!changed) throw new DomainError("SALES_GATE_REVISION_CONFLICT", 409);
      const gate = one(this.db, "SELECT revision FROM emergency_sales_gate WHERE singleton = 1")!;
      this.db.prepare("INSERT INTO emergency_sales_gate_events(id, action, admin_id, reason, revision) VALUES (?, 'PAUSED', ?, ?, ?)").run(id(), adminId, input.reason, gate.revision);
      return this.salesControl();
    });
  }

  reopenEmergencySales(input: { expected_revision: number; reason: string }, adminId: string, idempotencyKey: string) {
    return this.withAdminCommandV2("emergency-sales-reopen", idempotencyKey, adminId, "emergency-sales-gate", input, input.reason, "EMERGENCY_SALES_REOPENED", "emergency_sales_gate", () => {
      const timestamp = new Date(this.clock()).toISOString();
      const changed = this.db.prepare(`UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1,
        reopened_at = ?, updated_at = ? WHERE singleton = 1 AND revision = ?`).run(timestamp, timestamp, input.expected_revision).changes;
      if (!changed) throw new DomainError("SALES_GATE_REVISION_CONFLICT", 409);
      const gate = one(this.db, "SELECT revision FROM emergency_sales_gate WHERE singleton = 1")!;
      this.db.prepare("INSERT INTO emergency_sales_gate_events(id, action, admin_id, reason, revision) VALUES (?, 'REOPENED', ?, ?, ?)").run(id(), adminId, input.reason, gate.revision);
      return this.salesControl();
    });
  }

  emailAttentionCount() {
    return Number(one(this.db, `SELECT COUNT(*) AS count FROM email_outbox e
      WHERE ${emailAttentionPredicateSql}`)?.count ?? 0);
  }

  emailAttentionIncidents() {
    return many(this.db, emailAttentionSql(emailAttentionStatusSql));
  }

  operationalIncidents(status?: "OPEN" | "RESOLVED") {
    // The incident itself stays immutable evidence. This read model adds the
    // current operational context an administrator needs to investigate it.
    return many(this.db, `SELECT incident.*,
        refund.public_id AS refund_public_id,
        refund.amount_kopecks AS refund_amount_kopecks,
        refund.status AS refund_status,
        refund.provider_reference AS refund_provider_reference,
        refund.last_error AS refund_last_error,
        ord.id AS order_id,
        ord.public_order_number,
        ord.customer_email,
        payment.provider_payment_id,
        payment.status AS payment_status
      FROM operational_incidents incident
      LEFT JOIN refunds refund
        ON incident.entity_type = 'refund' AND refund.id = incident.entity_id
      LEFT JOIN orders ord
        ON ord.id = CASE WHEN incident.entity_type = 'refund' THEN refund.order_id
                         WHEN incident.entity_type = 'order' THEN incident.entity_id
                    END
      LEFT JOIN payments payment
        ON payment.id = refund.payment_id
      ${status ? "WHERE incident.status = ?" : ""}
      ORDER BY incident.status = 'OPEN' DESC, incident.created_at DESC, incident.id DESC`, ...(status ? [status] : []));
  }

  operationalIncidentCount() {
    return Number(one(this.db, "SELECT COUNT(*) AS count FROM operational_incidents WHERE status = 'OPEN'")?.count ?? 0);
  }

  resolveOperationalIncident(incidentId: string, note?: string) {
    return withImmediateTransaction(this.db, () => {
      const changed = this.db.prepare(`UPDATE operational_incidents
        SET status = 'RESOLVED', resolution_note = ?, resolved_at = ?
      WHERE id = ? AND status = 'OPEN'`).run(note ?? null, now(), incidentId).changes;
      if (!changed) throw new DomainError("OPERATIONAL_INCIDENT_NOT_OPEN", 409);
      return one(this.db, "SELECT * FROM operational_incidents WHERE id = ?", incidentId)!;
    });
  }

  /** Worker-safe, idempotent operational signal for overdue TBA venues. */
  detectOverdueVenueAnnouncements() {
    return withImmediateTransaction(this.db, () => {
      const timestamp = new Date(this.clock()).toISOString();
      // A venue confirmation, cancellation, or completion resolves the open
      // incident; historical evidence remains available for review.
      this.db.prepare(`UPDATE operational_incidents
        SET status = 'RESOLVED', resolution_note = 'Venue announced or occurrence terminal', resolved_at = ?
        WHERE kind = 'VENUE_ANNOUNCEMENT_OVERDUE' AND status = 'OPEN'
          AND EXISTS (SELECT 1 FROM occurrences o WHERE o.id = operational_incidents.entity_id
            AND (o.venue_status = 'CONFIRMED' OR o.fulfillment_status <> 'SCHEDULED'))`).run(timestamp);
      const overdue = many(this.db, `SELECT id, venue_announce_by, starts_at
        FROM occurrences
        WHERE fulfillment_status = 'SCHEDULED' AND venue_status = 'TO_BE_ANNOUNCED'
          AND venue_announce_by < ?`, timestamp);
      for (const occurrence of overdue) {
        this.openOperationalIncident("VENUE_ANNOUNCEMENT_OVERDUE", "occurrence", String(occurrence.id),
          `venue-overdue:${occurrence.id}:${occurrence.venue_announce_by}`,
          { occurrence_id: occurrence.id, venue_announce_by: occurrence.venue_announce_by, starts_at: occurrence.starts_at });
      }
      return overdue.length;
    });
  }

  private openOperationalIncident(
    kind: "REFUND_REQUIRES_REVIEW" | "ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW" | "VENUE_ANNOUNCEMENT_OVERDUE" | "OCCURRENCE_NOTIFICATION_PAYLOAD_CORRUPT",
    entityType: "refund" | "order" | "occurrence",
    entityId: string,
    incidentKey: string,
    details: Record<string, unknown>,
  ) {
    this.db.prepare(`INSERT OR IGNORE INTO operational_incidents(
      id, incident_key, kind, entity_type, entity_id, details_json
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(id(), incidentKey, kind, entityType, entityId, JSON.stringify(details));
  }

  /**
   * A corrupt pending outbox copy needs continued operator attention until it
   * is either superseded using its linked immutable revision or remediated.
   * Reopening is deliberately scoped to this corruption signal: resolving an
   * incident without repairing an unrecoverable row must not hide it forever.
   */
  private openOccurrenceNotificationPayloadCorruptionIncident(input: {
    occurrenceId: string;
    bookingId: string;
    orderId: string;
    blockedRevisionId: string;
    corrupt: CorruptOccurrenceNotification;
    recoveredFromRevision: boolean;
  }) {
    const incidentKey = `occurrence-notification-payload-corrupt:${input.corrupt.outboxId}`;
    const details = JSON.stringify({
      occurrence_id: input.occurrenceId,
      booking_id: input.bookingId,
      order_id: input.orderId,
      blocked_revision_id: input.blockedRevisionId,
      corrupt_outbox_id: input.corrupt.outboxId,
      corrupt_occurrence_revision_id: input.corrupt.revisionId,
      recovered_from_occurrence_revision: input.recoveredFromRevision,
    });
    this.db.prepare(`INSERT INTO operational_incidents(
      id, incident_key, kind, entity_type, entity_id, details_json
    ) VALUES (?, ?, 'OCCURRENCE_NOTIFICATION_PAYLOAD_CORRUPT', 'occurrence', ?, ?)
    ON CONFLICT(incident_key) DO UPDATE SET
      status = 'OPEN', details_json = excluded.details_json,
      resolution_note = NULL, resolved_at = NULL
    WHERE operational_incidents.kind = 'OCCURRENCE_NOTIFICATION_PAYLOAD_CORRUPT'`)
      .run(id(), incidentKey, input.occurrenceId, details);
  }

  private resolveOperationalIncidents(entityType: "refund" | "order" | "occurrence", entityId: string, note: string) {
    this.db.prepare(`UPDATE operational_incidents
      SET status = 'RESOLVED', resolution_note = COALESCE(resolution_note, ?), resolved_at = COALESCE(resolved_at, ?)
      WHERE entity_type = ? AND entity_id = ? AND status = 'OPEN'`).run(note, now(), entityType, entityId);
  }

  acknowledgeEmailAttention(outboxId: string, auditContext?: string) {
    return withImmediateTransaction(this.db, () => {
      const acknowledgedReason = auditContext?.trim() || null;
      const outbox = one(this.db, `SELECT id, status, ops_acknowledged_at
        FROM email_outbox WHERE id = ?`, outboxId);
      if (!outbox) throw new DomainError("EMAIL_OUTBOX_NOT_FOUND", 404);
      if (outbox.ops_acknowledged_at === null) {
        if (!EMAIL_ATTENTION_STATUSES.includes(outbox.status as typeof EMAIL_ATTENTION_STATUSES[number])) {
          throw new DomainError("EMAIL_ATTENTION_NOT_ACTIONABLE", 409);
        }
        this.db.prepare(`UPDATE email_outbox
          SET ops_acknowledged_at = ?, ops_acknowledged_reason = ?
          WHERE id = ? AND ops_acknowledged_at IS NULL`).run(now(), acknowledgedReason, outboxId);
      }
      const incident = one(this.db, `${emailAttentionSql("e.id = ?")} LIMIT 1`, outboxId);
      return { incident: incident!, acknowledged_now: outbox.ops_acknowledged_at === null };
    });
  }

  /** Exceptional local operator correction; never changes delivery evidence. */
  clearEmailOperationalAcknowledgement(outboxId: string) {
    return withImmediateTransaction(this.db, () => this.db.prepare(`UPDATE email_outbox
      SET ops_acknowledged_at = NULL, ops_acknowledged_reason = NULL
      WHERE id = ?
        AND ops_acknowledged_at IS NOT NULL
        AND ${emailAttentionStatusUnqualifiedSql}`).run(outboxId).changes > 0);
  }

  registerCityInterest(input: { email: string; city: string }) {
    return withImmediateTransaction(this.db, () => {
      const city = findCityBySlug(input.city);
      if (!city) throw new DomainError("CITY_SLUG_UNKNOWN", 400);
      const release = one(this.db, "SELECT manifest_json FROM legal_releases WHERE active = 1");
      if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
      const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
      const timestamp = new Date(this.clock()).toISOString();
      const expiresAt = cityInterestExpiry(timestamp);
      const normalizedEmailHash = emailHash(input.email);
      const existing = one(this.db, `SELECT id FROM city_interest_requests
        WHERE email_hash = ? AND city_slug = ? AND superseded_at IS NULL`, normalizedEmailHash, city.slug);

      if (existing && this.canRenewCityInterestNotification(String(existing.id))) {
        // The replacement and redaction are one transaction: a failed epoch
        // cannot remain current after its successor becomes visible. The old
        // row remains solely as a non-PII anchor for immutable outbox/event
        // evidence and its superseded intent relation.
        const replacementId = id();
        this.db.prepare(`UPDATE city_interest_notification_intents
          SET superseded_at = ?
          WHERE city_interest_request_id = ? AND superseded_at IS NULL`).run(timestamp, existing.id);
        this.db.prepare(`UPDATE city_interest_requests
          SET email_normalized = '', email_hash = '', superseded_at = ?,
              superseded_by_request_id = ?
          WHERE id = ? AND superseded_at IS NULL`).run(timestamp, replacementId, existing.id);
        this.insertCityInterestRequest({
          requestId: replacementId, email: input.email, emailHash: normalizedEmailHash,
          citySlug: city.slug, manifest, timestamp, expiresAt,
        });
      } else if (existing) {
        // An active, indeterminate, suppressed, or already-completed intent
        // is never turned into a new epoch by a re-submit. Refresh only the
        // explicit consent evidence on its still-current source request.
        this.db.prepare(`UPDATE city_interest_requests
          SET email_normalized = ?, privacy_policy_version = ?,
              privacy_policy_sha256 = ?, pd_consent_version = ?,
              pd_consent_sha256 = ?, consent_accepted_at = ?, created_at = ?,
              expires_at = ?
          WHERE id = ? AND superseded_at IS NULL`).run(
          input.email, manifest.documents.PRIVACY_POLICY.version, manifest.documents.PRIVACY_POLICY.sha256,
          manifest.documents.PD_CONSENT.version, manifest.documents.PD_CONSENT.sha256,
          timestamp, timestamp, expiresAt, existing.id,
        );
      } else {
        this.insertCityInterestRequest({
          requestId: id(), email: input.email, emailHash: normalizedEmailHash,
          citySlug: city.slug, manifest, timestamp, expiresAt,
        });
      }
      this.consumeEligibleCityInterests(city.slug, CITY_INTEREST_SWEEP_BATCH_SIZE);
      return { accepted: true };
    });
  }

  registerOccurrenceNotification(input: { email: string; occurrence_id: string }) {
    return withImmediateTransaction(this.db, () => {
      if (!this.occurrenceNotificationsAvailable()) throw new DomainError("NOTIFICATIONS_NOT_AVAILABLE", 503);
      const occurrence = one(this.db, `SELECT o.*, o.capacity - (SELECT COUNT(*) FROM bookings b
        WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) AS availability
        FROM occurrences o WHERE o.id = ? AND o.visibility = 'PUBLISHED'`, input.occurrence_id);
      if (!occurrence || occurrence.fulfillment_status !== "SCHEDULED" || parseUtcTimestamp(String(occurrence.starts_at)) <= this.clock()) {
        throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      }
      const status = purchaseStatus({
        salesStatus: occurrence.sales_status === "PAUSED" ? "PAUSED" : occurrence.sales_status === "CLOSED" ? "CLOSED" : "OPEN",
        fulfillmentStatus: "SCHEDULED", startsAtMs: parseUtcTimestamp(String(occurrence.starts_at)), nowMs: this.clock(),
        availability: Number(occurrence.availability), newOrdersBlocked: this.newOrdersBlocked(),
      });
      if (status === "AVAILABLE") throw new DomainError("OCCURRENCE_ALREADY_AVAILABLE", 409);
      const release = one(this.db, "SELECT manifest_json FROM legal_releases WHERE active = 1");
      if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
      const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
      const timestamp = new Date(this.clock()).toISOString();
      const hash = emailHash(input.email);
      const existing = one(this.db, `SELECT id FROM occurrence_notification_requests
        WHERE email_hash = ? AND occurrence_id = ? AND superseded_at IS NULL`, hash, input.occurrence_id);
      if (existing && this.canRenewOccurrenceNotification(String(existing.id))) {
        const replacementId = id();
        this.db.prepare(`UPDATE occurrence_notification_intents SET superseded_at = ?
          WHERE notification_request_id = ? AND superseded_at IS NULL`).run(timestamp, existing.id);
        this.db.prepare(`UPDATE occurrence_notification_requests
          SET email_normalized = '', email_hash = '', superseded_at = ?, superseded_by_request_id = ?
          WHERE id = ? AND superseded_at IS NULL`).run(timestamp, replacementId, existing.id);
        this.insertOccurrenceNotificationRequest({ requestId: replacementId, email: input.email, emailHash: hash, occurrenceId: input.occurrence_id, manifest, timestamp });
      } else if (existing) {
        this.db.prepare(`UPDATE occurrence_notification_requests SET email_normalized = ?, privacy_policy_version = ?,
          privacy_policy_sha256 = ?, pd_consent_version = ?, pd_consent_sha256 = ?, consent_accepted_at = ?, created_at = ?
          WHERE id = ? AND superseded_at IS NULL`).run(input.email,
          manifest.documents.PRIVACY_POLICY.version, manifest.documents.PRIVACY_POLICY.sha256,
          manifest.documents.PD_CONSENT.version, manifest.documents.PD_CONSENT.sha256, timestamp, timestamp, existing.id);
      } else {
        this.insertOccurrenceNotificationRequest({ requestId: id(), email: input.email, emailHash: hash, occurrenceId: input.occurrence_id, manifest, timestamp });
      }
      this.consumeEligibleOccurrenceNotifications(50);
      return { accepted: true };
    });
  }

  processOccurrenceNotificationLifecycle() {
    return withImmediateTransaction(this.db, () => {
      const timestamp = new Date(this.clock()).toISOString();
      const terminated = many(this.db, `SELECT request.id, o.starts_at, o.fulfillment_status FROM occurrence_notification_requests request
        JOIN occurrences o ON o.id = request.occurrence_id
        WHERE request.superseded_at IS NULL
          AND (o.fulfillment_status = 'CANCELLED' OR julianday(o.starts_at) <= julianday(?))
        ORDER BY request.created_at LIMIT 50`, timestamp)
        .filter((request) => request.fulfillment_status === "CANCELLED" || parseUtcTimestamp(String(request.starts_at)) <= this.clock());
      for (const request of terminated) this.purgeOccurrenceNotificationRequest(String(request.id));
      return { deleted: terminated.length, intents_created: this.consumeEligibleOccurrenceNotifications(50) };
    });
  }

  /** Applies expiry before scanning for newly eligible requests. */
  processCityInterestLifecycle() {
    return withImmediateTransaction(this.db, () => {
      const timestamp = new Date(this.clock()).toISOString();
      const expired = many(this.db, `SELECT id FROM city_interest_requests
        WHERE superseded_at IS NULL AND expires_at <= ?
        ORDER BY expires_at LIMIT ?`, timestamp, CITY_INTEREST_SWEEP_BATCH_SIZE);
      for (const row of expired) this.purgeCityInterestRequest(String(row.id));
      const intentsCreated = this.consumeEligibleCityInterests(undefined, CITY_INTEREST_SWEEP_BATCH_SIZE, timestamp);
      return { expired_deleted: expired.length, intents_created: intentsCreated };
    });
  }

  withdrawNotificationConsent(email: string, reason: string, adminId: string) {
    return withImmediateTransaction(this.db, () => {
      const requests = many(this.db, "SELECT id FROM city_interest_requests WHERE email_hash = ? AND superseded_at IS NULL", emailHash(email));
      for (const request of requests) this.purgeCityInterestRequest(String(request.id));
      const occurrenceRequests = many(this.db, "SELECT id FROM occurrence_notification_requests WHERE email_hash = ? AND superseded_at IS NULL", emailHash(email));
      for (const request of occurrenceRequests) this.purgeOccurrenceNotificationRequest(String(request.id));
      // Retain only aggregate operator evidence: never an email or its hash.
      this.db.prepare("INSERT INTO admin_audit_log(id, admin_id, action, entity_type, entity_id, details_json) VALUES (?, ?, 'NOTIFICATION_CONSENT_WITHDRAWN', 'notification_consent', 'all-matching-requests', ?)")
        .run(id(), adminId, JSON.stringify({ reason, city_interest_deleted: requests.length, occurrence_notification_deleted: occurrenceRequests.length }));
      return { withdrawn: true, city_interest_deleted: requests.length, occurrence_notification_deleted: occurrenceRequests.length };
    });
  }

  /** Compatibility alias for existing operational runbooks and integrations. */
  withdrawCityInterest(email: string, reason: string, adminId: string) {
    const result = this.withdrawNotificationConsent(email, reason, adminId);
    return { withdrawn: result.withdrawn, deleted_count: result.city_interest_deleted };
  }

  checkoutContext(input: { occurrenceId: string; promoCode?: string; referralSlug?: string }) {
    return withImmediateTransaction(this.db, () => {
      const occurrence = one(this.db, "SELECT * FROM occurrences WHERE id = ?", input.occurrenceId);
      let promo: Row | undefined;
      if (input.promoCode) {
        promo = one(this.db, `SELECT p.*, a.enabled AS agent_enabled FROM promo_codes p
          LEFT JOIN agents a ON a.id = p.agent_id WHERE p.normalized_code = ?`, input.promoCode.trim().toUpperCase());
      }
      // During the global pause the gate is intentionally consulted before
      // revealing fixture-specific errors; it only receives opaque IDs.
      const certificationLease = this.assertNewOrdersOpen({ occurrence_id: occurrence ? String(occurrence.id) : input.occurrenceId, promo_id: promo?.id ? String(promo.id) : null });
      if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (input.promoCode && !promo) throw new DomainError("PROMO_NOT_FOUND", 404);
      if (promo && !isPromoEligible(promo)) throw new DomainError("PROMO_NOT_ELIGIBLE", 409);
      if (!certificationLease && occurrence.visibility !== "PUBLISHED") throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (!certificationLease && (occurrence.sales_status !== "OPEN" || occurrence.fulfillment_status !== "SCHEDULED")) throw new DomainError("SALES_NOT_OPEN", 409);
      if (certificationLease && occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("SALES_NOT_OPEN", 409);
      const release = one(this.db, "SELECT * FROM legal_releases WHERE active = 1");
      if (!release) throw new DomainError("LEGAL_RELEASE_NOT_ACTIVE", 503);
      const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
      const availability = Number(occurrence.capacity) - Number(one(this.db, "SELECT COUNT(*) AS occupied FROM bookings WHERE occurrence_id = ? AND status IN ('RESERVED', 'CONFIRMED')", occurrence.id)?.occupied ?? 0);
      if (availability <= 0) throw new DomainError("SOLD_OUT", 409);
      // The first-party landing capture owns the 30-day lifetime. Checkout only
      // revalidates the established marker's currently eligible promoter.
      const referralAgent = activeAgentBySlug(this.db, input.referralSlug);
      const promoAgentId = promo?.agent_id as string | null ?? null;
      const attributedAgentId: string | null = promoAgentId ?? (referralAgent?.id as string | undefined) ?? null;
      const referralSlug = referralAgent?.slug as string | undefined;
      const price = Number(occurrence.price_kopecks);
      const pricing = promo ? promoPrice(price, promo.discount_type, promo.discount_value) : { discountKopecks: 0, finalAmountKopecks: price };
      const quoteId = id();
      const disclosure = occurrence.venue_status === "CONFIRMED"
        ? `${occurrence.venue_name}: ${occurrence.venue_address}`
        : `${String(occurrence.venue_disclosure_text)} Сообщим адрес участникам на email не позднее ${formatOccurrenceDateTime(occurrence.venue_announce_by, occurrence.timezone)}.`;
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO quotes(id, occurrence_id, material_revision, legal_release_id, promo_id, attributed_agent_id, price_kopecks, discount_kopecks, final_amount_kopecks, venue_disclosure, expires_at, referral_slug, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot, promo_agent_id_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(quoteId, occurrence.id, occurrence.material_revision, release.id, promo?.id ?? null, attributedAgentId, price, pricing.discountKopecks, pricing.finalAmountKopecks, disclosure, expiresAt, referralSlug ?? null, promo?.code ?? null, promo?.discount_type ?? null, promo?.discount_value ?? null, promoAgentId);
      return { quote_id: quoteId, occurrence_id: occurrence.id, material_revision: occurrence.material_revision, availability, price_kopecks: price, discount_kopecks: pricing.discountKopecks, final_amount_kopecks: pricing.finalAmountKopecks, promo: promo ? { id: promo.id, code: promo.code, discount_type: promo.discount_type, discount_value: promo.discount_value, discount_kopecks: pricing.discountKopecks } : null, currency: "RUB", venue_disclosure: disclosure, legal_release: { id: release.id, version: release.version, manifest }, expires_at: expiresAt };
    });
  }

  checkout(input: CheckoutInput, idempotencyKey: string, acceptance: { ip?: string; userAgent?: string } = {}) {
    const checkoutInput = normalizeCheckoutInput(input);
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", 400);
    const keyHash = sha256(idempotencyKey);
    const requestHash = checkoutRequestHashV2(checkoutInput);
    const result = withImmediateTransaction(this.db, () => {
      const replay = one(this.db, `SELECT ci.canonical_request_hash, o.public_status_id AS status_id, p.state, p.status, p.payment_url
        FROM checkout_idempotency ci JOIN orders o ON o.id = ci.order_id JOIN payments p ON p.order_id = o.id WHERE ci.idempotency_key_hash = ?`, keyHash);
      if (replay) {
        if (!String(replay.canonical_request_hash).startsWith("v2:")) throw new DomainError("IDEMPOTENCY_CONTRACT_SUPERSEDED", 409);
        if (replay.canonical_request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
        return { replay: true, status_id: replay.status_id, state: replay.state, status: replay.status, payment_url: replay.payment_url };
      }
      const quote = one(this.db, "SELECT * FROM quotes WHERE id = ?", checkoutInput.quote_id);
      if (!quote) { this.assertNewOrdersOpen(); throw new DomainError("QUOTE_EXPIRED", 409); }
      const occurrence = one(this.db, "SELECT o.*, c.title AS city_title FROM occurrences o JOIN cities c ON c.id = o.city_id WHERE o.id = ?", quote.occurrence_id);
      if (!occurrence) { this.assertNewOrdersOpen(); throw new DomainError("QUOTE_STALE", 409); }
      const certificationLease = this.assertNewOrdersOpen({ occurrence_id: String(occurrence.id), promo_id: quote.promo_id ? String(quote.promo_id) : null, idempotency_key_hash: keyHash });
      if (new Date(String(quote.expires_at)).getTime() < Date.now()) throw new DomainError("QUOTE_EXPIRED", 409);
      if (occurrence.material_revision !== quote.material_revision) throw new DomainError("QUOTE_STALE", 409);
      if (checkoutInput.customer_adult_confirmed !== true) throw new DomainError("CUSTOMER_ADULT_CONFIRMATION_REQUIRED", 422);
      const participantAgeBand = checkoutInput.participant_age_band;
      const participantIsMinor = isMinorAgeBand(participantAgeBand);
      const participantRequiresAdultAccompaniment = requiresAccompanimentForAgeBand(participantAgeBand);
      if (participantIsMinor && checkoutInput.minor_legal_representative_confirmed !== true) {
        throw new DomainError("MINOR_LEGAL_REPRESENTATIVE_CONFIRMATION_REQUIRED", 422);
      }
      if (!participantIsMinor && checkoutInput.minor_legal_representative_confirmed !== undefined) {
        throw new DomainError("UNEXPECTED_MINOR_LEGAL_REPRESENTATIVE_CONFIRMATION", 422);
      }
      const release = one(this.db, "SELECT * FROM legal_releases WHERE active = 1");
      if (!release || release.id !== quote.legal_release_id) throw new DomainError("LEGAL_VERSION_CHANGED", 409);
      const manifest = legalManifest(JSON.parse(String(release.manifest_json)));
      let promo: Row | undefined;
      if (quote.promo_id) {
        promo = one(this.db, `SELECT p.*, a.enabled AS agent_enabled FROM promo_codes p LEFT JOIN agents a ON a.id = p.agent_id WHERE p.id = ?`, quote.promo_id);
        if (!promo || !isPromoEligible(promo)) throw new DomainError("PROMO_NO_LONGER_ELIGIBLE", 409);
        if (promo.discount_type !== quote.discount_type_snapshot || Number(promo.discount_value) !== Number(quote.discount_value_snapshot) || (promo.agent_id ?? null) !== (quote.promo_agent_id_snapshot ?? null)) throw new DomainError("QUOTE_STALE", 409);
      }
      if (!certificationLease && (occurrence.sales_status !== "OPEN" || occurrence.fulfillment_status !== "SCHEDULED")) throw new DomainError("SALES_NOT_OPEN", 409);
      if (certificationLease && occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("SALES_NOT_OPEN", 409);
      // Attribution is decided now, inside the checkout transaction. Quotes are
      // intentionally not eligibility authority: a promoter can be disabled
      // after context creation without entering a new order.
      const promoAgentId = promo?.agent_id as string | null ?? null;
      const referralAgent = activeAgentBySlug(this.db, quote.referral_slug as string | undefined);
      const attributedAgentId = promoAgentId ?? (referralAgent?.id as string | undefined) ?? null;
      const currentPricing = promo ? promoPrice(Number(occurrence.price_kopecks), promo.discount_type, promo.discount_value) : { discountKopecks: 0, finalAmountKopecks: Number(occurrence.price_kopecks) };
      if (currentPricing.discountKopecks !== Number(quote.discount_kopecks) || currentPricing.finalAmountKopecks !== Number(quote.final_amount_kopecks)) throw new DomainError("QUOTE_STALE", 409);
      const occupied = Number(one(this.db, "SELECT COUNT(*) AS occupied FROM bookings WHERE occurrence_id = ? AND status IN ('RESERVED', 'CONFIRMED')", occurrence.id)?.occupied ?? 0);
      if (occupied >= Number(occurrence.capacity)) throw new DomainError("SOLD_OUT", 409);
      const orderId = id(); const bookingId = id(); const paymentId = id(); const statusId = publicId();
      let orderNumber = publicOrderNumber();
      // The unique index is the authority; the lookup keeps the astronomically
      // unlikely random collision from surfacing as a customer-visible 500.
      while (one(this.db, "SELECT id FROM orders WHERE public_order_number = ?", orderNumber)) orderNumber = publicOrderNumber();
      const agent = attributedAgentId ? one(this.db, "SELECT default_reward_type, default_reward_value FROM agents WHERE id = ? AND enabled = 1", attributedAgentId) : undefined;
      const timestamp = now();
      const workshopDate = new Intl.DateTimeFormat("ru-RU", { timeZone: String(occurrence.timezone), day: "numeric", month: "long", year: "numeric" }).format(new Date(String(occurrence.starts_at)));
      const fiscalPurpose = "Оплата участия в мастер-классе ФЛЭКСПЕРИМЕНТ";
      const fiscalItemName = `Участие в мастер-классе ФЛЭКСПЕРИМЕНТ — ${String(occurrence.city_title)}, ${workshopDate}`;
      this.db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, attributed_agent_id, reward_type_snapshot, reward_value_snapshot, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot, promo_id_snapshot, promo_agent_id_snapshot, price_kopecks_snapshot, discount_kopecks_snapshot, fiscal_purpose_snapshot, fiscal_item_name_snapshot, public_offer_version, public_offer_sha256, public_offer_accepted_at, privacy_policy_version, privacy_policy_sha256, privacy_policy_presented_at, pd_consent_version, pd_consent_sha256, pd_consent_accepted_at, checkout_disclosure_version, checkout_disclosure_sha256, customer_adult_confirmed_at, customer_acceptance_ip, customer_acceptance_user_agent, participant_name, participant_age_band, participant_date_of_birth, participant_age_at_occurrence, participant_is_minor, participant_requires_adult_accompaniment, participant_is_customer, minor_legal_representative_confirmed_at, minor_legal_representative_confirmation_text, under_14_accompaniment_confirmed_at, under_14_accompaniment_confirmation_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        // SQLite baseline made this historical column NOT NULL. New anonymous
        // orders retain only an empty legacy value; no name is collected or
        // presented as order evidence.
        .run(orderId, statusId, orderNumber, occurrence.id, "", checkoutInput.customer_email.trim().toLowerCase(), emailHash(checkoutInput.customer_email), quote.final_amount_kopecks, quote.material_revision, quote.venue_disclosure, quote.legal_release_id, JSON.stringify(manifest), "DEPRECATED_NOT_EVIDENCE", attributedAgentId, agent?.default_reward_type ?? null, agent?.default_reward_value ?? null, quote.promo_code_snapshot ?? null, quote.discount_type_snapshot ?? null, quote.discount_value_snapshot ?? null, quote.promo_id ?? null, quote.promo_agent_id_snapshot ?? null, quote.price_kopecks, quote.discount_kopecks, fiscalPurpose, fiscalItemName, manifest.documents.PUBLIC_OFFER.version, manifest.documents.PUBLIC_OFFER.sha256, timestamp, manifest.documents.PRIVACY_POLICY.version, manifest.documents.PRIVACY_POLICY.sha256, timestamp, manifest.documents.PD_CONSENT.version, manifest.documents.PD_CONSENT.sha256, timestamp, manifest.documents.CHECKOUT_DISCLOSURE.version, manifest.documents.CHECKOUT_DISCLOSURE.sha256, timestamp, acceptance.ip ?? null, acceptance.userAgent?.slice(0, 1_000) ?? null, null, participantAgeBand, null, null, Number(participantIsMinor), Number(participantRequiresAdultAccompaniment), null, participantIsMinor ? timestamp : null, participantIsMinor ? "Я являюсь совершеннолетним законным представителем несовершеннолетнего участника, для которого оформляю этот заказ." : null, null, null);
      this.db.prepare("INSERT INTO bookings(id, order_id, occurrence_id, status) VALUES (?, ?, ?, 'RESERVED')").run(bookingId, orderId, occurrence.id);
      this.db.prepare(`INSERT INTO payments(id, order_id, state, status, provider_idempotency_key, creation_started_at) VALUES (?, ?, 'CREATING', 'PENDING', ?, ?)`)
        .run(paymentId, orderId, publicId(), timestamp);
      this.db.prepare("INSERT INTO checkout_idempotency(idempotency_key_hash, canonical_request_hash, order_id) VALUES (?, ?, ?)").run(keyHash, requestHash, orderId);
      if (certificationLease) this.releaseSalesGate().consumeCertificationLease({ occurrence_id: String(occurrence.id), promo_id: quote.promo_id ? String(quote.promo_id) : null, idempotency_key_hash: keyHash }, orderId);
      return { replay: false, order_id: orderId, payment_id: paymentId, status_id: statusId, amount_kopecks: Number(quote.final_amount_kopecks) };
    });
    if ("replay" in result && result.replay) return this.checkoutResult(result);
    // The transaction deliberately ends before the provider request. If the process
    // dies after commit, the durable CREATING command is recovered as CREATE_UNKNOWN.
    return { status_id: result.status_id, status: "PROCESSING" as const, payment_url: null };
  }

  /** Performs external payment creation only after checkout state has committed. */
  async checkoutAsync(input: CheckoutInput, idempotencyKey: string, successBaseUrl: string, acceptance: { ip?: string; userAgent?: string } = {}) {
    const first = this.checkout(input, idempotencyKey, acceptance);
    const payment = one(this.db, `SELECT p.*, p.id AS payment_id, o.id AS order_id, o.amount_kopecks, o.customer_email, o.fiscal_purpose_snapshot, o.fiscal_item_name_snapshot
      FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?`, first.status_id);
    if (!payment || payment.state !== "CREATING") return first;
    try {
      this.db.prepare("UPDATE payments SET provider_request_started_at = ?, updated_at = ? WHERE id = ? AND state = 'CREATING'").run(now(), now(), payment.payment_id);
      if (!payment.fiscal_item_name_snapshot || !payment.fiscal_purpose_snapshot) throw new Error("Order has no immutable fiscal snapshot.");
      const created = await this.provider.createPayment({ paymentId: String(payment.payment_id), paymentLinkId: String(payment.payment_id), amountKopecks: Number(payment.amount_kopecks), idempotencyKey: String(payment.provider_idempotency_key), successUrl: `${successBaseUrl}/payment/success?order=${first.status_id}`, customerEmail: String(payment.customer_email), purpose: String(payment.fiscal_purpose_snapshot), receiptItemName: String(payment.fiscal_item_name_snapshot) });
      this.db.prepare("UPDATE payments SET state = 'CREATED', provider_payment_id = ?, payment_url = ?, updated_at = ? WHERE id = ? AND state = 'CREATING'").run(created.providerPaymentId, created.paymentUrl, now(), payment.payment_id);
    } catch (error) {
      const evidence = providerErrorEvidence(error);
      this.db.prepare(`UPDATE payments
        SET state = 'CREATE_UNKNOWN', provider_error_class = ?, provider_error_code = ?, updated_at = ?
        WHERE id = ? AND state = 'CREATING'`).run(evidence.provider_error_class, evidence.provider_error_code, now(), payment.payment_id);
    }
    return this.checkoutStatus(String(first.status_id));
  }

  private checkoutResult(value: Row) {
    return { status_id: value.status_id, status: value.status === "PAID" ? "PAID" : value.state === "CREATE_FAILED" || value.status === "EXPIRED" || value.status === "CANCELLED" ? "FAILED" : "PROCESSING", payment_url: value.payment_url ?? null };
  }

  checkoutStatus(statusId: string) {
    const payment = one(this.db, `SELECT p.state, p.status, p.payment_url FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?`, statusId);
    if (!payment) throw new DomainError("CHECKOUT_NOT_FOUND", 404);
    return this.checkoutResult({ status_id: statusId, ...payment });
  }

  markPaymentPaid(paymentId: string, capturedAmount: number, providerPaymentId?: string) {
    return withImmediateTransaction(this.db, () => this.markPaymentPaidInTransaction(paymentId, capturedAmount, providerPaymentId));
  }

  private markPaymentPaidInTransaction(paymentId: string, capturedAmount: number, providerPaymentId?: string) {
      const payment = one(this.db, "SELECT p.*, o.occurrence_id, o.id AS order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?", paymentId);
      if (!payment) throw new DomainError("PAYMENT_NOT_FOUND", 404);
      if (payment.status === "PAID") return payment;
      this.db.prepare("UPDATE payments SET status = 'PAID', state = 'CREATED', captured_amount_kopecks = ?, provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ? WHERE id = ?").run(capturedAmount, providerPaymentId ?? null, now(), paymentId);
      const booking = one(this.db, "SELECT * FROM bookings WHERE order_id = ?", payment.order_id);
      const occurrence = one(this.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", payment.occurrence_id);
      if (booking?.status === "RESERVED" && occurrence?.fulfillment_status === "SCHEDULED") {
        this.db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ? AND status = 'RESERVED'").run(booking.id);
        const capability = publicId();
        const encrypted = encryptTicketCapability(capability);
        const order = one(this.db, `SELECT o.customer_email, o.customer_email_hash, o.public_order_number,
          o.participant_age_band, o.participant_requires_adult_accompaniment,
          oc.title, oc.starts_at, oc.ends_at, oc.timezone, oc.venue_status, oc.venue_name,
          oc.venue_address, oc.venue_disclosure_text, oc.venue_announce_by, c.title AS city_title
          FROM orders o JOIN occurrences oc ON oc.id = o.occurrence_id JOIN cities c ON c.id = oc.city_id
          WHERE o.id = ?`, payment.order_id)!;
        const ticketId = id();
        this.db.prepare(`INSERT INTO tickets(id, booking_id, status, capability_hash, capability_ciphertext, capability_nonce, key_version)
          VALUES (?, ?, 'VALID', ?, ?, ?, 1)`).run(ticketId, booking.id, sha256(capability), encrypted.ciphertext, encrypted.nonce);
        // The outbox references an immutable ticket row. A future Unisender worker
        // derives the actual URL from its encrypted capability at send time; the raw
        // capability is never copied to application logs or browser storage.
        this.enqueueEmail("TICKET", String(order.customer_email), String(order.customer_email_hash), "ticket", ticketId, {
          schema_version: 1,
          ticket_id: ticketId,
          order_id: payment.order_id,
          public_order_number: order.public_order_number,
          payment_confirmed: true,
          amount_kopecks: capturedAmount,
          participant_age_band: order.participant_age_band,
          participant_requires_adult_accompaniment: Boolean(order.participant_requires_adult_accompaniment),
          occurrence: occurrenceCustomerSnapshot(order),
          city_title: order.city_title,
        });
        this.syncRewardEvidence(String(payment.order_id));
      } else {
        const abandonment = one(this.db, "SELECT id FROM reservation_abandonments WHERE payment_id = ?", payment.id);
        const source = abandonment ? "LATE_PAYMENT_AFTER_RESERVATION_ABANDONMENT" : occurrence?.fulfillment_status === "SCHEDULED" ? "LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION" : "LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE";
        const obligation = this.upsertRefundObligation(String(payment.id), source, capturedAmount);
        if (abandonment) {
          this.db.prepare("UPDATE refund_obligations SET status = 'REVIEW_REQUIRED' WHERE id = ?").run(obligation.id);
          this.db.prepare("UPDATE reservation_abandonments SET status = 'LATE_PAYMENT_REVIEW_REQUIRED' WHERE id = ?").run(abandonment.id);
        }
      }
      return one(this.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
  }

  applyTochkaPaymentWebhook(input: { rawHash: string; operationId: string; paymentLinkId: string; amountKopecks: number; customerCode: string; merchantId: string; paymentType: string; status: string; webhookType: string; currency?: string }, expected: { customerCode: string; merchantId: string }) {
    return withImmediateTransaction(this.db, () => {
      const semanticKey = `${input.operationId}:${input.status}`;
      const known = one(this.db, "SELECT id, payload_hash, status, entity_id FROM provider_webhook_events WHERE provider = 'TOCHKA' AND semantic_key = ?", semanticKey);
      const payment = one(this.db, `SELECT p.*, o.amount_kopecks FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?`, input.paymentLinkId);
      const observed = JSON.stringify({ operation_id: input.operationId, payment_link_id: input.paymentLinkId, amount_kopecks: input.amountKopecks, payment_type: input.paymentType, status: input.status, webhook_type: input.webhookType, currency: input.currency ?? "RUB" });
      const valid = input.webhookType === "acquiringInternetPayment" && input.status === "APPROVED" && ["card", "sbp"].includes(input.paymentType) && (!input.currency || input.currency === "RUB") && input.customerCode === expected.customerCode && input.merchantId === expected.merchantId && payment && Number(payment.amount_kopecks) === input.amountKopecks;
      if (known) {
        if (known.payload_hash === input.rawHash) return { duplicate: true, applied: false };
        const knownVariant = one(this.db, `SELECT id FROM provider_webhook_event_conflicts
          WHERE provider = 'TOCHKA' AND semantic_key = ? AND payload_hash = ?`, semanticKey, input.rawHash);
        if (knownVariant) return { duplicate: true, applied: false };
        this.db.prepare(`INSERT INTO provider_webhook_event_conflicts(
          id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
        ) VALUES (?, 'TOCHKA', ?, ?, ?, ?, ?, ?)`)
          .run(id(), semanticKey, known.id, input.rawHash, "CONFLICT_QUARANTINED", payment?.id ?? known.entity_id ?? null, observed);
        const affectedPaymentId = payment?.id ?? known.entity_id;
        if (affectedPaymentId) this.recordProviderDrift("PAYMENT", String(affectedPaymentId), {
          webhook_semantic_key_collision: {
            semantic_key: semanticKey,
            original_event_id: known.id,
            original_status: known.status,
            incoming_payload_hash: input.rawHash,
          },
        });
        return { duplicate: false, applied: false, conflict: true };
      }
      if (!valid) {
        this.db.prepare("INSERT INTO provider_webhook_events(id, provider, semantic_key, payload_hash, status, entity_id, observed_json) VALUES (?, 'TOCHKA', ?, ?, 'QUARANTINED', ?, ?)").run(id(), semanticKey, input.rawHash, payment?.id ?? null, observed);
        if (payment) this.recordProviderDrift("PAYMENT", String(payment.id), { webhook: { operation_id: input.operationId, amount_kopecks: input.amountKopecks, payment_type: input.paymentType, status: input.status } });
        return { duplicate: false, applied: false };
      }
      this.db.prepare("INSERT INTO provider_webhook_events(id, provider, semantic_key, payload_hash, status, entity_id, observed_json) VALUES (?, 'TOCHKA', ?, ?, 'APPLIED', ?, ?)").run(id(), semanticKey, input.rawHash, payment.id, observed);
      this.markPaymentPaidInTransaction(String(payment.id), input.amountKopecks, input.operationId);
      return { duplicate: false, applied: true };
    });
  }

  upsertRefundObligation(paymentId: string, source: string, target: number) {
    const existing = one(this.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId);
    if (existing && target > Number(existing.target_refunded_amount_kopecks)) {
      // A fulfilled partial customer-cancellation obligation can later be
      // superseded by a higher organizer/terminal-occurrence target.  Reopen
      // only that fulfilled state so the worker can issue the remaining amount;
      // REVIEW_REQUIRED remains explicitly operator-owned.
      this.db.prepare(`UPDATE refund_obligations
        SET target_refunded_amount_kopecks = ?,
          status = CASE WHEN status = 'FULFILLED' THEN 'OPEN' ELSE status END,
          fulfilled_at = CASE WHEN status = 'FULFILLED' THEN NULL ELSE fulfilled_at END
        WHERE id = ?`).run(target, existing.id);
    } else if (!existing) {
      this.db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, ?, ?, 'OPEN')").run(id(), paymentId, source, target);
    }
    const obligation = one(this.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId)!;
    this.db.prepare("INSERT INTO refund_obligation_events(id, obligation_id, source) VALUES (?, ?, ?)").run(id(), obligation.id, source);
    return obligation;
  }

  /**
   * `refund_obligations.target_refunded_amount_kopecks` is a total target, not
   * a new command amount. The worker subtracts provider-confirmed successful
   * refunds before issuing a command. Keeping that unit here means a partial
   * historical refund and an organizer cancellation converge exactly to the
   * captured amount without ever over-refunding it.
   */
  private ensureFullCapturedRefund(paymentId: string, source: string, capturedTotal: number) {
    if (capturedTotal <= 0) return null;
    const succeeded = Number(one(this.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", paymentId)?.total ?? 0);
    if (succeeded >= capturedTotal) return one(this.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId) ?? null;
    const existing = one(this.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId);
    if (existing && Number(existing.target_refunded_amount_kopecks) >= capturedTotal) return existing;
    return this.upsertRefundObligation(paymentId, source, capturedTotal);
  }

  requestCustomerRefund(normalizedOrderNumber: string) {
    return withImmediateTransaction(this.db, () => {
      const order = one(this.db, `SELECT o.id, o.public_order_number, o.customer_email, o.customer_email_hash, p.id AS payment_id, p.status AS payment_status,
        p.captured_amount_kopecks, b.id AS booking_id, b.status AS booking_status, oc.fulfillment_status, oc.starts_at
        FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id
        JOIN occurrences oc ON oc.id = o.occurrence_id
        WHERE replace(upper(o.public_order_number), '-', '') = ?`, normalizedOrderNumber);
      const currentOrder = order && this.customerRefundOrder(String(order.id));
      if (!currentOrder) return { accepted: true };
      const eligibility = this.customerRefundEligibility(currentOrder);
      if (eligibility === "ORGANIZER_CHANGE_MANUAL_REVIEW") {
        this.openOperationalIncident(
          "ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW",
          "order",
          String(currentOrder.id),
          `organizer-change-refund-manual:${currentOrder.id}`,
          { order_id: currentOrder.id, booking_id: currentOrder.booking_id, reason: "OCCURRENCE_CHANGE_AFTER_START" },
        );
        return { accepted: true };
      }
      if (eligibility !== "ELIGIBLE" && eligibility !== "ORGANIZER_CHANGE_ELIGIBLE") return { accepted: true };

      // A later request can supersede only a definitely unsent capability.
      // Once the worker has claimed a message, its provider request may already
      // be in flight; retain that token rather than producing two usable links.
      this.db.prepare(`UPDATE customer_refund_confirmation_tokens
        SET invalidated_at = ?
        WHERE order_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
          AND EXISTS (
            SELECT 1 FROM email_outbox e
            WHERE e.type = 'CUSTOMER_REFUND_CONFIRMATION'
              AND e.payload_ref = customer_refund_confirmation_tokens.id
              AND e.status = 'PENDING'
          )`).run(now(), order.id);
      const reusable = one(this.db, `SELECT t.id
        FROM customer_refund_confirmation_tokens t
        WHERE t.order_id = ? AND t.consumed_at IS NULL AND t.invalidated_at IS NULL AND t.expires_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM email_outbox e
            WHERE e.type = 'CUSTOMER_REFUND_CONFIRMATION' AND e.payload_ref = t.id AND e.status = 'PENDING'
          )
        ORDER BY t.created_at DESC LIMIT 1`, order.id, new Date(this.clock()).toISOString());
      if (reusable) return { accepted: true };
      const capability = publicId();
      const encrypted = encryptTicketCapability(capability);
      const tokenId = id();
      const expiresAt = new Date(this.clock() + 30 * 60_000).toISOString();
      this.db.prepare(`INSERT INTO customer_refund_confirmation_tokens(id, token_hash, token_ciphertext, token_nonce, order_id, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(tokenId, sha256(capability), encrypted.ciphertext, encrypted.nonce, order.id, expiresAt);
      this.enqueueEmail("CUSTOMER_REFUND_CONFIRMATION", String(order.customer_email), String(order.customer_email_hash), "customer-refund-confirmation", tokenId, { order_id: order.id, public_order_number: order.public_order_number, expires_at: expiresAt });
      return { accepted: true };
    });
  }

  customerRefundConfirmationContext(capability: string) {
    const token = this.validCustomerRefundToken(capability);
    const order = this.customerRefundOrder(String(token.order_id));
    if (!order) throw new DomainError("REFUND_CONFIRMATION_INVALID", 404);
    const eligibility = this.customerRefundEligibility(order);
    return {
      order_number: order.public_order_number,
      occurrence: {
        title: order.occurrence_title,
        city: order.city_title,
        starts_at: order.starts_at,
        timezone: order.timezone,
      },
      amount_remaining_kopecks: Math.max(0, Number(order.captured_amount_kopecks) - Number(order.successful_refunded_amount_kopecks)),
      eligibility,
      ...(["ELIGIBLE", "ORGANIZER_CHANGE_ELIGIBLE"].includes(String(eligibility)) ? {} : { manual_contact: "art@flexperiment.ru" }),
      expires_at: token.expires_at,
    };
  }

  confirmCustomerRefund(capability: string) {
    return withImmediateTransaction(this.db, () => {
      const token = this.validCustomerRefundToken(capability);
      const order = this.customerRefundOrder(String(token.order_id));
      const eligibility = order && this.customerRefundEligibility(order);
      // A capability issued before the start must not silently become a
      // false denial after the start. The entitlement remains authoritative;
      // only a human may decide the post-start refund outcome.
      if (order && eligibility === "ORGANIZER_CHANGE_MANUAL_REVIEW") {
        this.openOperationalIncident(
          "ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW",
          "order",
          String(order.id),
          `organizer-change-refund-manual:${order.id}`,
          { order_id: order.id, booking_id: order.booking_id, reason: "OCCURRENCE_CHANGE_AFTER_START" },
        );
        return { confirmed: false, manual_review: true, manual_contact: "art@flexperiment.ru" };
      }
      if (!order || !["ELIGIBLE", "ORGANIZER_CHANGE_ELIGIBLE"].includes(String(eligibility))) throw new DomainError("REFUND_NOT_ELIGIBLE", 409);
      this.db.prepare("UPDATE customer_refund_confirmation_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), token.id);
      this.db.prepare("UPDATE customer_refund_confirmation_tokens SET invalidated_at = ? WHERE order_id = ? AND id <> ? AND consumed_at IS NULL AND invalidated_at IS NULL").run(now(), order.id, token.id);
      this.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'CUSTOMER_SELF_SERVICE_REFUND' WHERE id = ? AND status = 'CONFIRMED'").run(now(), order.booking_id);
      this.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), order.booking_id);
      this.supersedePendingOccurrenceUpdatesForBooking(String(order.booking_id), "BOOKING_CANCELLED");
      this.closeOccurrenceChangeRefundEntitlementsForBooking(String(order.booking_id), "BOOKING_CANCELLED");
      this.syncRewardEvidence(String(order.id));
      this.ensureFullCapturedRefund(String(order.payment_id), "CUSTOMER_SELF_SERVICE_REFUND", Number(order.captured_amount_kopecks));
      this.enqueueEmail("CUSTOMER_REFUND_CONFIRMED", String(order.customer_email), String(order.customer_email_hash), "customer-refund-confirmed", String(order.id), { order_id: order.id, public_order_number: order.public_order_number });
      return { confirmed: true };
    });
  }

  private validCustomerRefundToken(capability: string) {
    const token = one(this.db, "SELECT * FROM customer_refund_confirmation_tokens WHERE token_hash = ?", sha256(capability));
    if (!token || token.invalidated_at || token.consumed_at || new Date(String(token.expires_at)).getTime() <= this.clock()) throw new DomainError("REFUND_CONFIRMATION_INVALID", 404);
    return token;
  }

  private customerRefundOrder(orderId: string) {
    return one(this.db, `SELECT o.id, o.public_order_number, o.customer_email, o.customer_email_hash,
      p.id AS payment_id, p.status AS payment_status, p.captured_amount_kopecks,
      b.id AS booking_id, b.status AS booking_status,
      oc.fulfillment_status, oc.starts_at, oc.timezone, oc.title AS occurrence_title,
      c.title AS city_title,
      COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS successful_refunded_amount_kopecks,
      COALESCE((SELECT COUNT(*) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING')), 0) AS active_refund_count,
      COALESCE((SELECT COUNT(*) FROM refund_obligations ro WHERE ro.payment_id = p.id AND ro.status IN ('OPEN', 'FULFILLING', 'REVIEW_REQUIRED')), 0) AS active_obligation_count,
      EXISTS(SELECT 1 FROM occurrence_change_refund_entitlements e
        WHERE e.booking_id = b.id AND e.status = 'OPEN') AS organizer_change_refund_entitlement
      FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id
      JOIN occurrences oc ON oc.id = o.occurrence_id JOIN cities c ON c.id = oc.city_id
      WHERE o.id = ?`, orderId);
  }

  private customerRefundEligibility(order: Row) {
    if (order.fulfillment_status === "CANCELLED") return "OCCURRENCE_CANCELLED";
    if (order.fulfillment_status === "COMPLETED") return "OCCURRENCE_COMPLETED";
    const captured = Number(order.captured_amount_kopecks);
    const refunded = Number(order.successful_refunded_amount_kopecks);
    if (captured <= 0 || !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(String(order.payment_status))) return "NO_REFUND_DUE";
    if (refunded >= captured || order.payment_status === "REFUNDED") return "REFUND_COMPLETED";
    if (Number(order.active_refund_count) > 0 || Number(order.active_obligation_count) > 0) return "REFUND_PENDING";
    if (order.booking_status !== "CONFIRMED") return "ALREADY_CANCELLED";
    const startsAt = new Date(String(order.starts_at)).getTime();
    if (Number(order.organizer_change_refund_entitlement) === 1) {
      return this.clock() < startsAt ? "ORGANIZER_CHANGE_ELIGIBLE" : "ORGANIZER_CHANGE_MANUAL_REVIEW";
    }
    const deadline = startsAt - 60 * 60_000;
    if (this.clock() >= deadline) return "CUTOFF_REACHED";
    return "ELIGIBLE";
  }

  /** Read-only provider/TLS and documented payment-list contract evidence. */
  async providerReadiness() {
    return this.provider.probe();
  }

  orderEvidence(orderId: string) {
    // Deliberately redacted operational evidence: do not turn this endpoint
    // into an alternate customer/ticket-detail API.
    const order = one(this.db, `SELECT id, public_status_id, public_order_number, occurrence_id, amount_kopecks, currency, created_at,
      checkout_legal_release_id, public_offer_version, public_offer_sha256,
      privacy_policy_version, privacy_policy_sha256, pd_consent_version,
      pd_consent_sha256, checkout_disclosure_version, checkout_disclosure_sha256,
      customer_adult_confirmed_at, participant_age_band, participant_age_at_occurrence,
      participant_is_minor, participant_requires_adult_accompaniment, participant_is_customer,
      minor_legal_representative_confirmed_at, under_14_accompaniment_confirmed_at
      FROM orders WHERE id = ?`, orderId);
    if (!order) throw new DomainError("ORDER_NOT_FOUND", 404);
    const payment = one(this.db, "SELECT id, state, status, provider_payment_id, captured_amount_kopecks, provider_error_class, provider_error_code, created_at, updated_at, last_reconcile_at FROM payments WHERE order_id = ?", orderId);
    const booking = one(this.db, "SELECT id, status, created_at, cancelled_at FROM bookings WHERE order_id = ?", orderId);
    const ticket = booking ? one(this.db, "SELECT id, status, created_at, voided_at FROM tickets WHERE booking_id = ?", booking.id) ?? null : null;
    const obligation = payment ? one(this.db, `SELECT id, payment_id, initial_source,
      target_refunded_amount_kopecks, status, created_at, fulfilled_at
      FROM refund_obligations WHERE payment_id = ?`, payment.id) ?? null : null;
    const emailOutbox = many(this.db, `SELECT id, type, payload_ref, status, job_id, attempts,
      created_at, send_started_at, sent_at, delivered_at, bounced_at,
      superseded_at
      FROM email_outbox
      WHERE payload_ref = ? OR payload_ref = ? OR payload_ref = ?
        OR EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = ? AND r.id = email_outbox.payload_ref)
      ORDER BY created_at`, orderId, ticket?.id ?? "", booking?.id ?? "", orderId);
    const emailProviderEvents = many(this.db, `SELECT event.outbox_id, event.semantic_key,
      event.status, event.provider_status, event.job_id, event.received_at
      FROM email_provider_events event JOIN email_outbox outbox ON outbox.id = event.outbox_id
      WHERE outbox.payload_ref = ? OR outbox.payload_ref = ? OR outbox.payload_ref = ?
        OR EXISTS (SELECT 1 FROM refunds r WHERE r.order_id = ? AND r.id = outbox.payload_ref)
      ORDER BY event.received_at`, orderId, ticket?.id ?? "", booking?.id ?? "", orderId);
    const tochkaWebhookEvents = payment ? many(this.db, `SELECT id, provider, semantic_key,
      status, entity_id, received_at FROM provider_webhook_events
      WHERE provider = 'TOCHKA' AND entity_id = ? ORDER BY received_at`, payment.id) : [];
    const abandonment = one(this.db, "SELECT id, status, created_at, resolved_at FROM reservation_abandonments WHERE order_id = ?", orderId) ?? null;
    const refunds: Row[] = many<Row>(this.db, `SELECT id, public_id, payment_id, amount_kopecks,
      source, status, provider_reference, created_at, succeeded_at, failed_at
      FROM refunds WHERE order_id = ? ORDER BY created_at`, orderId)
      .map((refund): Row => ({
        ...refund,
        // A payment can have both an obligation-driven refund and an
        // independent administrator compensation refund.  Only the former is
        // evidence of satisfying this payment's refund obligation.
        refund_obligation_id: refund.source === "REFUND_OBLIGATION" ? obligation?.id ?? null : null,
      }));
    const refunded = refunds.filter((refund) => refund.status === "SUCCEEDED").reduce((total, refund) => total + Number(refund.amount_kopecks), 0);
    const inflightRefund = refunds.some((refund) => ["REQUESTED", "SUBMITTING", "SUBMIT_UNKNOWN", "RECONCILING"].includes(String(refund.status)));
    const canAbandonReservation = Boolean(booking && payment && booking.status === "RESERVED" && payment.status !== "PAID" && Number(payment.captured_amount_kopecks) === 0 && !abandonment);
    const canCreateCompensationRefund = Boolean(payment && ["PAID", "PARTIALLY_REFUNDED"].includes(String(payment.status)) && Number(payment.captured_amount_kopecks) > refunded && !inflightRefund);
    // A stored payment URL has no locally authoritative expiry proof, so it is
    // deliberately omitted rather than returned as if it were still usable.
    return {
      order,
      payment: payment ?? null,
      booking: booking ?? null,
      ticket,
      email_outbox: emailOutbox,
      email_provider_events: emailProviderEvents,
      tochka_webhook_events: tochkaWebhookEvents,
      refund_obligation: obligation,
      refunds,
      reservation_abandonment: abandonment,
      actions: { can_abandon_reservation: canAbandonReservation, can_create_compensation_refund: canCreateCompensationRefund },
    };
  }

  abandonReservation(orderId: string, input: { reason: string }, idempotencyKey: string, adminId: string) {
    const payload = { order_id: orderId, ...input };
    return this.withAdminCommand("order-abandon-reservation", idempotencyKey, payload, "bookings", () => {
      const row = one(this.db, `SELECT b.*, p.id AS payment_id, p.status AS payment_status, p.captured_amount_kopecks
        FROM bookings b JOIN payments p ON p.order_id = b.order_id WHERE b.order_id = ?`, orderId);
      if (!row) throw new DomainError("ORDER_NOT_FOUND", 404);
      if (row.status !== "RESERVED") throw new DomainError("RESERVATION_NOT_ABANDONABLE", 409);
      if (row.payment_status === "PAID" || Number(row.captured_amount_kopecks) > 0) throw new DomainError("PAYMENT_ALREADY_SUCCEEDED", 409);
      const abandonmentId = id();
      this.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ? WHERE id = ? AND status = 'RESERVED'")
        .run(now(), "TECHNICAL_RESERVATION_ABANDONED", row.id);
      this.db.prepare("INSERT INTO reservation_abandonments(id, order_id, booking_id, payment_id, admin_id, reason, status) VALUES (?, ?, ?, ?, ?, ?, 'ABANDONED')")
        .run(abandonmentId, orderId, row.id, row.payment_id, adminId, input.reason);
      const booking = one(this.db, "SELECT * FROM bookings WHERE id = ?", row.id)!;
      this.recordAdminCommandAudit(adminId, "RESERVATION_ABANDONED", "booking", String(row.id), input.reason, idempotencyKey, payload);
      return booking;
    });
  }

  cancelCustomerBooking(bookingId: string, input: { reason: string; confirmation_text: string; withheld_expense_amount_kopecks?: number; expense_justification?: string; evidence_reference?: string }, idempotencyKey: string) {
    const keyHash = sha256(idempotencyKey); const requestHash = sha256(canonical(input));
    return withImmediateTransaction(this.db, () => {
      const replay = one(this.db, "SELECT canonical_request_hash, booking_id FROM booking_cancellation_idempotency WHERE idempotency_key_hash = ?", keyHash);
      if (replay) { if (replay.canonical_request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409); return one(this.db, "SELECT * FROM bookings WHERE id = ?", replay.booking_id)!; }
      const booking = one(this.db, `SELECT b.*, p.id AS payment_id, p.status AS payment_status, p.captured_amount_kopecks, o.fulfillment_status, ord.customer_email, ord.customer_email_hash, ord.public_order_number
        FROM bookings b JOIN payments p ON p.order_id = b.order_id JOIN occurrences o ON o.id = b.occurrence_id JOIN orders ord ON ord.id = b.order_id WHERE b.id = ?`, bookingId);
      if (!booking || !["RESERVED", "CONFIRMED"].includes(String(booking.status))) throw new DomainError("BOOKING_NOT_CANCELLABLE", 409);
      if (booking.fulfillment_status !== "SCHEDULED") throw new DomainError("TERMINAL_OCCURRENCE", 409);
      if (input.confirmation_text !== `CANCEL ${bookingId}`) throw new DomainError("CONFIRMATION_REQUIRED", 422);
      const withheld = input.withheld_expense_amount_kopecks ?? 0;
      if (booking.payment_status !== "PAID" && withheld !== 0) throw new DomainError("WITHHOLDING_BEFORE_CAPTURE_FORBIDDEN", 422);
      if (withheld > Number(booking.captured_amount_kopecks)) throw new DomainError("WITHHOLDING_EXCEEDS_CAPTURED", 422);
      this.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ? WHERE id = ?").run(now(), input.reason, bookingId);
      this.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), bookingId);
      this.supersedePendingOccurrenceUpdatesForBooking(bookingId, "BOOKING_CANCELLED");
      this.closeOccurrenceChangeRefundEntitlementsForBooking(bookingId, "BOOKING_CANCELLED");
      this.syncRewardEvidence(String(booking.order_id));
      this.enqueueEmail("BOOKING_CANCELLED", String(booking.customer_email), String(booking.customer_email_hash), "booking-cancelled", bookingId, { booking_id: bookingId, reason: input.reason, public_order_number: booking.public_order_number });
      this.db.prepare("INSERT INTO booking_cancellation_idempotency(idempotency_key_hash, canonical_request_hash, booking_id) VALUES (?, ?, ?)").run(keyHash, requestHash, bookingId);
      if (booking.payment_status === "PAID") this.upsertRefundObligation(String(booking.payment_id), "CUSTOMER_CANCELLATION_PARTIAL", Number(booking.captured_amount_kopecks) - withheld);
      return one(this.db, "SELECT * FROM bookings WHERE id = ?", bookingId)!;
    });
  }

  createCompensationRefund(orderId: string, input: { amount_kopecks: number; reason: string; note?: string }, idempotencyKey: string) {
    const keyHash = sha256(idempotencyKey); const requestHash = sha256(canonical(input));
    return withImmediateTransaction(this.db, () => {
      const existing = one(this.db, "SELECT * FROM refunds WHERE idempotency_key_hash = ?", keyHash);
      if (existing) { if (existing.canonical_request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409); return existing; }
      const payment = one(this.db, "SELECT * FROM payments WHERE order_id = ?", orderId);
      if (!payment || !["PAID", "PARTIALLY_REFUNDED"].includes(String(payment.status))) throw new DomainError("PAYMENT_NOT_REFUNDABLE", 409);
      const used = one(this.db, `SELECT COALESCE(SUM(amount_kopecks), 0) AS succeeded FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'`, payment.id)!;
      const active = one(this.db, `SELECT COALESCE(SUM(amount_kopecks), 0) AS inflight FROM refunds WHERE payment_id = ? AND status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING')`, payment.id)!;
      if (input.amount_kopecks > Number(payment.captured_amount_kopecks) - Number(used.succeeded) - Number(active.inflight)) throw new DomainError("REFUND_AMOUNT_EXCEEDS_AVAILABLE", 409);
      const refundId = id();
      this.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, note, source, status, idempotency_key_hash, canonical_request_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMIN_COMPENSATION', 'REQUESTED', ?, ?)`)
        .run(refundId, publicId(), orderId, payment.id, input.amount_kopecks, input.reason, input.note ?? null, keyHash, requestHash);
      return one(this.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
    });
  }

  createObligationRefunds() {
    return withImmediateTransaction(this.db, () => many(this.db, `SELECT ro.*, p.order_id, p.captured_amount_kopecks FROM refund_obligations ro JOIN payments p ON p.id = ro.payment_id
      WHERE ro.status IN ('OPEN', 'FULFILLING')`).flatMap((obligation) => {
      const succeeded = Number(one(this.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS amount FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", obligation.payment_id)?.amount ?? 0);
      const active = one(this.db, "SELECT id FROM refunds WHERE payment_id = ? AND status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING')", obligation.payment_id);
      const outstanding = Number(obligation.target_refunded_amount_kopecks) - succeeded;
      if (outstanding <= 0) { this.db.prepare("UPDATE refund_obligations SET status = 'FULFILLED', fulfilled_at = ? WHERE id = ?").run(now(), obligation.id); return []; }
      if (active) return [];
      const refundId = id();
      this.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
        VALUES (?, ?, ?, ?, ?, 'Refund obligation', 'REFUND_OBLIGATION', 'REQUESTED', ?, ?)`)
        .run(refundId, publicId(), obligation.order_id, obligation.payment_id, outstanding, sha256(`obligation:${obligation.id}:${outstanding}`), sha256(`obligation:${obligation.id}:${outstanding}`));
      this.db.prepare("UPDATE refund_obligations SET status = 'FULFILLING' WHERE id = ?").run(obligation.id);
      return [one(this.db, "SELECT * FROM refunds WHERE id = ?", refundId)!];
    }));
  }

  /**
   * A refund obligation is a payment-level target.  Provider-confirmed refunds
   * may arrive through any legitimate command source, so fulfillment is based
   * on the cumulative authoritative amount for that payment rather than the
   * amount of the command currently being reconciled.
   *
   * REVIEW_REQUIRED deliberately remains an operator-owned state: a later
   * provider observation must not silently resolve an already escalated
   * obligation.
   *
   * Call only while holding the same immediate transaction that finalized a
   * successful refund.
   */
  private fulfillRefundObligationIfTargetMet(paymentId: string) {
    const obligation = one(this.db, `SELECT id, target_refunded_amount_kopecks
      FROM refund_obligations
      WHERE payment_id = ? AND status IN ('OPEN', 'FULFILLING')`, paymentId);
    if (!obligation) return false;

    const succeeded = Number(one(this.db, `SELECT COALESCE(SUM(amount_kopecks), 0) AS amount
      FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'`, paymentId)?.amount ?? 0);
    if (succeeded < Number(obligation.target_refunded_amount_kopecks)) return false;

    this.db.prepare(`UPDATE refund_obligations
      SET status = 'FULFILLED', fulfilled_at = COALESCE(fulfilled_at, ?)
      WHERE id = ? AND status IN ('OPEN', 'FULFILLING')`).run(now(), obligation.id);
    return true;
  }

  completeOccurrence(occurrenceId: string) {
    return withImmediateTransaction(this.db, () => {
      const occurrence = one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId);
      if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("OCCURRENCE_TERMINAL", 409);
      if (occurrence.sales_status !== "CLOSED") throw new DomainError("OCCURRENCE_SALES_MUST_BE_CLOSED", 409);
      if (new Date(String(occurrence.ends_at)).getTime() > Date.now()) throw new DomainError("OCCURRENCE_NOT_ENDED", 409);
      this.db.prepare("UPDATE occurrences SET fulfillment_status = 'COMPLETED', sales_status = 'CLOSED', completed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), occurrenceId);
      const reserved = many(this.db, "SELECT id FROM bookings WHERE occurrence_id = ? AND status = 'RESERVED'", occurrenceId);
      for (const booking of reserved) this.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'OCCURRENCE_COMPLETED_UNPAID' WHERE id = ?").run(now(), booking.id);
      this.resolveOperationalIncidents("occurrence", occurrenceId, "Occurrence completed");
      return one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
    });
  }

  createAdminReauth(input: { adminId: string; sessionId: string; purpose: "CANCEL_OCCURRENCE"; resourceId: string; capability: string }) {
    return withImmediateTransaction(this.db, () => {
      const capabilityId = id(); const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      this.db.prepare("INSERT INTO admin_reauth_capabilities(id, capability_hash, admin_session_id, admin_id, purpose, resource_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(capabilityId, sha256(input.capability), input.sessionId, input.adminId, input.purpose, input.resourceId, expiresAt);
      return { expires_at: expiresAt };
    });
  }

  cancelOccurrence(occurrenceId: string, input: { reason: string; reauthCapability: string }, idempotencyKey: string, adminId: string, sessionId: string) {
    const payload = { occurrence_id: occurrenceId, reason: input.reason };
    return this.withAdminCommand("occurrence-cancel", idempotencyKey, payload, "occurrences", () => {
      const occurrence = one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId);
      if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (occurrence.fulfillment_status !== "SCHEDULED") throw new DomainError("OCCURRENCE_TERMINAL", 409);
      const capability = one(this.db, `SELECT * FROM admin_reauth_capabilities WHERE capability_hash = ? AND admin_session_id = ? AND admin_id = ?
        AND purpose = 'CANCEL_OCCURRENCE' AND resource_id = ? AND consumed_at IS NULL AND expires_at > ?`, sha256(input.reauthCapability), sessionId, adminId, occurrenceId, now());
      if (!capability) throw new DomainError("ADMIN_REAUTH_REQUIRED", 403);
      this.db.prepare("UPDATE admin_reauth_capabilities SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), capability.id);
      this.db.prepare("UPDATE occurrences SET fulfillment_status = 'CANCELLED', sales_status = 'CLOSED', cancelled_at = ?, cancellation_reason = ?, updated_at = ? WHERE id = ?").run(now(), input.reason, now(), occurrenceId);
      // Entitlement cancellation is deliberately limited to active bookings.
      // It must not decide which captured payments receive a refund.
      const bookings = many(this.db, "SELECT id, order_id FROM bookings WHERE occurrence_id = ? AND status IN ('RESERVED', 'CONFIRMED')", occurrenceId);
      for (const booking of bookings) {
        this.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ? WHERE id = ?").run(now(), "OCCURRENCE_CANCELLED", booking.id);
        this.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), booking.id);
        this.supersedePendingOccurrenceUpdatesForBooking(String(booking.id), "OCCURRENCE_CANCELLED");
        this.closeOccurrenceChangeRefundEntitlementsForBooking(String(booking.id), "OCCURRENCE_CANCELLED");
        this.syncRewardEvidence(String(booking.order_id));
      }
      this.resolveOperationalIncidents("occurrence", occurrenceId, "Occurrence cancelled");
      // Financial unwind and organizer notice are independent of booking
      // status. A prior technical or customer cancellation must not strand
      // money or suppress the affected paid order's cancellation notice.
      const capturedPayments = many(this.db, `SELECT p.id, p.captured_amount_kopecks, ord.id AS order_id,
          ord.customer_email, ord.customer_email_hash, ord.public_order_number
        FROM payments p JOIN orders ord ON ord.id = p.order_id
        WHERE ord.occurrence_id = ? AND p.captured_amount_kopecks > 0`, occurrenceId);
      for (const payment of capturedPayments) {
        this.ensureFullCapturedRefund(String(payment.id), "OCCURRENCE_CANCELLED", Number(payment.captured_amount_kopecks));
        this.enqueueEmail("OCCURRENCE_CANCELLED", String(payment.customer_email), String(payment.customer_email_hash), "occurrence-cancelled", String(payment.order_id), {
          occurrence_id: occurrenceId, order_id: payment.order_id, reason: input.reason, public_order_number: payment.public_order_number,
        });
      }
      this.recordAdminCommandAudit(adminId, "OCCURRENCE_CANCELLED", "occurrence", occurrenceId, input.reason, idempotencyKey, payload);
      return one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
    });
  }

  cancellationFinancialOverview(occurrenceId: string) {
    const occurrence = one(this.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", occurrenceId);
    if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    if (occurrence.fulfillment_status !== "CANCELLED") throw new DomainError("OCCURRENCE_NOT_CANCELLED", 409);
    return one(this.db, `WITH payment_totals AS (
      SELECT p.id, p.captured_amount_kopecks AS captured,
        COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS refund_succeeded,
        COALESCE((SELECT COUNT(*) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'REVIEW_REQUIRED'), 0) AS refund_review_count,
        CASE WHEN ro.status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END AS obligation_review
      FROM payments p JOIN orders o ON o.id = p.order_id
      LEFT JOIN refund_obligations ro ON ro.payment_id = p.id
      WHERE o.occurrence_id = ? AND p.captured_amount_kopecks > 0
    ) SELECT
      COUNT(*) AS paid_orders,
      COALESCE(SUM(captured), 0) AS captured_kopecks,
      COALESCE(SUM(captured), 0) AS refund_target_kopecks,
      COALESCE(SUM(refund_succeeded), 0) AS refund_succeeded_kopecks,
      COALESCE(SUM(CASE WHEN captured > refund_succeeded THEN captured - refund_succeeded ELSE 0 END), 0) AS refund_outstanding_kopecks,
      COALESCE(SUM(CASE WHEN refund_review_count > 0 OR obligation_review = 1 THEN CASE WHEN captured > refund_succeeded THEN captured - refund_succeeded ELSE 0 END ELSE 0 END), 0) AS refund_needs_attention_kopecks,
      COALESCE(SUM(CASE WHEN refund_review_count > 0 OR obligation_review = 1 THEN 1 ELSE 0 END), 0) AS refund_needs_attention_count
      FROM payment_totals`, occurrenceId)!;
  }

  createCity(input: { city_slug: string; audit_context?: string }, idempotencyKey: string, adminId: string) {
    return this.withAdminCommand("city-create", idempotencyKey, input, "cities", () => {
      const canonicalCity = findCityBySlug(input.city_slug);
      if (!canonicalCity) throw new DomainError("CITY_SLUG_UNKNOWN", 400);
      if (one(this.db, "SELECT id FROM cities WHERE slug = ?", canonicalCity.slug)) throw new DomainError("CITY_SLUG_CONFLICT", 409);
      const cityId = id();
      this.db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, ?)").run(cityId, canonicalCity.slug, canonicalCity.title);
      const city = one(this.db, "SELECT * FROM cities WHERE id = ?", cityId)!;
      this.recordAdminCommandAudit(adminId, "CITY_CREATED", "city", cityId, input.audit_context, idempotencyKey, input);
      return city;
    });
  }

  patchCity(cityId: string, input: { city_slug: string; audit_context?: string }, idempotencyKey: string, adminId: string) {
    const payload = { city_id: cityId, ...input };
    return this.withAdminCommand("city-patch", idempotencyKey, payload, "cities", () => {
      const before = one(this.db, "SELECT * FROM cities WHERE id = ?", cityId);
      if (!before) throw new DomainError("CITY_NOT_FOUND", 404);
      const canonicalCity = findCityBySlug(input.city_slug);
      if (!canonicalCity) throw new DomainError("CITY_SLUG_UNKNOWN", 400);
      const slugChanges = before.slug !== canonicalCity.slug;
      const titleChanges = before.title !== canonicalCity.title;
      if (!slugChanges && !titleChanges) return before;
      if (slugChanges && Number(one(this.db, "SELECT COUNT(*) AS count FROM occurrences WHERE city_id = ?", cityId)?.count ?? 0) > 0) {
        throw new DomainError("CITY_HAS_OCCURRENCES", 409);
      }
      if (one(this.db, "SELECT id FROM cities WHERE slug = ? AND id <> ?", canonicalCity.slug, cityId)) throw new DomainError("CITY_SLUG_CONFLICT", 409);
      this.db.prepare("UPDATE cities SET slug = ?, title = ? WHERE id = ?").run(canonicalCity.slug, canonicalCity.title, cityId);
      const city = one(this.db, "SELECT * FROM cities WHERE id = ?", cityId)!;
      this.recordAdminCommandAudit(adminId, "CITY_EDITED", "city", cityId, input.audit_context, idempotencyKey, payload);
      return city;
    });
  }

  private createOccurrenceRecord(input: {
    city_id: string; title: string; starts_at: string; ends_at: string; timezone: string;
    price_kopecks: number; capacity: number; venue_status: "CONFIRMED" | "TO_BE_ANNOUNCED";
    venue_name?: string | null; venue_address?: string | null; venue_disclosure_text?: string | null;
    venue_announce_by?: string | null; audit_context?: string;
  }, occurrenceId: string = id()) {
    if (!one(this.db, "SELECT id FROM cities WHERE id = ?", input.city_id)) throw new DomainError("CITY_NOT_FOUND", 404);
    if (!Number.isInteger(input.price_kopecks) || input.price_kopecks <= 0 || !Number.isInteger(input.capacity) || input.capacity <= 0 || Date.parse(input.ends_at) <= Date.parse(input.starts_at)) {
      throw new DomainError("OCCURRENCE_CREATE_INVALID", 422);
    }
    if (input.venue_status === "CONFIRMED" && (!input.venue_name || !input.venue_address)) throw new DomainError("VENUE_CONFIRMATION_INCOMPLETE", 422);
    if (input.venue_status === "TO_BE_ANNOUNCED" && (!input.venue_disclosure_text || !input.venue_announce_by)) throw new DomainError("VENUE_TBD_INCOMPLETE", 422);
    if (input.venue_status === "TO_BE_ANNOUNCED" && Date.parse(input.venue_announce_by!) >= Date.parse(input.starts_at)) throw new DomainError("VENUE_ANNOUNCEMENT_TOO_LATE", 422);
    this.db.prepare(`INSERT INTO occurrences(
        id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
        sales_status, visibility, venue_status, venue_name, venue_address, venue_public,
        venue_disclosure_text, venue_announce_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED', 'HIDDEN', ?, ?, ?, 0, ?, ?)`)
      .run(occurrenceId, input.city_id, input.title, input.starts_at, input.ends_at, input.timezone,
        input.price_kopecks, input.capacity, input.venue_status, input.venue_name ?? null,
        input.venue_address ?? null, input.venue_disclosure_text ?? null, input.venue_announce_by ?? null);
    return one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
  }

  createOccurrence(input: {
    city_id: string; title: string; starts_at: string; ends_at: string; timezone: string;
    price_kopecks: number; capacity: number; venue_status: "CONFIRMED" | "TO_BE_ANNOUNCED";
    venue_name?: string | null; venue_address?: string | null; venue_disclosure_text?: string | null;
    venue_announce_by?: string | null; audit_context?: string;
  }, idempotencyKey: string, adminId: string) {
    return this.withAdminCommand("occurrence-create", idempotencyKey, input, "occurrences", () => {
      const occurrence = this.createOccurrenceRecord(input);
      this.recordAdminCommandAudit(adminId, "OCCURRENCE_CREATED", "occurrence", String(occurrence.id), input.audit_context, idempotencyKey, input);
      return occurrence;
    });
  }

  patchOccurrence(occurrenceId: string, input: Record<string, unknown>, idempotencyKey: string, adminId: string) {
    const payload = { occurrence_id: occurrenceId, ...input };
    return this.withAdminCommand("occurrence-patch", idempotencyKey, payload, "occurrences", () => {
      const before = one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId);
      if (!before) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
      if (before.fulfillment_status !== "SCHEDULED") throw new DomainError("OCCURRENCE_TERMINAL", 409);
      // HTTP callers always supply this value. The fallback keeps direct
      // in-process fixtures compatible while the public Admin boundary stays
      // compare-and-set based.
      const expectedRevision = Number(input.expected_revision ?? before.admin_revision);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(before.admin_revision)) {
        throw new DomainError("OCCURRENCE_REVISION_CONFLICT", 409);
      }
      const occupancy = Number(one(this.db, "SELECT COUNT(*) AS count FROM bookings WHERE occurrence_id = ? AND status IN ('RESERVED', 'CONFIRMED')", occurrenceId)?.count ?? 0);
      if (input.capacity !== undefined && Number(input.capacity) < occupancy) throw new DomainError("CAPACITY_BELOW_OCCUPANCY", 409);
      const fields = ["title", "starts_at", "ends_at", "timezone", "venue_status", "venue_name", "venue_address", "venue_public", "venue_disclosure_text", "venue_announce_by", "price_kopecks", "capacity", "sales_status", "visibility"] as const;
      const persistedPatch = Object.fromEntries(fields
        .filter((field) => input[field] !== undefined)
        .map((field) => [field, typeof input[field] === "boolean" ? Number(input[field]) : input[field]]));
      const changed = fields.filter((field) => persistedPatch[field] !== undefined && persistedPatch[field] !== before[field]);
      if (!changed.length) return before;
      const next = { ...before, ...Object.fromEntries(changed.map((field) => [field, persistedPatch[field]])) };
      const isLegacyHiddenSalesState = before.visibility === "HIDDEN" && (before.sales_status === "OPEN" || before.sales_status === "PAUSED");
      if (isLegacyHiddenSalesState && !(changed.length === 1 && changed[0] === "sales_status" && next.sales_status === "CLOSED")) {
        throw new DomainError("OCCURRENCE_STATE_TRANSITION_FORBIDDEN", 409);
      }
      if (!isAllowedOccurrenceStateTransition(before, next)) throw new DomainError("OCCURRENCE_STATE_TRANSITION_FORBIDDEN", 409);
      if (Date.parse(String(next.ends_at)) <= Date.parse(String(next.starts_at))) throw new DomainError("OCCURRENCE_CREATE_INVALID", 422);
      if (next.venue_status === "CONFIRMED" && (!next.venue_name || !next.venue_address)) throw new DomainError("VENUE_CONFIRMATION_INCOMPLETE", 422);
      if (next.venue_status === "TO_BE_ANNOUNCED" && (!next.venue_disclosure_text || !next.venue_announce_by)) throw new DomainError("VENUE_TBD_INCOMPLETE", 422);
      if (next.venue_status === "TO_BE_ANNOUNCED" && Date.parse(String(next.venue_announce_by)) >= Date.parse(String(next.starts_at))) throw new DomainError("VENUE_ANNOUNCEMENT_TOO_LATE", 422);
      const classification = classifyOccurrenceRevision(before, next);
      const assignments = [...changed.map((field) => `${field} = ?`), "material_revision = material_revision + ?", "admin_revision = admin_revision + 1", "updated_at = ?"];
      const updated = this.db.prepare(`UPDATE occurrences SET ${assignments.join(", ")} WHERE id = ? AND admin_revision = ?`)
        .run(...changed.map((field) => persistedPatch[field]), classification.notificationMaterial ? 1 : 0, now(), occurrenceId, expectedRevision);
      if (!updated.changes) throw new DomainError("OCCURRENCE_REVISION_CONFLICT", 409);
      const after = one(this.db, "SELECT * FROM occurrences WHERE id = ?", occurrenceId)!;
      // Publication, not city creation, can complete the narrowly scoped
      // purpose. The helper rechecks scheduled/future eligibility.
      const city = one(this.db, "SELECT slug FROM cities WHERE id = ?", after.city_id);
      if (city) this.consumeEligibleCityInterests(String(city.slug), CITY_INTEREST_SWEEP_BATCH_SIZE);
      if (classification.notificationMaterial) {
        const revisionId = id();
        this.db.prepare("INSERT INTO occurrence_revisions(id, occurrence_id, revision, reason, before_json, after_json, changed_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(revisionId, occurrenceId, after.material_revision, typeof input.audit_context === "string" ? input.audit_context : "", JSON.stringify(classification.before), JSON.stringify(classification.after), adminId);
        this.emitOccurrenceRevisionEffects(revisionId, before, after, classification);
      }
      this.recordAdminCommandAudit(adminId, "OCCURRENCE_EDITED", "occurrence", occurrenceId, typeof input.audit_context === "string" ? input.audit_context : undefined, idempotencyKey, payload);
      return after;
    });
  }

  /** Creates immutable customer notices and, only for materially adverse facts, refund rights. */
  private emitOccurrenceRevisionEffects(revisionId: string, before: Row, after: Row, classification: OccurrenceRevisionClassification) {
    const paidBookings = many(this.db, `SELECT b.id AS booking_id, b.order_id, p.id AS payment_id,
        t.id AS ticket_id, o.customer_email, o.customer_email_hash, o.public_order_number
      FROM bookings b
      JOIN orders o ON o.id = b.order_id
      JOIN payments p ON p.order_id = o.id
      JOIN tickets t ON t.booking_id = b.id
      WHERE b.occurrence_id = ?
        AND b.status = 'CONFIRMED'
        AND t.status = 'VALID'
        AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
        AND p.captured_amount_kopecks > 0`, after.id);
    for (const booking of paidBookings) {
      // Only PENDING is proof that a prior notice did not leave our system.
      // Carry its earliest customer baseline forward so a quick follow-up
      // edit cannot hide a material change from the replacement notice.
      const pendingBaseline = this.pendingOccurrenceUpdateBaseline(String(booking.booking_id));
      if (classification.refundMaterial) {
        this.db.prepare(`INSERT OR IGNORE INTO occurrence_change_refund_entitlements(
          id, occurrence_revision_id, order_id, booking_id, payment_id
        ) VALUES (?, ?, ?, ?, ?)`)
          .run(id(), revisionId, booking.order_id, booking.booking_id, booking.payment_id);
      }
      if (pendingBaseline?.corruptNotifications) {
        // We cannot prove the baseline of an immutable pending customer
        // notice. Preserve it and stop this booking's notification sequence
        // rather than silently dropping the earlier change or guessing a
        // cumulative diff. Financial entitlement creation above remains
        // authoritative and atomic with the occurrence revision.
        for (const corrupt of pendingBaseline.corruptNotifications) {
          this.openOccurrenceNotificationPayloadCorruptionIncident({
            occurrenceId: String(after.id), bookingId: String(booking.booking_id),
            orderId: String(booking.order_id), blockedRevisionId: revisionId,
            corrupt, recoveredFromRevision: false,
          });
        }
        continue;
      }
      for (const corrupt of pendingBaseline?.recoveredCorruptNotifications ?? []) {
        this.openOccurrenceNotificationPayloadCorruptionIncident({
          occurrenceId: String(after.id), bookingId: String(booking.booking_id),
          orderId: String(booking.order_id), blockedRevisionId: revisionId,
          corrupt, recoveredFromRevision: true,
        });
      }
      this.supersedePendingOccurrenceUpdatesForBooking(String(booking.booking_id), "NEWER_OCCURRENCE_REVISION");
      const notificationClassification = pendingBaseline
        ? classifyOccurrenceRevision(pendingBaseline.before, after)
        : classification;
      const organizerChangeFullRefundAvailable = this.hasOpenOccurrenceChangeRefundEntitlement(String(booking.booking_id));
      const payload = {
        schema_version: 1,
        occurrence_revision_id: revisionId,
        occurrence_id: after.id,
        revision: after.material_revision,
        ticket_id: booking.ticket_id,
        booking_id: booking.booking_id,
        order_id: booking.order_id,
        public_order_number: booking.public_order_number,
        before: notificationClassification.before,
        after: notificationClassification.after,
        material_changes: notificationClassification.materialChanges,
        // This is a durable booking right, not a property of only the latest
        // PATCH. It stays visible after a notification-only follow-up edit.
        organizer_change_full_refund_available: organizerChangeFullRefundAvailable,
        ...(pendingBaseline ? { coalesced_unsent_revision_ids: pendingBaseline.revisionIds } : {}),
      };
      const outboxId = this.enqueueEmail(
        "OCCURRENCE_UPDATED",
        String(booking.customer_email),
        String(booking.customer_email_hash),
        "occurrence-updated",
        String(booking.order_id),
        payload,
      );
      this.db.prepare(`INSERT INTO occurrence_update_notifications(
        id, occurrence_revision_id, order_id, booking_id, ticket_id, outbox_id
      ) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id(), revisionId, booking.order_id, booking.booking_id, booking.ticket_id, outboxId);
    }
  }

  createAgent(input: Record<string, unknown>) {
    const agentId = id();
    this.db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agentId, input.slug, input.display_name, input.legal_name, String(input.email).toLowerCase(), input.contractor_type, input.inn, input.contract_reference, input.enabled === false ? 0 : 1, input.default_reward_type, input.default_reward_value);
    return one(this.db, "SELECT * FROM agents WHERE id = ?", agentId)!;
  }

  agentList() {
    return many(this.db, `SELECT a.*, COUNT(p.id) AS promo_count
      FROM agents a LEFT JOIN promo_codes p ON p.agent_id = a.id
      GROUP BY a.id ORDER BY a.created_at DESC, a.id DESC`);
  }

  patchAgent(agentId: string, input: Record<string, unknown>) {
    const existing = one(this.db, "SELECT * FROM agents WHERE id = ?", agentId);
    if (!existing) throw new DomainError("AGENT_NOT_FOUND", 404);
    const allowed = ["display_name", "legal_name", "email", "contractor_type", "inn", "contract_reference", "enabled", "default_reward_type", "default_reward_value", "npd_status_checked_at"];
    const fields = allowed.filter((field) => input[field] !== undefined);
    if (!fields.length) return existing;
    this.db.prepare(`UPDATE agents SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...fields.map((field) => field === "enabled" ? Number(input[field]) : field === "email" ? String(input[field]).toLowerCase() : input[field]), now(), agentId);
    return one(this.db, "SELECT * FROM agents WHERE id = ?", agentId)!;
  }

  createPromo(input: Record<string, unknown>, promoId: string = id()) {
    if (input.agent_id && !one(this.db, "SELECT id FROM agents WHERE id = ?", input.agent_id)) throw new DomainError("AGENT_NOT_FOUND", 404);
    const normalized = String(input.code).trim().toUpperCase();
    this.db.prepare("INSERT INTO promo_codes(id, agent_id, code, normalized_code, status, discount_type, discount_value) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(promoId, input.agent_id ?? null, normalized, normalized, input.status ?? "ACTIVE", input.discount_type, input.discount_value);
    return one(this.db, "SELECT * FROM promo_codes WHERE id = ?", promoId)!;
  }

  createCertificationFixture(input: {
    occurrence: Parameters<CommerceDomain["createOccurrence"]>[0]; occurrence_id: string; occurrence_key: string;
    promo: Record<string, unknown>; promo_id: string; promo_key: string; admin_id: string; audit_context?: string;
  }) {
    this.assertV2IdempotencyKey(input.promo_key);
    return withImmediateTransaction(this.db, () => {
      const occurrence = this.withAdminCommandCore("occurrence-create", input.occurrence_key, input.occurrence, "occurrences", () => {
        const created = this.createOccurrenceRecord(input.occurrence, input.occurrence_id);
        this.recordAdminCommandAudit(input.admin_id, "OCCURRENCE_CREATED", "occurrence", String(created.id), input.occurrence.audit_context, input.occurrence_key, input.occurrence);
        return created;
      });
      const promo = this.withAdminCommandV2Core("promo.create", input.promo_key, input.admin_id, null, input.promo, input.audit_context, "PROMO_CREATED", "promo", () => this.createPromo(input.promo, input.promo_id));
      if (occurrence.disposition !== "CREATED" || promo.disposition !== "CREATED") throw new DomainError("CERTIFICATION_FIXTURE_IDEMPOTENCY_REPLAY", 409);
      return { occurrence: occurrence.row, promo: promo.row };
    });
  }

  promoList() {
    return many(this.db, `SELECT p.*, a.id AS agent_id, a.slug AS agent_slug, a.display_name AS agent_display_name, a.enabled AS agent_enabled
      FROM promo_codes p LEFT JOIN agents a ON a.id = p.agent_id ORDER BY p.created_at DESC, p.id DESC`)
      .map((promo) => ({ ...promo, agent: promo.agent_id ? { id: promo.agent_id, slug: promo.agent_slug, display_name: promo.agent_display_name, enabled: promo.agent_enabled } : null }));
  }

  createAgentCommand(input: Record<string, unknown>, idempotencyKey: string, adminId: string, auditContext?: string) {
    return this.withAdminCommandV2("agent.create", idempotencyKey, adminId, null, input, auditContext, "AGENT_CREATED", "agent", () => this.createAgent(input));
  }

  patchAgentCommand(agentId: string, patch: Record<string, unknown>, idempotencyKey: string, adminId: string, auditContext?: string) {
    return this.withAdminCommandV2("agent.patch", idempotencyKey, adminId, agentId, patch, auditContext, "AGENT_EDITED", "agent", () => {
      const existing = one(this.db, "SELECT * FROM agents WHERE id = ?", agentId);
      if (!existing) throw new DomainError("AGENT_NOT_FOUND", 404);
      return this.patchAgent(agentId, patch);
    });
  }

  createPromoCommand(input: Record<string, unknown>, idempotencyKey: string, adminId: string, auditContext?: string) {
    return this.withAdminCommandV2("promo.create", idempotencyKey, adminId, null, input, auditContext, "PROMO_CREATED", "promo", () => this.createPromo(input));
  }

  patchPromoCommand(promoId: string, patch: Record<string, unknown>, idempotencyKey: string, adminId: string, auditContext?: string) {
    return this.withAdminCommandV2("promo.patch", idempotencyKey, adminId, promoId, patch, auditContext, "PROMO_EDITED", "promo", () => {
      const existing = one(this.db, "SELECT * FROM promo_codes WHERE id = ?", promoId);
      if (!existing) throw new DomainError("PROMO_NOT_FOUND", 404);
      promoMergedSchema.parse({
        agent_id: patch.agent_id === undefined ? existing.agent_id : patch.agent_id,
        status: patch.status === undefined ? existing.status : patch.status,
        discount_type: patch.discount_type === undefined ? existing.discount_type : patch.discount_type,
        discount_value: patch.discount_value === undefined ? existing.discount_value : patch.discount_value,
      });
      return this.patchPromo(promoId, patch);
    });
  }

  patchPromo(promoId: string, input: Record<string, unknown>) {
    const existing = one(this.db, "SELECT * FROM promo_codes WHERE id = ?", promoId);
    if (!existing) throw new DomainError("PROMO_NOT_FOUND", 404);
    if (input.agent_id && !one(this.db, "SELECT id FROM agents WHERE id = ?", input.agent_id)) throw new DomainError("AGENT_NOT_FOUND", 404);
    const allowed = ["agent_id", "status", "discount_type", "discount_value"];
    const fields = allowed.filter((field) => input[field] !== undefined);
    if (!fields.length) return existing;
    this.db.prepare(`UPDATE promo_codes SET ${fields.map((field) => `${field} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...fields.map((field) => input[field]), now(), promoId);
    return one(this.db, "SELECT * FROM promo_codes WHERE id = ?", promoId)!;
  }

  private rewardForOrder(order: Row, netCaptured: number) {
    if (netCaptured <= 0 || !order.attributed_agent_id || !order.reward_type_snapshot) return 0;
    if (order.reward_type_snapshot === "PERCENT") return basisPointsOf(netCaptured, Number(order.reward_value_snapshot ?? 0));
    return Math.min(netCaptured, Number(order.reward_value_snapshot ?? 0));
  }

  /**
   * Persist accounting evidence whenever an authoritative financial or booking
   * event changes an order's reward. The base row is immutable; every later
   * change is an append-only delta keyed by the observed state.
   */
  private syncRewardEvidence(orderId: string) {
    const order = one(this.db, `SELECT o.*, p.captured_amount_kopecks,
      COALESCE((SELECT SUM(r.amount_kopecks) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED'), 0) AS refunded_amount_kopecks,
      b.id AS booking_id, b.status AS booking_status
      FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id
      WHERE o.id = ?`, orderId);
    if (!order?.attributed_agent_id || !order.reward_type_snapshot || Number(order.captured_amount_kopecks) <= 0) return;
    const base = this.rewardForOrder(order, Number(order.captured_amount_kopecks));
    this.db.prepare(`INSERT OR IGNORE INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks)
      VALUES (?, ?, ?, ?, ?)`)
      .run(id(), order.id, order.attributed_agent_id, order.occurrence_id, base);
    const net = Math.max(0, Number(order.captured_amount_kopecks) - Number(order.refunded_amount_kopecks));
    const expected = order.booking_status === "CONFIRMED" ? this.rewardForOrder(order, net) : 0;
    const accounted = Number(one(this.db, `SELECT rr.amount_kopecks + COALESCE((SELECT SUM(ra.amount_kopecks) FROM reward_adjustments ra WHERE ra.order_id = rr.order_id), 0) AS amount
      FROM referral_rewards rr WHERE rr.order_id = ?`, order.id)?.amount ?? 0);
    if (expected === accounted) return;
    const semanticKey = `reward:${order.id}:captured:${order.captured_amount_kopecks}:refunded:${order.refunded_amount_kopecks}:booking:${order.booking_status}`;
    this.db.prepare(`INSERT OR IGNORE INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason, semantic_key)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id(), order.id, order.attributed_agent_id, expected - accounted, order.booking_status === "CONFIRMED" ? "NET_CAPTURED_CHANGED" : "BOOKING_CANCELLED", semanticKey);
  }

  rewardBalance(agentId: string, occurrenceId: string) {
    const agent = one(this.db, "SELECT * FROM agents WHERE id = ?", agentId);
    if (!agent) throw new DomainError("AGENT_NOT_FOUND", 404);
    const occurrence = one(this.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", occurrenceId);
    if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    const earned = Number(one(this.db, `SELECT COALESCE(SUM(amount_kopecks), 0) AS amount
      FROM referral_rewards WHERE agent_id = ? AND occurrence_id = ?`, agentId, occurrenceId)?.amount ?? 0)
      + Number(one(this.db, `SELECT COALESCE(SUM(ra.amount_kopecks), 0) AS amount
        FROM reward_adjustments ra JOIN orders o ON o.id = ra.order_id
        WHERE ra.agent_id = ? AND o.occurrence_id = ?`, agentId, occurrenceId)?.amount ?? 0);
    const mature = occurrence.fulfillment_status === "COMPLETED" ? earned : 0;
    const settlement = one(this.db, `SELECT
      COALESCE(SUM(CASE WHEN status = 'PREPARED' THEN amount_kopecks ELSE 0 END), 0) AS prepared,
      COALESCE(SUM(CASE WHEN status = 'PENDING_DOCUMENT' THEN amount_kopecks ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'SETTLED' THEN amount_kopecks ELSE 0 END), 0) AS settled
      FROM reward_settlements WHERE agent_id = ? AND occurrence_id = ?`, agentId, occurrenceId)!;
    const recovered = Number(one(this.db, `SELECT COALESCE(SUM(sr.amount_recovered_kopecks), 0) AS amount FROM settlement_recoveries sr JOIN reward_settlements rs ON rs.id = sr.settlement_id WHERE rs.agent_id = ? AND rs.occurrence_id = ?`, agentId, occurrenceId)?.amount ?? 0);
    const allocated = Number(settlement.prepared) + Number(settlement.pending) + Number(settlement.settled);
    const unallocatedMatured = Math.max(0, mature - allocated + recovered);
    const blocked = agent.npd_status_checked_at ? 0 : unallocatedMatured;
    const lateAdjustmentExposure = Math.max(0, allocated - mature - recovered);
    return { earned_total: earned, accrued_total: mature, payable_gross_total: mature, blocked_payable_total: blocked, prepared_total: Number(settlement.prepared), pending_document_total: Number(settlement.pending), settled_total: Number(settlement.settled), externally_recovered_total: recovered, late_adjustment_exposure: lateAdjustmentExposure, available_to_settle: Math.max(0, mature - blocked - allocated + recovered) };
  }

  prepareSettlement(input: { agent_id: string; occurrence_id: string; amount_kopecks: number; method: string }, idempotencyKey: string, adminId: string) {
    const keyHash = sha256(idempotencyKey); const payloadHash = sha256(canonical(input));
    return this.settlementTransaction(() => {
      const replay = one(this.db, `SELECT rsi.canonical_request_hash, rs.* FROM reward_settlement_idempotency rsi
        JOIN reward_settlements rs ON rs.id = rsi.settlement_id WHERE rsi.idempotency_key_hash = ?`, keyHash);
      if (replay) {
        if (replay.canonical_request_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
        return replay;
      }
      const agent = one(this.db, "SELECT * FROM agents WHERE id = ?", input.agent_id);
      if (!agent) throw new DomainError("AGENT_NOT_FOUND", 404);
      const occurrence = one(this.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", input.occurrence_id);
      if (!occurrence || occurrence.fulfillment_status !== "COMPLETED") throw new DomainError("OCCURRENCE_NOT_COMPLETED", 409);
      const balance = this.rewardBalance(input.agent_id, input.occurrence_id);
      if (balance.blocked_payable_total > 0) throw new DomainError("CONTRACTOR_STATUS_REVIEW", 409);
      if (input.amount_kopecks > balance.available_to_settle) throw new DomainError("SETTLEMENT_EXCEEDS_AVAILABLE", 409);
      const settlementId = id();
      this.db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id)
        VALUES (?, ?, ?, ?, ?, 'PREPARED', ?, ?, ?)`).run(settlementId, input.agent_id, input.occurrence_id, input.amount_kopecks, input.method, agent.contractor_type, now(), adminId);
      this.db.prepare("INSERT INTO reward_settlement_idempotency(idempotency_key_hash, canonical_request_hash, settlement_id) VALUES (?, ?, ?)").run(keyHash, payloadHash, settlementId);
      return one(this.db, "SELECT * FROM reward_settlements WHERE id = ?", settlementId)!;
    });
  }

  markSettlementPaymentMade(settlementId: string, confirmationText: string, idempotencyKey: string, reason = "") {
    if (confirmationText !== "I confirm the money was transferred") throw new DomainError("CONFIRMATION_REQUIRED", 422);
    return this.settlementTransition("PAYMENT_MADE", settlementId, { confirmation_text: confirmationText, reason }, idempotencyKey, () => {
      const changed = this.db.prepare("UPDATE reward_settlements SET status = 'PENDING_DOCUMENT', payment_made_at = ? WHERE id = ? AND status = 'PREPARED'").run(now(), settlementId);
      if (!changed.changes) throw new DomainError("SETTLEMENT_TRANSITION_FORBIDDEN", 409);
      return one(this.db, "SELECT * FROM reward_settlements WHERE id = ?", settlementId)!;
    });
  }

  completeSettlementDocuments(settlementId: string, input: { document_reference: string; npd_status_effective_on?: string }, idempotencyKey: string) {
    return this.settlementTransition("DOCUMENTS_COMPLETE", settlementId, input, idempotencyKey, () => {
      const changed = this.db.prepare("UPDATE reward_settlements SET status = 'SETTLED', document_confirmed = 1, document_reference = ?, document_confirmed_at = ?, settled_at = ?, npd_status_effective_on = ? WHERE id = ? AND status = 'PENDING_DOCUMENT'").run(input.document_reference, now(), now(), input.npd_status_effective_on ?? null, settlementId);
      if (!changed.changes) throw new DomainError("SETTLEMENT_TRANSITION_FORBIDDEN", 409);
      return one(this.db, "SELECT * FROM reward_settlements WHERE id = ?", settlementId)!;
    });
  }

  cancelSettlementBeforePayment(settlementId: string, input: { confirmation_text: string; reason: string }, idempotencyKey: string) {
    if (input.confirmation_text !== `NOT PAID ${settlementId}`) throw new DomainError("CONFIRMATION_REQUIRED", 422);
    return this.settlementTransition("CANCEL_BEFORE_PAYMENT", settlementId, input, idempotencyKey, () => {
      const changed = this.db.prepare("UPDATE reward_settlements SET status = 'CANCELLED_BEFORE_PAYMENT', cancelled_before_payment_at = ?, note = ? WHERE id = ? AND status = 'PREPARED'").run(now(), input.reason, settlementId);
      if (!changed.changes) throw new DomainError("SETTLEMENT_TRANSITION_FORBIDDEN", 409);
      return one(this.db, "SELECT * FROM reward_settlements WHERE id = ?", settlementId)!;
    });
  }

  addSettlementRecovery(settlementId: string, input: { amount_recovered_kopecks: number; recovered_at: string; method: string; evidence_reference: string; note?: string }, idempotencyKey: string) {
    const create = () => {
      const settlement = one(this.db, "SELECT id, status, amount_kopecks FROM reward_settlements WHERE id = ?", settlementId);
      if (!settlement) throw new DomainError("SETTLEMENT_NOT_FOUND", 404);
      if (settlement.status !== "PENDING_DOCUMENT" && settlement.status !== "SETTLED") throw new DomainError("SETTLEMENT_RECOVERY_NOT_PAID", 409);
      const alreadyRecovered = Number(one(this.db, "SELECT COALESCE(SUM(amount_recovered_kopecks), 0) AS amount FROM settlement_recoveries WHERE settlement_id = ?", settlementId)?.amount ?? 0);
      const remainingRecoverable = Number(settlement.amount_kopecks) - alreadyRecovered;
      if (input.amount_recovered_kopecks > remainingRecoverable) throw new DomainError("SETTLEMENT_RECOVERY_EXCEEDS_REMAINING", 409);
      const recoveryId = id();
      this.db.prepare("INSERT INTO settlement_recoveries(id, settlement_id, amount_recovered_kopecks, recovered_at, method, evidence_reference, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(recoveryId, settlementId, input.amount_recovered_kopecks, input.recovered_at, input.method, input.evidence_reference, input.note ?? null);
      return one(this.db, "SELECT * FROM settlement_recoveries WHERE id = ?", recoveryId)!;
    };
    const keyHash = sha256(idempotencyKey); const payloadHash = sha256(canonical({ settlement_id: settlementId, ...input }));
    return this.settlementTransaction(() => {
      const replay = one(this.db, "SELECT canonical_request_hash, recovery_id FROM reward_settlement_command_idempotency WHERE command = 'RECOVERY' AND idempotency_key_hash = ?", keyHash);
      if (replay) {
        if (replay.canonical_request_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
        return one(this.db, "SELECT * FROM settlement_recoveries WHERE id = ?", replay.recovery_id)!;
      }
      if (!Number.isInteger(input.amount_recovered_kopecks) || input.amount_recovered_kopecks <= 0) throw new DomainError("SETTLEMENT_RECOVERY_AMOUNT_INVALID", 422);
      const recovery = create();
      this.db.prepare("INSERT INTO reward_settlement_command_idempotency(command, idempotency_key_hash, canonical_request_hash, settlement_id, recovery_id) VALUES ('RECOVERY', ?, ?, ?, ?)").run(keyHash, payloadHash, settlementId, recovery.id);
      return recovery;
    });
  }

  detectStalePreparedSettlements() {
    const threshold = new Date(this.clock() - STALE_PREPARED_SETTLEMENT_MS).toISOString();
    return this.settlementTransaction(() => {
      const stale = many(this.db, "SELECT id FROM reward_settlements WHERE status = 'PREPARED' AND prepared_at <= ?", threshold);
      for (const settlement of stale) this.db.prepare("INSERT OR IGNORE INTO settlement_prepared_reviews(settlement_id) VALUES (?)").run(settlement.id);
      return stale.length;
    });
  }

  settlementList(filters: { stalePrepared?: true } = {}) {
    const threshold = new Date(this.clock() - STALE_PREPARED_SETTLEMENT_MS).toISOString();
    return many(this.db, `SELECT rs.*, a.slug AS agent_slug, a.display_name AS agent_display_name,
      c.title AS city_title, o.title AS occurrence_title,
      CASE WHEN rs.status = 'PREPARED' AND rs.prepared_at <= ? THEN 1 ELSE 0 END AS stale_prepared,
      spr.status AS prepared_review_status,
      COALESCE((SELECT SUM(amount_recovered_kopecks) FROM settlement_recoveries sr WHERE sr.settlement_id = rs.id), 0) AS recovered_total,
      MAX(0, rs.amount_kopecks - COALESCE((SELECT SUM(amount_recovered_kopecks) FROM settlement_recoveries sr WHERE sr.settlement_id = rs.id), 0)) AS unrecovered_amount_kopecks
      FROM reward_settlements rs JOIN agents a ON a.id = rs.agent_id JOIN occurrences o ON o.id = rs.occurrence_id JOIN cities c ON c.id = o.city_id
      LEFT JOIN settlement_prepared_reviews spr ON spr.settlement_id = rs.id
      ${filters.stalePrepared ? "WHERE spr.status = 'OPEN'" : ""}
      ORDER BY rs.prepared_at DESC`, threshold);
  }

  settlementDetail(settlementId: string) {
    const settlement = this.settlementList().find((item) => item.id === settlementId);
    if (!settlement) throw new DomainError("SETTLEMENT_NOT_FOUND", 404);
    const balance = this.rewardBalance(String(settlement.agent_id), String(settlement.occurrence_id));
    return { settlement, balance, recoveries: many(this.db, "SELECT * FROM settlement_recoveries WHERE settlement_id = ? ORDER BY recovered_at DESC, id DESC", settlementId) };
  }

  private settlementTransition(command: "PAYMENT_MADE" | "DOCUMENTS_COMPLETE" | "CANCEL_BEFORE_PAYMENT", settlementId: string, input: unknown, idempotencyKey: string, transition: () => Row) {
    const keyHash = sha256(idempotencyKey); const payloadHash = sha256(canonical({ settlement_id: settlementId, ...(input as Record<string, unknown>) }));
    return this.settlementTransaction(() => {
      const replay = one(this.db, "SELECT canonical_request_hash, settlement_id FROM reward_settlement_command_idempotency WHERE command = ? AND idempotency_key_hash = ?", command, keyHash);
      if (replay) {
        if (replay.canonical_request_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
        return one(this.db, "SELECT * FROM reward_settlements WHERE id = ?", replay.settlement_id)!;
      }
      const settlement = transition();
      this.db.prepare("INSERT INTO reward_settlement_command_idempotency(command, idempotency_key_hash, canonical_request_hash, settlement_id) VALUES (?, ?, ?, ?)").run(command, keyHash, payloadHash, settlementId);
      // A successful transition out of PREPARED resolves its stale-PREPARED
      // review; it does not erase the review or change any allocation.
      this.db.prepare("UPDATE settlement_prepared_reviews SET status = 'RESOLVED', resolved_at = COALESCE(resolved_at, ?) WHERE settlement_id = ? AND status = 'OPEN'").run(now(), settlementId);
      return settlement;
    });
  }

  private settlementTransaction<T>(operation: () => T): T {
    try { return withImmediateTransaction(this.db, operation); }
    catch (error) {
      if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) throw new DomainError("SETTLEMENT_BUSY", 409);
      throw error;
    }
  }

  async submitRequestedRefunds() {
    const requests = many(this.db, `SELECT r.*, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.status = 'REQUESTED'`);
    for (const refund of requests) {
      const claimed = withImmediateTransaction(this.db, () => this.db.prepare("UPDATE refunds SET status = 'SUBMITTING', submission_started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'REQUESTED'").run(now(), refund.id).changes);
      if (!claimed) continue;
      try {
        if (!refund.provider_payment_id) throw new Error("Provider payment reference is absent.");
        const submitted = await this.provider.refund({ refundId: String(refund.id), providerPaymentId: String(refund.provider_payment_id), amountKopecks: Number(refund.amount_kopecks), idempotencyKey: String(refund.idempotency_key_hash) });
        this.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = ?, last_reconcile_at = ? WHERE id = ? AND status = 'SUBMITTING'").run(submitted.providerReference, now(), refund.id);
      } catch (error) {
        this.db.prepare("UPDATE refunds SET status = 'SUBMIT_UNKNOWN', last_error = ? WHERE id = ? AND status = 'SUBMITTING'").run(error instanceof Error ? error.message : "Refund submission failed", refund.id);
      }
    }
  }

  async reconcilePayment(paymentId: string) {
    const payment = one(this.db, "SELECT * FROM payments WHERE id = ?", paymentId);
    if (!payment) throw new DomainError("PAYMENT_NOT_FOUND", 404);
    if (!payment.provider_payment_id) throw new DomainError("PROVIDER_REFERENCE_REQUIRED", 422);
    const observed = await this.provider.reconcilePayment({ providerPaymentId: String(payment.provider_payment_id) });
    this.db.prepare("UPDATE payments SET last_reconcile_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), paymentId);
    if (observed.status === "PAID" && observed.capturedAmountKopecks !== undefined) return this.markPaymentPaid(paymentId, observed.capturedAmountKopecks, String(payment.provider_payment_id));
    if (observed.status === "FAILED") {
      return withImmediateTransaction(this.db, () => {
        this.db.prepare("UPDATE payments SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now(), paymentId);
        this.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'PAYMENT_PROVIDER_FAILED' WHERE order_id = ? AND status = 'RESERVED'").run(now(), payment.order_id);
        return one(this.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
      });
    }
    // Pending or unknown provider evidence is not a failure proof; retain the
    // reservation and let a later reconciliation establish a terminal outcome.
    this.db.prepare("UPDATE payments SET updated_at = ? WHERE id = ?").run(now(), paymentId);
    return one(this.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
  }

  async reconcileRefund(refundId: string) {
    const refund = one(this.db, "SELECT r.*, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = ?", refundId);
    if (!refund) throw new DomainError("REFUND_NOT_FOUND", 404);
    // A previous authoritative reconciliation already completed this command.
    // Do not ask the provider again or enqueue a second REFUND_SUCCEEDED mail.
    if (refund.status === "SUCCEEDED") return one(this.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
    if (!refund.provider_payment_id) throw new DomainError("PROVIDER_REFERENCE_REQUIRED", 422);
    const observed = await this.provider.reconcileRefund({ providerPaymentId: String(refund.provider_payment_id), providerReference: refund.provider_reference ? String(refund.provider_reference) : null, amountKopecks: Number(refund.amount_kopecks), idempotencyKey: String(refund.idempotency_key_hash) });
    this.db.prepare("UPDATE refunds SET last_reconcile_at = ?, provider_observed_total_refunded = ? WHERE id = ?").run(now(), observed.refundedAmountKopecks ?? null, refundId);
    if (observed.status === "SUCCEEDED" && observed.refundedAmountKopecks === Number(refund.amount_kopecks)) {
      return withImmediateTransaction(this.db, () => {
        const finalized = this.db.prepare("UPDATE refunds SET status = 'SUCCEEDED', succeeded_at = ? WHERE id = ? AND status <> 'SUCCEEDED'").run(now(), refundId);
        // Another worker/manual reconciliation won the transition while the
        // provider request was in flight. Its transaction owns every local
        // side effect, including full-refund fulfilment and the email outbox.
        if (!finalized.changes) return one(this.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
        const totals = one(this.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS amount FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", refund.payment_id)!;
        const payment = one(this.db, "SELECT captured_amount_kopecks FROM payments WHERE id = ?", refund.payment_id)!;
        const fullyRefunded = Number(totals.amount) >= Number(payment.captured_amount_kopecks);
        this.db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?").run(fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", now(), refund.payment_id);
        // Keep the provider-confirmed refund and its payment-level obligation
        // consistent in this transaction.  A later worker sweep is no longer
        // required to make the fulfillment fact observable.
        this.fulfillRefundObligationIfTargetMet(String(refund.payment_id));
        // Preserve the accounting fact that changed first: the captured net
        // amount. Full-refund fulfilment below is still atomic, but must not
        // relabel this established adjustment as a generic booking cancel.
        this.syncRewardEvidence(String(refund.order_id));
        if (fullyRefunded) this.cancelConfirmedBookingForFullRefund(String(refund.order_id));
        this.db.prepare("UPDATE reservation_abandonments SET status = 'LATE_PAYMENT_REFUNDED', resolved_at = ? WHERE payment_id = ? AND status = 'LATE_PAYMENT_REVIEW_REQUIRED'").run(now(), refund.payment_id);
        const order = one(this.db, "SELECT customer_email, customer_email_hash, public_order_number FROM orders WHERE id = ?", refund.order_id)!;
        this.enqueueEmail("REFUND_SUCCEEDED", String(order.customer_email), String(order.customer_email_hash), "refund-succeeded", refundId, {
          refund_id: refundId,
          amount_kopecks: refund.amount_kopecks,
          public_order_number: order.public_order_number,
          fulfillment_outcome: fullyRefunded ? "FULL" : "PARTIAL",
        });
        this.resolveOperationalIncidents("refund", refundId, "Provider refund succeeded");
        return one(this.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
      });
    }
    return withImmediateTransaction(this.db, () => {
      const failed = observed.status === "FAILED";
      this.db.prepare(`UPDATE refunds SET status = ?, failed_at = CASE WHEN ? THEN ? ELSE failed_at END WHERE id = ?`)
        .run(failed ? "FAILED" : "REVIEW_REQUIRED", failed ? 1 : 0, now(), refundId);
      const order = one(this.db, `SELECT public_order_number, customer_email
        FROM orders WHERE id = ?`, refund.order_id);
      this.openOperationalIncident("REFUND_REQUIRES_REVIEW", "refund", refundId, `refund-attention:${refundId}`, {
        refund_id: refundId,
        state: failed ? "FAILED" : "REVIEW_REQUIRED",
        order_id: refund.order_id,
        public_order_number: order?.public_order_number ?? null,
        customer_email: order?.customer_email ?? null,
        amount_kopecks: refund.amount_kopecks,
        provider_reference: refund.provider_reference ?? null,
        provider_payment_id: refund.provider_payment_id,
      });
      return one(this.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
    });
  }

  /**
   * A fully refunded paid order cannot retain a capacity claim or a valid
   * admission capability. This helper deliberately has no customer-email or
   * provider side effects: the enclosing refund transition owns the one
   * REFUND_SUCCEEDED notification.
   */
  private cancelConfirmedBookingForFullRefund(orderId: string) {
    const booking = one(this.db, "SELECT id FROM bookings WHERE order_id = ? AND status = 'CONFIRMED'", orderId);
    if (!booking) {
      this.closeOccurrenceChangeRefundEntitlementsForOrder(orderId, "FULL_REFUND");
      return false;
    }
    const cancelled = this.db.prepare(`UPDATE bookings
      SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'FULL_REFUND'
      WHERE id = ? AND status = 'CONFIRMED'`).run(now(), booking.id);
    if (!cancelled.changes) {
      this.closeOccurrenceChangeRefundEntitlementsForOrder(orderId, "FULL_REFUND");
      return false;
    }
    this.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), booking.id);
    this.supersedePendingOccurrenceUpdatesForBooking(String(booking.id), "FULL_REFUND");
    this.closeOccurrenceChangeRefundEntitlementsForOrder(orderId, "FULL_REFUND");
    return true;
  }

  /**
   * Controlled local repair for a legacy state where provider-authoritative
   * full refund evidence exists but fulfilment was not released. It never
   * calls a payment provider or enqueues email.
   */
  repairFullRefundFulfillment(orderId: string) {
    return withImmediateTransaction(this.db, () => {
      const order = one(this.db, `SELECT p.id AS payment_id, p.status AS payment_status,
        p.captured_amount_kopecks, b.status AS booking_status
        FROM orders o JOIN payments p ON p.order_id = o.id
        JOIN bookings b ON b.order_id = o.id WHERE o.id = ?`, orderId);
      if (!order || order.payment_status !== "REFUNDED" || Number(order.captured_amount_kopecks) <= 0 || order.booking_status !== "CONFIRMED") return false;
      const refunds = one(this.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS amount FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", order.payment_id)!;
      if (Number(refunds.amount) < Number(order.captured_amount_kopecks)) return false;
      return this.cancelConfirmedBookingForFullRefund(orderId);
    });
  }

  async reconcilePendingRefunds() {
    const refunds = many(this.db, "SELECT id FROM refunds WHERE status IN ('RECONCILING', 'SUBMIT_UNKNOWN') ORDER BY created_at LIMIT 50");
    for (const refund of refunds) {
      try { await this.reconcileRefund(String(refund.id)); } catch { /* retain the durable refund command for admin reconciliation */ }
    }
  }

  async reconcilePendingPayments() {
    const payments = many(this.db, "SELECT id FROM payments WHERE provider_payment_id IS NOT NULL AND status = 'PENDING' AND state = 'CREATED' ORDER BY created_at LIMIT 50");
    for (const payment of payments) {
      try { await this.reconcilePayment(String(payment.id)); } catch { /* retain reservation until authoritative evidence arrives */ }
    }
  }

  /**
   * A lost create response is never retried with a second POST. Instead, look
   * up the unique local paymentLinkId in a bounded provider list window. Zero
   * results remain ambiguous; only a single internally consistent operation
   * can reconnect the local payment to normal reconciliation.
   */
  async reconcileCreateUnknownPayments() {
    const timestamp = this.clock();
    const payments = many(this.db, `SELECT p.*, o.amount_kopecks
      FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.state = 'CREATE_UNKNOWN' AND p.status = 'PENDING'
        AND p.provider_payment_id IS NULL
      ORDER BY p.creation_started_at LIMIT 50`);
    for (const payment of payments) {
      const createdAt = Date.parse(String(payment.creation_started_at));
      const nextLookupAt = payment.create_unknown_next_lookup_at ? Date.parse(String(payment.create_unknown_next_lookup_at)) : Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(createdAt)
        || Number(payment.create_unknown_lookup_attempts) >= CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS
        || timestamp < createdAt
        || timestamp - createdAt > CREATE_UNKNOWN_LOOKUP_WINDOW_MS
        || timestamp < nextLookupAt) continue;
      const fromDate = new Date(createdAt - 5 * 60 * 1_000).toISOString();
      const toDate = new Date(Math.min(timestamp, createdAt + CREATE_UNKNOWN_LOOKUP_WINDOW_MS)).toISOString();
      let operations;
      try {
        operations = await this.provider.findPaymentOperationsByLinkId({ paymentLinkId: String(payment.id), fromDate, toDate });
      } catch (error) {
        const evidence = providerErrorEvidence(error);
        if (evidence.provider_error_code === "PAYMENT_LIST_PAGE_LIMIT") {
          this.reviewCreateUnknownPayment(String(payment.id), {
            reason: "CREATE_UNKNOWN_PROVIDER_PAGE_LIMIT",
            provider_error_class: evidence.provider_error_class,
            provider_error_code: evidence.provider_error_code,
            attempts: Number(payment.create_unknown_lookup_attempts),
            pages_scanned: evidence.pages_scanned,
            page_limit: evidence.page_limit,
          }, evidence);
        } else if (Number(payment.create_unknown_lookup_attempts) + 1 >= CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS) {
          this.reviewCreateUnknownPayment(String(payment.id), {
            reason: "CREATE_UNKNOWN_LOOKUP_EXHAUSTED",
            provider_error_class: evidence.provider_error_class,
            provider_error_code: evidence.provider_error_code,
            attempts: Number(payment.create_unknown_lookup_attempts) + 1,
          }, evidence, Number(payment.create_unknown_lookup_attempts) + 1);
        } else this.deferCreateUnknownLookup(String(payment.id), Number(payment.create_unknown_lookup_attempts), evidence);
        continue;
      }
      if (operations.length === 0) {
        if (Number(payment.create_unknown_lookup_attempts) + 1 >= CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS) this.reviewCreateUnknownPayment(String(payment.id), { reason: "CREATE_UNKNOWN_LOOKUP_EXHAUSTED", attempts: Number(payment.create_unknown_lookup_attempts) + 1 }, undefined, Number(payment.create_unknown_lookup_attempts) + 1);
        else this.deferCreateUnknownLookup(String(payment.id), Number(payment.create_unknown_lookup_attempts));
        continue;
      }
      const operation = operations.length === 1 ? operations[0] : undefined;
      const existingOperationOwner = operation?.operationId
        ? one(this.db, "SELECT id FROM payments WHERE provider_payment_id = ? AND id <> ?", operation.operationId, payment.id)
        : undefined;
      const invalid = !operation
        || operation.paymentLinkId !== payment.id
        || !operation.operationId
        || !operation.paymentLink
        || Boolean(existingOperationOwner)
        || (operation.amountKopecks !== undefined && operation.amountKopecks !== Number(payment.amount_kopecks))
        || operation.customerMatches === false
        || operation.merchantMatches === false;
      if (invalid) {
        this.reviewCreateUnknownPayment(String(payment.id), {
          reason: operations.length === 1 ? "CREATE_UNKNOWN_PROVIDER_OPERATION_MISMATCH" : "CREATE_UNKNOWN_PROVIDER_OPERATION_CONFLICT",
          operation_count: operations.length,
        });
        continue;
      }
      withImmediateTransaction(this.db, () => {
        const recovered = this.db.prepare(`UPDATE payments
          SET state = 'CREATED', provider_payment_id = ?, payment_url = ?,
              create_unknown_next_lookup_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'CREATE_UNKNOWN' AND status = 'PENDING'
            AND provider_payment_id IS NULL`).run(operation.operationId, operation.paymentLink, now(), payment.id);
        if (!recovered.changes) return;
      });
    }
  }

  private createUnknownLookupRetryAt(attempts: number) {
    const exponent = Math.max(0, Math.min(attempts - 1, 16));
    const delay = Math.min(CREATE_UNKNOWN_LOOKUP_INITIAL_BACKOFF_MS * (2 ** exponent), CREATE_UNKNOWN_LOOKUP_MAX_BACKOFF_MS);
    return new Date(this.clock() + delay).toISOString();
  }

  private deferCreateUnknownLookup(paymentId: string, attempts: number, evidence?: import("./provider").ProviderErrorEvidence) {
    const nextAttempts = attempts + 1;
    this.db.prepare(`UPDATE payments
      SET create_unknown_lookup_attempts = ?,
          create_unknown_next_lookup_at = ?, updated_at = ?
          , provider_error_class = COALESCE(?, provider_error_class)
          , provider_error_code = COALESCE(?, provider_error_code)
      WHERE id = ? AND state = 'CREATE_UNKNOWN' AND status = 'PENDING'
        AND provider_payment_id IS NULL`).run(
      nextAttempts,
      nextAttempts >= CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS ? null : this.createUnknownLookupRetryAt(nextAttempts),
      now(),
      evidence?.provider_error_class ?? null,
      evidence?.provider_error_code ?? null,
      paymentId,
    );
  }

  private reviewCreateUnknownPayment(paymentId: string, observed: Record<string, unknown>, evidence?: import("./provider").ProviderErrorEvidence, completedAttempts?: number) {
    withImmediateTransaction(this.db, () => {
      const reviewed = this.db.prepare(`UPDATE payments
        SET status = 'REVIEW_REQUIRED', create_unknown_next_lookup_at = NULL, updated_at = ?,
            create_unknown_lookup_attempts = COALESCE(?, create_unknown_lookup_attempts),
            provider_error_class = COALESCE(?, provider_error_class), provider_error_code = COALESCE(?, provider_error_code)
        WHERE id = ? AND state = 'CREATE_UNKNOWN' AND status = 'PENDING'
          AND provider_payment_id IS NULL`).run(now(), completedAttempts ?? null, evidence?.provider_error_class ?? null, evidence?.provider_error_code ?? null, paymentId);
      if (reviewed.changes) this.recordProviderDrift("PAYMENT", paymentId, { create_unknown_recovery: observed });
    });
  }

  /** Local-only repair after an operator independently proves provider absence. */
  repairCreateUnknownPayment(orderId: string, paymentId: string) {
    return withImmediateTransaction(this.db, () => {
      const payment = one(this.db, `SELECT p.id, b.id AS booking_id, b.status AS booking_status
        FROM payments p JOIN bookings b ON b.order_id = p.order_id
        WHERE p.id = ? AND p.order_id = ?
          AND p.state = 'CREATE_UNKNOWN' AND p.status = 'PENDING'
          AND p.provider_payment_id IS NULL AND p.captured_amount_kopecks = 0
          AND (
            b.status = 'RESERVED'
            OR (b.status = 'CANCELLED' AND b.cancellation_reason = 'TECHNICAL_RESERVATION_ABANDONED')
          )
          AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.booking_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.status = 'SUCCEEDED')`, paymentId, orderId);
      if (!payment) return false;
      const terminalized = this.db.prepare(`UPDATE payments
        SET state = 'CREATE_FAILED', status = 'CANCELLED', updated_at = ?
        WHERE id = ? AND state = 'CREATE_UNKNOWN' AND status = 'PENDING'
          AND provider_payment_id IS NULL AND captured_amount_kopecks = 0`).run(now(), paymentId);
      if (!terminalized.changes) return false;
      if (payment.booking_status === "RESERVED") {
        this.db.prepare(`UPDATE bookings
          SET status = 'CANCELLED', cancelled_at = ?,
              cancellation_reason = 'CREATE_UNKNOWN_PROVIDER_ABSENCE_CONFIRMED'
          WHERE id = ? AND status = 'RESERVED'`).run(now(), payment.booking_id);
      }
      return true;
    });
  }

  async processEmailOutbox() {
    // Two independent reasons not to dispatch, checked before any row is read.
    //
    // The fence is also enforced by a database trigger on the claim itself, so
    // this check is a courtesy to the operator - it makes a fenced sweep a
    // quiet no-op instead of 50 aborted transactions. The trigger, not this,
    // is what makes the fence hold against a binary that predates it.
    if (emailDispatchFenced(this.db)) return;
    // A build must not dispatch against a schema it does not understand.
    const unknown = unknownAppliedMigrations(this.db);
    if (unknown.length > 0) {
      console.error(JSON.stringify({ error: "EMAIL_DISPATCH_HALTED_UNKNOWN_MIGRATIONS", unknown_migrations: unknown }));
      return;
    }
    const timestamp = new Date(this.clock()).toISOString();
    // Authority-aware candidate scan. Under ATTEMPT the legacy next_attempt_at
    // is frozen, so filtering on it here would hide due retries and admit early
    // ones - and no freeze trigger fires, because a stale READ writes nothing.
    const rows = dispatchCandidates(this.db, timestamp, 50) as Array<Record<string, unknown>>;
    for (const outbox of rows) {
      if (outbox.type === "CITY_INTEREST_AVAILABLE" || outbox.type === "OCCURRENCE_AVAILABLE") {
        const active = withImmediateTransaction(this.db, () => {
          if (outbox.type === "CITY_INTEREST_AVAILABLE" ? this.isActiveCityInterestNotification(String(outbox.id)) : this.isActiveOccurrenceNotification(String(outbox.id))) return true;
          if (outbox.type === "CITY_INTEREST_AVAILABLE") this.suppressCityInterestOutbox(String(outbox.id));
          else this.suppressOccurrenceNotificationOutbox(String(outbox.id));
          return false;
        });
        if (!active) continue;
      }
      if (outbox.status === "PENDING" && outbox.type === "CUSTOMER_REFUND_CONFIRMATION" && !this.isCurrentRefundConfirmationOutbox(outbox)) {
        // A later request superseded this capability, or it is no longer usable.
        // SKIPPED is terminal and deliberately not an email-provider failure.
        if (this.skipObsoleteRefundConfirmationOutbox(String(outbox.id))) continue;
      }
      const isUnknown = outbox.status === "SEND_UNKNOWN";
      if (isUnknown && this.reconcileLegacyUnisenderHttp403(String(outbox.id))) continue;
      // A known provider job is always reconciled before another send. It is
      // never considered proof that the original request was not dispatched.
      // Identity and try count are resolved ONCE, in one transaction, and
      // carried across the external provider call. Rediscovering "the current
      // attempt" afterwards would let evidence retrieved for one attempt be
      // applied to another if authority or the attempt changed in between.
      const { lookupIdentity, attemptRef, tryCount } = withImmediateTransaction(this.db, () => ({
        lookupIdentity: providerLookupIdentity(this.db, outbox as { id: string; job_id: unknown; provider_idempotence_key: unknown }),
        attemptRef: resolveAttemptRef(this.db, String(outbox.id)),
        tryCount: sendTryCount(this.db, { id: String(outbox.id), attempts: outbox.attempts }),
      }));
      if (isUnknown && lookupIdentity.jobId) {
        try {
          const observed = await this.emailProvider.lookup({ jobId: lookupIdentity.jobId, idempotencyKey: lookupIdentity.idempotencyKey });
          if (observed.status === "UNKNOWN") this.deferUnknownEmailObservation(String(outbox.id), tryCount, attemptRef);
          else this.applyEmailObservation(outbox.id as string, observed, attemptRef);
        }
        catch { this.deferUnknownEmailObservation(String(outbox.id), tryCount, attemptRef); }
        continue;
      }
      if (isUnknown && tryCount >= EMAIL_SEND_UNKNOWN_MAX_ATTEMPTS) {
        this.failExhaustedUnknownEmail(String(outbox.id), attemptRef);
        continue;
      }
      if (isUnknown) {
        try {
          const observed = await this.emailProvider.lookup({ idempotencyKey: lookupIdentity.idempotencyKey });
          if (observed.status !== "UNKNOWN") { this.applyEmailObservation(outbox.id as string, observed, attemptRef); continue; }
        } catch { /* same idempotency key will be used if a retry becomes possible */ }
      }
      const claimed = withImmediateTransaction(this.db, () => {
        if (outbox.type === "CITY_INTEREST_AVAILABLE" && !this.isActiveCityInterestNotification(String(outbox.id))) {
          this.suppressCityInterestOutbox(String(outbox.id));
          return 0;
        }
        if (outbox.type === "OCCURRENCE_AVAILABLE" && !this.isActiveOccurrenceNotification(String(outbox.id))) {
          this.suppressOccurrenceNotificationOutbox(String(outbox.id));
          return 0;
        }
        // Recheck inside the claim transaction so an invalidated queued token
        // cannot race into a fresh provider send.
        if (outbox.status === "PENDING" && outbox.type === "CUSTOMER_REFUND_CONFIRMATION" && !this.isCurrentRefundConfirmationOutbox(outbox)) {
          this.skipObsoleteRefundConfirmationOutbox(String(outbox.id));
          return 0;
        }
        // The selector is read inside this transaction by claimForDispatch,
        // never hoisted: a provider callback can race the activation CAS.
        return claimForDispatch(
          this.db,
          { id: String(outbox.id), provider_idempotence_key: String(outbox.provider_idempotence_key) },
          `worker-${process.pid}`,
          timestamp,
        );
      });
      if (!claimed) continue;
      try {
        const payload = this.emailPayload(outbox);
        // The key comes from the claim, not from the pre-claim message snapshot.
        // Under LEGACY they are the same value, so the snapshot would be
        // accidentally correct for attempt #1 and wrong the moment a resend
        // mints attempt #2 with its own key.
        const sent = await this.emailProvider.send({ recipientEmail: String(outbox.recipient_email), template: String(outbox.template), type: String(outbox.type), payload, idempotencyKey: claimed.provider_idempotence_key, outboxId: String(outbox.id) });
        withImmediateTransaction(this.db, () => {
          recordProviderAcceptance(this.db, { id: String(outbox.id) }, claimed, sent.jobId);
        });
      } catch (error) {
        if (error instanceof EmailProviderRejectedError) {
          // A received HTTP response is authoritative evidence that this
          // dispatch was rejected. Do not convert it into an ambiguous replay.
          withImmediateTransaction(this.db, () => {
            recordProviderRefusal(this.db, { id: String(outbox.id) }, claimed, { providerCode: error.providerCode, providerMessage: error.providerMessage });
          });
        } else {
          // A timeout/network loss after a request starts cannot prove the
          // provider did not accept it. Keep the stable idempotence key, but
          // make recovery finite and rate-limited.
          // The ref for THIS provider call is the one the claim actually took.
          // attemptRef was resolved before the lookup, and the claim may since
          // have taken a successor - writing the failure against the
          // predecessor would land on the wrong attempt.
          this.deferOrFailUnknownEmail(String(outbox.id), claimed.send_try_count, claimedAttemptRef(claimed));
        }
      }
    }
  }

  /** Batches unresolved provider jobs; webhook delivery remains the fast path. */
  async reconcileUnisenderEventDumps() {
    if (!isEmailDeliveryEvidenceProvider(this.emailProvider)) return;
    const timestamp = new Date(this.clock()).toISOString();
    this.failStaleUnisenderEventDumpCreates(timestamp);
    const poll = this.claimUnisenderEventDumpRun(timestamp);
    if (poll) return this.pollUnisenderEventDumpRun(poll, timestamp);
    const lease = this.reserveUnisenderEventDumpCreateLease(timestamp);
    if (lease) await this.createUnisenderEventDumpRun(lease, timestamp);
  }

  private failStaleUnisenderEventDumpCreates(timestamp: string) {
    this.db.prepare(`UPDATE unisender_event_dump_runs
      SET state = 'CREATE_UNKNOWN', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = 'CREATE_RESPONSE_UNKNOWN', updated_at = ?
      WHERE state = 'CREATE_IN_FLIGHT' AND lease_expires_at < ?`).run(timestamp, timestamp);
  }

  private reserveUnisenderEventDumpCreateLease(timestamp: string) {
    return withImmediateTransaction(this.db, () => {
      const lease = `event-dump-create-${id()}`;
      const locked = this.db.prepare(`UPDATE unisender_event_dump_control
        SET create_lease_owner = ?, create_lease_expires_at = ?
        WHERE singleton = 1 AND (create_lease_expires_at IS NULL OR create_lease_expires_at < ?)
          AND (next_create_probe_at IS NULL OR next_create_probe_at <= ?)`)
        .run(lease, new Date(this.clock() + 120_000).toISOString(), timestamp, timestamp);
      if (!locked.changes) return undefined;
      const attempts = Number(one(this.db, `SELECT COUNT(*) AS count FROM unisender_event_dump_create_attempts
        WHERE started_at >= ?`, new Date(this.clock() - 8 * 60 * 60 * 1_000).toISOString())?.count ?? 0);
      if (attempts >= UNISENDER_EVENT_DUMP_MAX_CREATES_PER_EIGHT_HOURS) {
        const earliest = one(this.db, "SELECT MIN(started_at) AS started_at FROM unisender_event_dump_create_attempts WHERE started_at >= ?", new Date(this.clock() - 8 * 60 * 60 * 1_000).toISOString());
        const nextProbe = new Date(Date.parse(String(earliest?.started_at)) + 8 * 60 * 60 * 1_000).toISOString();
        this.db.prepare(`UPDATE unisender_event_dump_control
          SET create_lease_owner = NULL, create_lease_expires_at = NULL,
              next_create_probe_at = ?, create_probe_failures = 0,
              last_create_probe_error = 'LOCAL_CREATE_CAP'
          WHERE singleton = 1 AND create_lease_owner = ?`).run(nextProbe, lease);
        return undefined;
      }
      // Avoid an unnecessary provider list call when no target can be due.
      const grace = new Date(this.clock() - UNISENDER_EVENT_DUMP_GRACE_MS).toISOString();
      const candidate = one(this.db, `SELECT outbox.id,
        COALESCE(outbox.provider_request_started_at, outbox.send_started_at, outbox.created_at) AS dispatch_at
        FROM email_outbox outbox
        WHERE outbox.superseded_at IS NULL AND outbox.status IN ('ACCEPTED', 'SENT')
          AND outbox.job_id IS NOT NULL AND trim(outbox.job_id) != ''
          AND datetime(COALESCE(outbox.provider_request_started_at, outbox.send_started_at, outbox.created_at)) <= datetime(?)
          AND NOT EXISTS (
            SELECT 1 FROM unisender_event_dump_targets target
            WHERE target.outbox_id = outbox.id AND (
              target.state IN ('ACTIVE', 'CONSUMED', 'NO_LONGER_NEEDED')
              OR (target.state = 'RETRY_WAIT' AND target.next_attempt_at > ?)
            )
          )
        ORDER BY dispatch_at, outbox.id LIMIT 1`, grace, timestamp);
      if (!candidate) { this.releaseUnisenderEventDumpCreateLease(lease); return undefined; }
      return lease;
    });
  }

  /**
   * The provider-side count is authoritative. This runs while the durable
   * local singleton fence is owned, then the actual external create gets a
   * second durable transaction immediately before its POST.
   */
  private reserveUnisenderEventDumpRunAfterProviderList(lease: string, timestamp: string) {
    return withImmediateTransaction(this.db, () => {
      const control = one(this.db, "SELECT create_lease_owner FROM unisender_event_dump_control WHERE singleton = 1");
      if (control?.create_lease_owner !== lease) return undefined;
      this.db.prepare(`UPDATE unisender_event_dump_control
        SET next_create_probe_at = NULL, create_probe_failures = 0, last_create_probe_error = NULL
        WHERE singleton = 1 AND create_lease_owner = ?`).run(lease);
      const attempts = Number(one(this.db, `SELECT COUNT(*) AS count FROM unisender_event_dump_create_attempts
        WHERE started_at >= ?`, new Date(this.clock() - 8 * 60 * 60 * 1_000).toISOString())?.count ?? 0);
      if (attempts >= UNISENDER_EVENT_DUMP_MAX_CREATES_PER_EIGHT_HOURS) {
        const earliest = one(this.db, "SELECT MIN(started_at) AS started_at FROM unisender_event_dump_create_attempts WHERE started_at >= ?", new Date(this.clock() - 8 * 60 * 60 * 1_000).toISOString());
        const nextProbe = new Date(Date.parse(String(earliest?.started_at)) + 8 * 60 * 60 * 1_000).toISOString();
        this.db.prepare(`UPDATE unisender_event_dump_control
          SET create_lease_owner = NULL, create_lease_expires_at = NULL,
              next_create_probe_at = ?, create_probe_failures = 0,
              last_create_probe_error = 'LOCAL_CREATE_CAP'
          WHERE singleton = 1 AND create_lease_owner = ?`).run(nextProbe, lease);
        return undefined;
      }
      const grace = new Date(this.clock() - UNISENDER_EVENT_DUMP_GRACE_MS).toISOString();
      const targeted = one(this.db, `SELECT target.id AS retry_target_id, outbox.id, target.job_id,
          COALESCE(outbox.provider_request_started_at, outbox.send_started_at, outbox.created_at) AS dispatch_at,
          'TARGETED_JOB' AS recovery_mode
        FROM unisender_event_dump_targets target
        JOIN email_outbox outbox ON outbox.id = target.outbox_id
        WHERE target.state = 'RETRY_WAIT' AND target.recovery_mode = 'TARGETED_JOB'
          AND target.next_attempt_at <= ? AND outbox.superseded_at IS NULL
          AND outbox.status IN ('ACCEPTED', 'SENT') AND outbox.job_id = target.job_id
        ORDER BY target.next_attempt_at, target.created_at LIMIT 1`, timestamp);
      const candidates = targeted ? [targeted] : many(this.db, `SELECT outbox.id, outbox.job_id,
          COALESCE(outbox.provider_request_started_at, outbox.send_started_at, outbox.created_at) AS dispatch_at
        FROM email_outbox outbox
        WHERE outbox.superseded_at IS NULL AND outbox.status IN ('ACCEPTED', 'SENT')
          AND outbox.job_id IS NOT NULL AND trim(outbox.job_id) != ''
          AND datetime(COALESCE(outbox.provider_request_started_at, outbox.send_started_at, outbox.created_at)) <= datetime(?)
          AND NOT EXISTS (
            SELECT 1 FROM unisender_event_dump_targets target
            WHERE target.outbox_id = outbox.id AND (
              target.state IN ('ACTIVE', 'CONSUMED', 'NO_LONGER_NEEDED')
              OR (target.state = 'RETRY_WAIT' AND target.next_attempt_at > ?)
            )
          )
        ORDER BY dispatch_at, outbox.id LIMIT 50`, grace, timestamp);
      if (!candidates.length) { this.releaseUnisenderEventDumpCreateLease(lease); return undefined; }
      const runId = id();
      const earliest = Math.min(...candidates.map((candidate) => Date.parse(String(candidate.dispatch_at))).filter(Number.isFinite));
      if (!Number.isFinite(earliest)) { this.releaseUnisenderEventDumpCreateLease(lease); return undefined; }
      const jobIdFilter = targeted ? String(targeted.job_id) : null;
      this.db.prepare(`INSERT INTO unisender_event_dump_runs
        (id, state, start_time, end_time, create_started_at, next_attempt_at, requested_limit, job_id_filter, lease_owner, lease_expires_at)
        VALUES (?, 'CREATE_IN_FLIGHT', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runId, this.unisenderDumpTime(new Date(earliest - 60_000)), this.unisenderDumpTime(new Date(this.clock() + 60_000)), timestamp, timestamp, UNISENDER_EVENT_DUMP_EVENT_LIMIT, jobIdFilter, lease, new Date(this.clock() + 120_000).toISOString());
      if (targeted) this.db.prepare(`UPDATE unisender_event_dump_targets
        SET state = 'NO_LONGER_NEEDED', updated_at = ? WHERE id = ? AND state = 'RETRY_WAIT'`).run(timestamp, targeted.retry_target_id);
      const target = this.db.prepare(`INSERT INTO unisender_event_dump_targets(id, run_id, outbox_id, job_id, state, recovery_mode)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?)`);
      for (const candidate of candidates) target.run(id(), runId, candidate.id, candidate.job_id, targeted ? "TARGETED_JOB" : "BATCH");
      // Persist before the external POST: a lost response is still one counted
      // provider command and must never trigger an uncontrolled create loop.
      this.db.prepare("INSERT INTO unisender_event_dump_create_attempts(id, started_at) VALUES (?, ?)").run(id(), timestamp);
      return { id: runId, start_time: this.unisenderDumpTime(new Date(earliest - 60_000)), end_time: this.unisenderDumpTime(new Date(this.clock() + 60_000)), job_id_filter: jobIdFilter, lease };
    });
  }

  private releaseUnisenderEventDumpCreateLease(lease: string) {
    this.db.prepare("UPDATE unisender_event_dump_control SET create_lease_owner = NULL, create_lease_expires_at = NULL WHERE singleton = 1 AND create_lease_owner = ?").run(lease);
  }

  private deferUnisenderEventDumpCreateProbe(lease: string, timestamp: string, code: "LIST_UNAVAILABLE" | "PROVIDER_DUMP_CAPACITY") {
    withImmediateTransaction(this.db, () => {
      const control = one(this.db, `SELECT create_probe_failures FROM unisender_event_dump_control
        WHERE singleton = 1 AND create_lease_owner = ?`, lease);
      if (!control) return;
      const failures = Number(control.create_probe_failures) + 1;
      const delay = Math.min(
        UNISENDER_EVENT_DUMP_CREATE_PROBE_INITIAL_BACKOFF_MS * (2 ** Math.max(0, failures - 1)),
        UNISENDER_EVENT_DUMP_CREATE_PROBE_MAX_BACKOFF_MS,
      );
      this.db.prepare(`UPDATE unisender_event_dump_control
        SET create_lease_owner = NULL, create_lease_expires_at = NULL,
            next_create_probe_at = ?, create_probe_failures = ?, last_create_probe_error = ?
        WHERE singleton = 1 AND create_lease_owner = ?`)
        .run(new Date(this.clock() + delay).toISOString(), failures, code, lease);
    });
  }

  private async createUnisenderEventDumpRun(lease: string, timestamp: string) {
    if (!isEmailDeliveryEvidenceProvider(this.emailProvider)) return;
    let providerCount: { count: number };
    try {
      providerCount = await this.emailProvider.listEventDumps();
    } catch {
      // No create was issued. Preserve targets and pace later read-only probes.
      this.deferUnisenderEventDumpCreateProbe(lease, timestamp, "LIST_UNAVAILABLE");
      return;
    }
    if (providerCount.count >= UNISENDER_EVENT_DUMP_MAX_EXISTING_PROVIDER_DUMPS) {
      this.deferUnisenderEventDumpCreateProbe(lease, timestamp, "PROVIDER_DUMP_CAPACITY");
      return;
    }
    const run = this.reserveUnisenderEventDumpRunAfterProviderList(lease, timestamp);
    if (!run) return;
    try {
      const dump = await this.emailProvider.createEventDump({ startTime: run.start_time, endTime: run.end_time, jobId: run.job_id_filter ?? undefined });
      withImmediateTransaction(this.db, () => {
        this.db.prepare(`UPDATE unisender_event_dump_runs
          SET state = 'POLL_READY', dump_id = ?, next_attempt_at = ?, lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
          WHERE id = ? AND state = 'CREATE_IN_FLIGHT' AND lease_owner = ?`)
          .run(dump.dumpId, new Date(this.clock() + UNISENDER_EVENT_DUMP_POLL_MS).toISOString(), timestamp, run.id, run.lease);
        this.releaseUnisenderEventDumpCreateLease(run.lease);
      });
    } catch (error) {
      withImmediateTransaction(this.db, () => {
        if (error instanceof EventDumpCreateRejectedError) {
          this.deferUnisenderEventDumpCreate(run.id, run.lease, timestamp, `CREATE_REJECTED_HTTP_${error.httpStatus}`);
          return;
        }
        this.db.prepare(`UPDATE unisender_event_dump_runs
          SET state = 'CREATE_UNKNOWN', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = 'CREATE_RESPONSE_UNKNOWN', updated_at = ?
          WHERE id = ? AND state = 'CREATE_IN_FLIGHT' AND lease_owner = ?`).run(timestamp, run.id, run.lease);
        this.releaseUnisenderEventDumpCreateLease(run.lease);
      });
    }
  }

  /** Deterministic provider rejection is not ambiguous create evidence. */
  private deferUnisenderEventDumpCreate(runId: string, lease: string, timestamp: string, code: string) {
    const retryAt = new Date(this.clock() + UNISENDER_EVENT_DUMP_REEXPORT_MS).toISOString();
    this.db.prepare(`UPDATE unisender_event_dump_targets
      SET state = 'RETRY_WAIT', next_attempt_at = ?, updated_at = ?
      WHERE run_id = ? AND state = 'ACTIVE'`).run(retryAt, timestamp, runId);
    this.db.prepare(`UPDATE unisender_event_dump_runs
      SET state = 'EXHAUSTED', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'CREATE_IN_FLIGHT' AND lease_owner = ?`)
      .run(code, timestamp, runId, lease);
    this.releaseUnisenderEventDumpCreateLease(lease);
  }

  private claimUnisenderEventDumpRun(timestamp: string) {
    const run = one(this.db, `SELECT * FROM unisender_event_dump_runs
      WHERE state IN ('POLL_READY', 'POLL_RETRY') AND next_attempt_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      ORDER BY next_attempt_at, created_at LIMIT 1`, timestamp, timestamp);
    if (!run) return undefined;
    const lease = `event-dump-poll-${id()}`;
    const claimed = this.db.prepare(`UPDATE unisender_event_dump_runs
      SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('POLL_READY', 'POLL_RETRY')
        AND (lease_expires_at IS NULL OR lease_expires_at < ?)`)
      .run(lease, new Date(this.clock() + 120_000).toISOString(), timestamp, run.id, timestamp);
    return claimed.changes ? { ...run, lease } : undefined;
  }

  private async pollUnisenderEventDumpRun(run: Row & { lease: string }, timestamp: string) {
    if (!isEmailDeliveryEvidenceProvider(this.emailProvider) || typeof run.dump_id !== "string") return;
    try {
      const dump = await this.emailProvider.getEventDump({ dumpId: run.dump_id });
      if (dump.status === "failed") {
        this.finishUnisenderEventDumpRun(String(run.id), String(run.lease), timestamp, "FAILED");
        return;
      }
      for (const event of dump.events) this.applyUnisenderDumpEvent(String(run.id), event);
      if (dump.status === "ready") {
        // An evidence adapter without a raw count cannot prove this export was
        // complete, so it follows the same fail-closed targeted recovery.
        const saturated = typeof dump.returnedEventCount !== "number"
          || dump.returnedEventCount >= Number(run.requested_limit ?? UNISENDER_EVENT_DUMP_EVENT_LIMIT);
        this.finishUnisenderEventDumpRun(String(run.id), String(run.lease), timestamp, "READY", saturated, typeof run.job_id_filter === "string" && run.job_id_filter.length > 0);
        return;
      }
      this.deferUnisenderEventDumpPoll(String(run.id), String(run.lease), timestamp, "IN_PROCESS");
    } catch {
      this.deferUnisenderEventDumpPoll(String(run.id), String(run.lease), timestamp, "POLL_UNAVAILABLE");
    }
  }

  private deferUnisenderEventDumpPoll(runId: string, lease: string, timestamp: string, code: string) {
    const run = one(this.db, "SELECT poll_attempts FROM unisender_event_dump_runs WHERE id = ? AND lease_owner = ?", runId, lease);
    if (!run) return;
    const attempts = Number(run.poll_attempts) + 1;
    if (attempts >= UNISENDER_EVENT_DUMP_MAX_POLL_ATTEMPTS) {
      this.finishUnisenderEventDumpRun(runId, lease, timestamp, "POLL_EXHAUSTED");
      return;
    }
    const delay = Math.min(UNISENDER_EVENT_DUMP_POLL_MS * (2 ** Math.max(0, attempts - 1)), UNISENDER_EVENT_DUMP_MAX_POLL_BACKOFF_MS);
    this.db.prepare(`UPDATE unisender_event_dump_runs
      SET state = 'POLL_RETRY', next_attempt_at = ?, poll_attempts = ?,
          last_error_code = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ?`)
      .run(new Date(this.clock() + delay).toISOString(), attempts, code, timestamp, runId, lease);
  }

  private finishUnisenderEventDumpRun(
    runId: string,
    lease: string,
    timestamp: string,
    outcome: "READY" | "FAILED" | "POLL_EXHAUSTED",
    saturated = false,
    wasTargeted = false,
  ) {
    const retryAt = new Date(this.clock() + UNISENDER_EVENT_DUMP_REEXPORT_MS).toISOString();
    this.db.prepare(`UPDATE unisender_event_dump_targets
      SET state = CASE WHEN EXISTS (
          SELECT 1 FROM email_outbox outbox WHERE outbox.id = unisender_event_dump_targets.outbox_id
            AND (outbox.status IN ('DELIVERED', 'BOUNCED')
              OR (outbox.status = 'FAILED' AND outbox.delivery_outcome = 'KNOWN_FAILED'))
        ) THEN 'CONSUMED'
        WHEN EXISTS (
          SELECT 1 FROM email_outbox outbox WHERE outbox.id = unisender_event_dump_targets.outbox_id
            AND outbox.superseded_at IS NOT NULL
        ) THEN 'NO_LONGER_NEEDED'
        ELSE 'RETRY_WAIT' END,
        next_attempt_at = CASE WHEN state = 'ACTIVE' THEN ? ELSE next_attempt_at END,
        recovery_mode = CASE
          WHEN ? = 1 AND ? = 0
            AND NOT EXISTS (SELECT 1 FROM email_outbox outbox WHERE outbox.id = unisender_event_dump_targets.outbox_id
              AND ((outbox.status IN ('DELIVERED', 'BOUNCED')
                    OR (outbox.status = 'FAILED' AND outbox.delivery_outcome = 'KNOWN_FAILED'))
                OR outbox.superseded_at IS NOT NULL))
          THEN 'TARGETED_JOB'
          ELSE recovery_mode
        END,
        updated_at = ?
      WHERE run_id = ? AND state = 'ACTIVE'`).run(retryAt, saturated ? 1 : 0, wasTargeted ? 1 : 0, timestamp, runId);
    this.db.prepare(`UPDATE unisender_event_dump_runs
      SET state = ?, dump_id = NULL, next_attempt_at = ?, last_error_code = ?,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND lease_owner = ?`)
      .run(outcome === "READY" ? "CONSUMED" : "EXHAUSTED", timestamp, outcome === "READY" ? null : outcome, timestamp, runId, lease);
  }

  private applyUnisenderDumpEvent(runId: string, event: UnisenderDumpEvent) {
    if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) return;
    const outboxId = (event.metadata as Record<string, unknown>).outbox_id;
    if (typeof outboxId !== "string") return;
    const target = one(this.db, `SELECT outbox_id, job_id FROM unisender_event_dump_targets
      WHERE run_id = ? AND outbox_id = ? AND job_id = ? AND state = 'ACTIVE'`, runId, outboxId, event.jobId);
    if (!target) return;
    const providerStatus = event.status.toLowerCase();
    const status = providerStatus === "accepted" ? "ACCEPTED" : providerStatus === "sent" ? "SENT"
      : providerStatus === "delivered" ? "DELIVERED" : ["soft_bounced", "hard_bounced", "spam"].includes(providerStatus) ? "BOUNCED" : undefined;
    if (!status || !event.eventTime || !event.deliveryStatus) return;
    const semanticKey = `unisender:event-dump:${sha256(canonical({ outbox_id: target.outbox_id, job_id: event.jobId, status: providerStatus, delivery_status: event.deliveryStatus, event_time: event.eventTime }))}`;
    this.applyUnisenderDelivery({ outboxId: String(target.outbox_id), status, providerStatus: providerStatus as "accepted" | "sent" | "delivered" | "soft_bounced" | "hard_bounced" | "spam", jobId: event.jobId, semanticKey });
  }

  private unisenderDumpTime(date: Date) {
    return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  }

  private unknownEmailRetryAt(attempts: number) {
    const exponent = Math.max(0, Math.min(attempts - 1, 16));
    const delay = Math.min(EMAIL_SEND_UNKNOWN_INITIAL_BACKOFF_MS * (2 ** exponent), EMAIL_SEND_UNKNOWN_MAX_BACKOFF_MS);
    return new Date(this.clock() + delay).toISOString();
  }

  private deferUnknownEmailObservation(outboxId: string, attempts: number, ref: AttemptRef) {
    withImmediateTransaction(this.db, () =>
      deferAmbiguousObservation(this.db, { id: outboxId }, ref, this.unknownEmailRetryAt(Math.max(1, attempts))));
  }

  private failExhaustedUnknownEmail(outboxId: string, ref: AttemptRef) {
    withImmediateTransaction(this.db, () => failExhaustedAmbiguous(this.db, { id: outboxId }, ref, "SEND_UNKNOWN"));
  }

  /**
   * Old deployments represented every send exception as SEND_UNKNOWN. This
   * exact historical 403 signature is deterministic provider rejection, not
   * transport ambiguity. Keep the predicate intentionally narrow so unrelated
   * historical unknowns retain their original recovery semantics.
   */
  private reconcileLegacyUnisenderHttp403(outboxId?: string) {
    return this.atomically(() => reconcileHistoricalHttp403(this.db, outboxId ?? null));
  }

  private deferOrFailUnknownEmail(outboxId: string, attempts: number, ref: AttemptRef) {
    withImmediateTransaction(this.db, () => {
      if (attempts >= EMAIL_SEND_UNKNOWN_MAX_ATTEMPTS) {
        failExhaustedAmbiguous(this.db, { id: outboxId }, ref, "SENDING");
        return;
      }
      deferAmbiguousSend(this.db, { id: outboxId }, ref, this.unknownEmailRetryAt(attempts), { supersession: "ANY", requireUnsuppressed: false });
    });
  }

  /** Daily reconciliation records disagreement as review work; it never rewrites local history. */
  async collectProviderDrift() {
    const payments = many(this.db, "SELECT id, provider_payment_id, status, captured_amount_kopecks FROM payments WHERE provider_payment_id IS NOT NULL AND status IN ('PENDING', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')");
    for (const payment of payments) {
      try {
        const observed = await this.provider.reconcilePayment({ providerPaymentId: String(payment.provider_payment_id) });
        const mismatch = (payment.status === "PAID" && observed.status !== "PAID") || (payment.status === "PENDING" && observed.status === "PAID");
        if (mismatch) this.recordProviderDrift("PAYMENT", String(payment.id), { local_status: payment.status, local_amount_kopecks: payment.captured_amount_kopecks, observed });
      } catch { /* live providers are deliberately excluded from readiness */ }
    }
    const refunds = many(this.db, "SELECT r.id, r.provider_reference, r.status, r.amount_kopecks, r.idempotency_key_hash, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.provider_reference IS NOT NULL AND r.status IN ('RECONCILING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED')");
    for (const refund of refunds) {
      try {
        if (!refund.provider_payment_id) continue;
        const observed = await this.provider.reconcileRefund({ providerPaymentId: String(refund.provider_payment_id), providerReference: String(refund.provider_reference), amountKopecks: Number(refund.amount_kopecks), idempotencyKey: String(refund.idempotency_key_hash) });
        const mismatch = (refund.status === "SUCCEEDED" && observed.status !== "SUCCEEDED") || (refund.status === "FAILED" && observed.status === "SUCCEEDED");
        if (mismatch) this.recordProviderDrift("REFUND", String(refund.id), { local_status: refund.status, local_amount_kopecks: refund.amount_kopecks, observed });
      } catch { /* provider unavailable */ }
    }
  }

  private emailPayload(outbox: Row) {
    const payload = JSON.parse(String(outbox.payload_snapshot)) as Record<string, unknown>;
    if (outbox.type === "TICKET" && outbox.payload_ref) {
      const ticket = one(this.db, "SELECT capability_ciphertext, capability_nonce FROM tickets WHERE id = ?", outbox.payload_ref);
      if (!ticket) throw new Error("Ticket email references no ticket.");
      payload.ticket_url = `${process.env.COMMERCE_PUBLIC_ORIGIN ?? "https://flexperiment.ru"}/ticket#${decryptTicketCapability(String(ticket.capability_ciphertext), String(ticket.capability_nonce))}`;
    }
    if (outbox.type === "CUSTOMER_REFUND_CONFIRMATION" && outbox.payload_ref) {
      const token = one(this.db, "SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE id = ?", outbox.payload_ref);
      if (!token) throw new Error("Customer refund email references no confirmation token.");
      payload.confirmation_url = `${process.env.COMMERCE_PUBLIC_ORIGIN ?? "https://flexperiment.ru"}/refund/confirm#${decryptTicketCapability(String(token.token_ciphertext), String(token.token_nonce))}`;
    }
    return payload;
  }

  private isCurrentRefundConfirmationOutbox(outbox: Row) {
    if (!outbox.payload_ref) return false;
    const token = one(this.db, `SELECT id FROM customer_refund_confirmation_tokens
      WHERE id = ? AND invalidated_at IS NULL AND consumed_at IS NULL AND expires_at > ?`, outbox.payload_ref, new Date(this.clock()).toISOString());
    return Boolean(token);
  }

  private skipObsoleteRefundConfirmationOutbox(outboxId: string) {
    // This is a strict compare-and-set. A worker with a stale PENDING snapshot
    // must never relabel a newer SEND_UNKNOWN provider outcome as SKIPPED.
    return this.atomically(() => skipObsoletePendingMessage(this.db, outboxId));
  }

  /**
   * A newer customer-visible revision makes queued notices obsolete. Provider
   * evidence is retained: SENT/DELIVERED rows are historical dispatch facts
   * and a SENDING row is only prevented from being revived after its in-flight
   * call returns.
   */
  private supersedePendingOccurrenceUpdatesForBooking(bookingId: string, reason: string) {
    const timestamp = now();
    const pending = many(this.db, `SELECT n.id, n.outbox_id
      FROM occurrence_update_notifications n
      JOIN email_outbox e ON e.id = n.outbox_id
      WHERE n.booking_id = ? AND n.superseded_at IS NULL
        AND e.status IN ('PENDING', 'SENDING', 'ACCEPTED', 'SEND_UNKNOWN')`, bookingId);
    for (const notification of pending) {
      // PENDING has definitely not crossed the provider boundary. Every
      // other state may already represent a real delivery attempt, so retain
      // that status and accept later provider evidence, while the superseded
      // marker prevents any future local send/retry.
      const updated = { changes: this.atomically(() =>
          supersedeQueuedMessage(this.db, String(notification.outbox_id), timestamp, reason)) };
      if (updated.changes) this.db.prepare(`UPDATE occurrence_update_notifications
        SET superseded_at = ?, superseded_reason = ? WHERE id = ? AND superseded_at IS NULL`)
        .run(timestamp, reason, notification.id);
    }
  }

  private pendingOccurrenceUpdateBaseline(bookingId: string): PendingOccurrenceUpdateBaseline | null {
    const notifications = many(this.db, `SELECT notification.occurrence_revision_id, notification.outbox_id,
        outbox.payload_snapshot, revision.before_json AS revision_before_json
      FROM occurrence_update_notifications notification
      JOIN email_outbox outbox ON outbox.id = notification.outbox_id
      JOIN occurrence_revisions revision ON revision.id = notification.occurrence_revision_id
      WHERE notification.booking_id = ?
        AND notification.superseded_at IS NULL
        AND outbox.status = 'PENDING'
      ORDER BY notification.created_at ASC, notification.id ASC`, bookingId);
    if (!notifications.length) return null;
    const corruptNotifications: CorruptOccurrenceNotification[] = [];
    const recoveredCorruptNotifications: CorruptOccurrenceNotification[] = [];
    let earliest: OccurrenceCustomerSnapshot | null = null;
    for (const notification of notifications) {
      try {
        const payload = JSON.parse(String(notification.payload_snapshot)) as { before?: unknown };
        if (!isOccurrenceCustomerSnapshot(payload.before)) throw new Error("invalid occurrence baseline");
        if (!earliest) earliest = payload.before;
      } catch {
        const corrupt = { outboxId: String(notification.outbox_id), revisionId: String(notification.occurrence_revision_id) };
        try {
          const revisionBefore = JSON.parse(String(notification.revision_before_json));
          if (!isOccurrenceCustomerSnapshot(revisionBefore)) throw new Error("invalid occurrence revision baseline");
          if (!earliest) earliest = revisionBefore;
          recoveredCorruptNotifications.push(corrupt);
        } catch {
          corruptNotifications.push(corrupt);
        }
      }
    }
    if (corruptNotifications.length) return { corruptNotifications };
    return {
      before: earliest!, revisionIds: notifications.map((notification) => String(notification.occurrence_revision_id)),
      recoveredCorruptNotifications,
    };
  }

  private hasOpenOccurrenceChangeRefundEntitlement(bookingId: string) {
    return Boolean(one(this.db, `SELECT 1 AS present
      FROM occurrence_change_refund_entitlements
      WHERE booking_id = ? AND status = 'OPEN' LIMIT 1`, bookingId));
  }

  private closeOccurrenceChangeRefundEntitlementsForBooking(bookingId: string, reason: string) {
    this.db.prepare(`UPDATE occurrence_change_refund_entitlements
      SET status = 'CLOSED', closed_at = ?, closed_reason = ?
      WHERE booking_id = ? AND status = 'OPEN'`).run(now(), reason, bookingId);
  }

  private closeOccurrenceChangeRefundEntitlementsForOrder(orderId: string, reason: string) {
    this.db.prepare(`UPDATE occurrence_change_refund_entitlements
      SET status = 'CLOSED', closed_at = ?, closed_reason = ?
      WHERE order_id = ? AND status = 'OPEN'`).run(now(), reason, orderId);
  }

  /**
   * A message and its first attempt are created together or not at all.
   *
   * The atomicity is owned HERE, not delegated to the caller. Joining an outer
   * transaction is not enough: SQLite does not undo an earlier statement when a
   * later one fails, so a caller that catches the enqueue error and commits
   * anyway would leave a message with no attempt #1. A nested transaction gives
   * this pair its own SAVEPOINT, so it succeeds or fails as a unit whatever the
   * caller does with the exception, while the outer transaction keeps owning
   * the broader business atomicity.
   *
   * The property being established is not that two inserts sit next to each
   * other - it is that a newly created message without attempt #1 cannot exist.
   *
   * The provider key is minted ONCE and copied byte-for-byte into both stores:
   *
   *   LEGACY    email_outbox.provider_idempotence_key   authoritative
   *             outbox_attempt #1                       shadow
   *   ATTEMPT   outbox_attempt.provider_idempotence_key authoritative
   *             email_outbox                            write-once shadow
   *
   * No selector branch is needed here. Attempt #1 should exist in either
   * authority state once an 0041-aware binary is running, and the attempt row
   * is not authoritative until the activation CAS - so this is not dual-write,
   * it is creating the row that activation will later refresh and adopt.
   */
  private enqueueEmail(type: string, recipientEmail: string, recipientEmailHash: string, template: string, payloadRef: string, payload: Record<string, unknown>) {
    const write = () => {
      const outboxId = id();
      const providerKey = publicId();
      this.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_ref, payload_snapshot, provider_idempotence_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(outboxId, type, recipientEmail, recipientEmailHash, template, payloadRef, JSON.stringify(payload), providerKey);
      this.db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES (?, ?, 1, ?)`).run(id(), outboxId, providerKey);
      return outboxId;
    };
    const atomicWrite = this.db.transaction(write);
    // Nested: SAVEPOINT. Outermost: BEGIN IMMEDIATE, matching every other
    // write path in this domain.
    return this.db.inTransaction ? atomicWrite() : atomicWrite.immediate();
  }

  private insertCityInterestRequest(input: {
    requestId: string;
    email: string;
    emailHash: string;
    citySlug: string;
    manifest: LegalManifest;
    timestamp: string;
    expiresAt: string;
  }) {
    this.db.prepare(`INSERT INTO city_interest_requests(
      id, email_normalized, email_hash, city_slug,
      privacy_policy_version, privacy_policy_sha256,
      pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at,
      expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.requestId, input.email, input.emailHash, input.citySlug,
      input.manifest.documents.PRIVACY_POLICY.version, input.manifest.documents.PRIVACY_POLICY.sha256,
      input.manifest.documents.PD_CONSENT.version, input.manifest.documents.PD_CONSENT.sha256,
      input.timestamp, input.timestamp, input.expiresAt,
    );
  }

  private consumeEligibleCityInterests(citySlug?: string, limit = CITY_INTEREST_SWEEP_BATCH_SIZE, timestamp = new Date(this.clock()).toISOString()) {
    const interests = many(this.db, `SELECT ci.id, ci.email_normalized, ci.email_hash, ci.city_slug,
        c.title AS city_title, o.id AS occurrence_id, o.title AS occurrence_title, o.starts_at
      FROM city_interest_requests ci
      JOIN cities c ON c.slug = ci.city_slug
      JOIN occurrences o ON o.id = (
        SELECT candidate.id FROM occurrences candidate
        WHERE candidate.city_id = c.id
          AND candidate.visibility = 'PUBLISHED'
          AND candidate.fulfillment_status = 'SCHEDULED'
          AND candidate.starts_at >= ?
        ORDER BY candidate.starts_at, candidate.id
        LIMIT 1
      )
      WHERE ci.superseded_at IS NULL
        AND ci.expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM city_interest_notification_intents intent
          WHERE intent.city_interest_request_id = ci.id
            AND intent.superseded_at IS NULL
        ) ${citySlug ? "AND ci.city_slug = ?" : ""}
      ORDER BY ci.created_at, ci.id
      LIMIT ?`, timestamp, timestamp, ...(citySlug ? [citySlug] : []), limit);
    for (const interest of interests) {
      const outboxId = this.enqueueEmail("CITY_INTEREST_AVAILABLE", String(interest.email_normalized), String(interest.email_hash), "city-interest-available", `city-interest:${interest.id}`, {
        city_title: interest.city_title,
        occurrence_id: interest.occurrence_id,
        occurrence_title: interest.occurrence_title,
        starts_at: interest.starts_at,
      });
      this.db.prepare("INSERT INTO city_interest_notification_intents(id, city_interest_request_id, outbox_id) VALUES (?, ?, ?)").run(outboxId, interest.id, outboxId);
    }
    return interests.length;
  }

  private isActiveCityInterestNotification(outboxId: string) {
    return Boolean(one(this.db, `SELECT request.id
      FROM city_interest_notification_intents intent
      JOIN city_interest_requests request ON request.id = intent.city_interest_request_id
      WHERE intent.outbox_id = ?
        AND intent.superseded_at IS NULL
        AND request.superseded_at IS NULL
        AND request.expires_at > ?`, outboxId, new Date(this.clock()).toISOString()));
  }

  /** A fresh CAPTCHA-protected submission may replace only a final failed intent. */
  private canRenewCityInterestNotification(requestId: string) {
    const current = one(this.db, `SELECT outbox.status,
        EXISTS(SELECT 1 FROM email_provider_events
          WHERE outbox_id = outbox.id AND provider_status = 'hard_bounced') AS has_hard_bounced,
        EXISTS(SELECT 1 FROM email_provider_events
          WHERE outbox_id = outbox.id AND provider_status = 'delivered') AS has_delivered
      FROM city_interest_notification_intents intent
      JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE intent.city_interest_request_id = ? AND intent.superseded_at IS NULL`, requestId);
    return current?.status === "FAILED"
      || (Boolean(current?.has_hard_bounced) && !Boolean(current?.has_delivered));
  }

  /** Stops future local dispatch and removes the now-unneeded local PII. An in-flight provider call cannot be recalled. */
  private suppressCityInterestOutbox(outboxId: string) {
    this.atomically(() =>
      suppressMessageDispatch(this.db, outboxId, "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", now()));
  }

  private purgeCityInterestRequest(requestId: string) {
    const outboxes = many(this.db, `SELECT intent.outbox_id
      FROM city_interest_notification_intents intent
      WHERE intent.city_interest_request_id = ?`, requestId);
    for (const outbox of outboxes) this.suppressCityInterestOutbox(String(outbox.outbox_id));
    this.db.prepare("DELETE FROM city_interest_requests WHERE id = ?").run(requestId);
  }

  private insertOccurrenceNotificationRequest(input: { requestId: string; email: string; emailHash: string; occurrenceId: string; manifest: LegalManifest; timestamp: string }) {
    this.db.prepare(`INSERT INTO occurrence_notification_requests(
      id, email_normalized, email_hash, occurrence_id, privacy_policy_version, privacy_policy_sha256,
      pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.requestId, input.email, input.emailHash, input.occurrenceId,
        input.manifest.documents.PRIVACY_POLICY.version, input.manifest.documents.PRIVACY_POLICY.sha256,
        input.manifest.documents.PD_CONSENT.version, input.manifest.documents.PD_CONSENT.sha256, input.timestamp, input.timestamp);
  }

  private consumeEligibleOccurrenceNotifications(limit = 50) {
    if (!this.occurrenceNotificationsAvailable() || this.newOrdersBlocked()) return 0;
    const timestamp = new Date(this.clock()).toISOString();
    const requests = many(this.db, `SELECT request.id, request.email_normalized, request.email_hash,
      o.id AS occurrence_id, o.title AS occurrence_title, o.starts_at, o.timezone, c.title AS city_title,
      o.sales_status, o.fulfillment_status,
      o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) AS availability
      FROM occurrence_notification_requests request
      JOIN occurrences o ON o.id = request.occurrence_id
      JOIN cities c ON c.id = o.city_id
      WHERE request.superseded_at IS NULL
        AND o.sales_status = 'OPEN'
        AND o.fulfillment_status = 'SCHEDULED'
        AND julianday(o.starts_at) > julianday(?)
        AND o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) > 0
        AND NOT EXISTS (SELECT 1 FROM occurrence_notification_intents intent
          WHERE intent.notification_request_id = request.id AND intent.superseded_at IS NULL)
      ORDER BY request.created_at, request.id LIMIT ?`, timestamp, limit)
      .filter((request) => purchaseStatus({
        salesStatus: request.sales_status === "PAUSED" ? "PAUSED" : request.sales_status === "CLOSED" ? "CLOSED" : "OPEN",
        fulfillmentStatus: request.fulfillment_status === "COMPLETED" ? "COMPLETED" : request.fulfillment_status === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
        startsAtMs: parseUtcTimestamp(String(request.starts_at)), nowMs: this.clock(), availability: Number(request.availability), newOrdersBlocked: false,
      }) === "AVAILABLE");
    for (const request of requests) {
      const outboxId = this.enqueueEmail("OCCURRENCE_AVAILABLE", String(request.email_normalized), String(request.email_hash), "occurrence-available", `occurrence-notification:${request.id}`, {
        city_title: request.city_title, occurrence_id: request.occurrence_id, occurrence_title: request.occurrence_title, starts_at: request.starts_at, timezone: request.timezone,
      });
      this.db.prepare("INSERT INTO occurrence_notification_intents(id, notification_request_id, outbox_id) VALUES (?, ?, ?)").run(outboxId, request.id, outboxId);
    }
    return requests.length;
  }

  /** A fresh explicit submission can replace only a final failed epoch. */
  private canRenewOccurrenceNotification(requestId: string) {
    const current = one(this.db, `SELECT outbox.status,
      EXISTS(SELECT 1 FROM email_provider_events WHERE outbox_id = outbox.id AND provider_status = 'hard_bounced') AS has_hard_bounced,
      EXISTS(SELECT 1 FROM email_provider_events WHERE outbox_id = outbox.id AND provider_status = 'delivered') AS has_delivered
      FROM occurrence_notification_intents intent JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE intent.notification_request_id = ? AND intent.superseded_at IS NULL`, requestId);
    return current?.status === "FAILED" || (Boolean(current?.has_hard_bounced) && !Boolean(current?.has_delivered));
  }

  private isActiveOccurrenceNotification(outboxId: string) {
    const request = one(this.db, `SELECT request.id, o.sales_status, o.fulfillment_status, o.starts_at,
      o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) AS availability
      FROM occurrence_notification_intents intent JOIN occurrence_notification_requests request ON request.id = intent.notification_request_id
      JOIN occurrences o ON o.id = request.occurrence_id
      WHERE intent.outbox_id = ? AND intent.superseded_at IS NULL AND request.superseded_at IS NULL`, outboxId);
    if (!request || !this.occurrenceNotificationsAvailable()) return false;
    return purchaseStatus({
      salesStatus: request.sales_status === "PAUSED" ? "PAUSED" : request.sales_status === "CLOSED" ? "CLOSED" : "OPEN",
      fulfillmentStatus: request.fulfillment_status === "COMPLETED" ? "COMPLETED" : request.fulfillment_status === "CANCELLED" ? "CANCELLED" : "SCHEDULED",
      startsAtMs: parseUtcTimestamp(String(request.starts_at)), nowMs: this.clock(), availability: Number(request.availability), newOrdersBlocked: this.newOrdersBlocked(),
    }) === "AVAILABLE";
  }

  private suppressOccurrenceNotificationOutbox(outboxId: string) {
    this.atomically(() =>
      suppressMessageDispatch(this.db, outboxId, "OCCURRENCE_AVAILABLE", "OCCURRENCE_NOTIFICATION_NO_LONGER_ACTIVE", now()));
    this.db.prepare("UPDATE occurrence_notification_intents SET superseded_at = COALESCE(superseded_at, ?) WHERE outbox_id = ?").run(now(), outboxId);
  }

  private purgeOccurrenceNotificationRequest(requestId: string) {
    const outboxes = many(this.db, "SELECT outbox_id FROM occurrence_notification_intents WHERE notification_request_id = ?", requestId);
    for (const outbox of outboxes) this.suppressOccurrenceNotificationOutbox(String(outbox.outbox_id));
    this.db.prepare("DELETE FROM occurrence_notification_requests WHERE id = ?").run(requestId);
  }

  private recordProviderDrift(entityType: "PAYMENT" | "REFUND", entityId: string, observed: Record<string, unknown>) {
    const existing = one(this.db, "SELECT id FROM provider_drift_reviews WHERE entity_type = ? AND entity_id = ? AND status = 'OPEN'", entityType, entityId);
    if (!existing) this.db.prepare("INSERT INTO provider_drift_reviews(id, entity_type, entity_id, observed_json) VALUES (?, ?, ?, ?)").run(id(), entityType, entityId, JSON.stringify(observed));
  }

  private applyEmailObservation(outboxId: string, observed: { status: string; jobId?: string }, known?: AttemptRef) {
    const terminal = ["ACCEPTED", "SENT", "DELIVERED", "BOUNCED", "FAILED"];
    if (!terminal.includes(observed.status)) return;
    // The selector is read inside this transaction by applyProviderObservation.
    // This is the path that genuinely races the activation CAS: it runs in the
    // API process from a provider callback and continues while dispatch is
    // fenced, so a selector read outside the governing transaction would
    // reintroduce the interleaving BEGIN IMMEDIATE exists to remove.
    this.atomically(() => applyProviderObservation(this.db, outboxId, observed, now(), known));
  }

  private redactDeliveredCityInterestOutbox(outboxId: string) {
    this.db.prepare(`UPDATE email_outbox SET recipient_email = '', recipient_email_hash = '', payload_snapshot = '{}'
      WHERE id = ? AND type = 'CITY_INTEREST_AVAILABLE'`).run(outboxId);
  }

  private completeDeliveredCityInterest(outboxId: string) {
    // Resolve the active relation before deleting its source request: the FK
    // cascade removes the intent, so resolving after deletion would orphan PII.
    const intent = one(this.db, `SELECT city_interest_request_id
      FROM city_interest_notification_intents
      WHERE outbox_id = ? AND superseded_at IS NULL`, outboxId);
    if (intent) this.db.prepare("DELETE FROM city_interest_requests WHERE id = ?").run(intent.city_interest_request_id);
    // A late delivery of a superseded intent must not delete the renewed
    // request, but the old delivered outbox itself is still redacted.
    this.redactDeliveredCityInterestOutbox(outboxId);
  }

  private completeDeliveredOccurrenceNotification(outboxId: string) {
    const intent = one(this.db, `SELECT notification_request_id FROM occurrence_notification_intents
      WHERE outbox_id = ? AND superseded_at IS NULL`, outboxId);
    if (intent) this.db.prepare("DELETE FROM occurrence_notification_requests WHERE id = ?").run(intent.notification_request_id);
    this.db.prepare(`UPDATE email_outbox SET recipient_email = '', recipient_email_hash = '', payload_snapshot = '{}'
      WHERE id = ? AND type = 'OCCURRENCE_AVAILABLE'`).run(outboxId);
  }

  /**
   * Repairs one known historical orphan only when immutable outbox lineage and
   * provider evidence independently prove that the city-interest purpose was
   * completed. It deliberately does not infer cleanup from age or city alone.
   */
  repairDeliveredCityInterestOrphan(requestId: string) {
    return withImmediateTransaction(this.db, () => {
      const candidate = one(this.db, `SELECT request.id, outbox.id AS outbox_id
        FROM city_interest_requests request
        JOIN email_outbox outbox
          ON outbox.payload_ref = 'city-interest:' || request.id
        WHERE request.id = ?
          AND outbox.type = 'CITY_INTEREST_AVAILABLE'
          AND outbox.status = 'DELIVERED'
          AND outbox.suppressed_at IS NULL
          AND EXISTS (
            SELECT 1 FROM email_provider_events event
            WHERE event.outbox_id = outbox.id
              AND event.status = 'DELIVERED'
              AND event.provider_status = 'delivered'
          )
          AND NOT EXISTS (
            SELECT 1 FROM city_interest_notification_intents intent
            WHERE intent.city_interest_request_id = request.id
          )`, requestId);
      if (!candidate) return false;
      const deleted = this.db.prepare("DELETE FROM city_interest_requests WHERE id = ?").run(requestId);
      if (!deleted.changes) return false;
      this.redactDeliveredCityInterestOutbox(String(candidate.outbox_id));
      return true;
    });
  }

  /**
   * Repairs only a pre-0021 redaction omission. The durable successor link is
   * written by the epoch transition itself; without it there is no safe way to
   * infer that another request was the same email/city interest.
   */
  repairSupersededFailedCityInterestRequest(requestId: string) {
    return withImmediateTransaction(this.db, () => {
      const candidate = one(this.db, `SELECT previous.id
        FROM city_interest_requests previous
        JOIN city_interest_requests replacement
          ON replacement.id = previous.superseded_by_request_id
        JOIN city_interest_notification_intents old_intent
          ON old_intent.city_interest_request_id = previous.id
        JOIN email_outbox old_outbox ON old_outbox.id = old_intent.outbox_id
        WHERE previous.id = ?
          AND previous.superseded_at IS NOT NULL
          AND previous.superseded_by_request_id IS NOT NULL
          AND previous.email_normalized != ''
          AND previous.email_hash != ''
          AND replacement.superseded_at IS NULL
          AND replacement.city_slug = previous.city_slug
          AND old_intent.superseded_at IS NOT NULL
          AND (
            (old_outbox.status = 'FAILED' AND old_outbox.delivery_outcome = 'KNOWN_FAILED')
            OR (
              EXISTS (SELECT 1 FROM email_provider_events event
                WHERE event.outbox_id = old_outbox.id
                  AND event.provider_status = 'hard_bounced')
              AND NOT EXISTS (SELECT 1 FROM email_provider_events event
                WHERE event.outbox_id = old_outbox.id
                  AND event.provider_status = 'delivered')
            )
          )`, requestId);
      if (!candidate) return false;
      return Boolean(this.db.prepare(`UPDATE city_interest_requests
        SET email_normalized = '', email_hash = ''
        WHERE id = ? AND email_normalized != '' AND email_hash != ''`).run(requestId).changes);
    });
  }

  applyUnisenderDelivery(input: { outboxId: string; status: "ACCEPTED" | "SENT" | "DELIVERED" | "BOUNCED" | "FAILED"; providerStatus: "accepted" | "sent" | "delivered" | "soft_bounced" | "hard_bounced" | "spam"; jobId?: string; semanticKey: string }) {
    return withImmediateTransaction(this.db, () => {
      const outbox = one(this.db, "SELECT id FROM email_outbox WHERE id = ?", input.outboxId);
      if (!outbox) throw new DomainError("UNISENDER_OUTBOX_NOT_FOUND", 404);
      const inserted = this.db.prepare("INSERT OR IGNORE INTO email_provider_events(id, outbox_id, semantic_key, status, provider_status, job_id) VALUES (?, ?, ?, ?, ?, ?)").run(id(), input.outboxId, input.semanticKey, input.status, input.providerStatus, input.jobId ?? null);
      if (!inserted.changes) return { duplicate: true };
      if (input.providerStatus === "delivered") {
        this.completeDeliveredCityInterest(input.outboxId);
        this.completeDeliveredOccurrenceNotification(input.outboxId);
      }
      this.applyEmailObservation(input.outboxId, { status: input.status, jobId: input.jobId });
      return { duplicate: false };
    });
  }

  private recordAdminCommandAudit(adminId: string, action: string, entityType: string, entityId: string, auditContext: string | undefined, idempotencyKey: string, payload: unknown) {
    this.db.prepare("INSERT INTO admin_audit_log(id, admin_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id(), adminId, action, entityType, entityId, JSON.stringify({
        audit_context: auditContext ?? null,
        idempotency_key_hash: sha256(idempotencyKey),
        canonical_request_hash: sha256(canonical(payload)),
      }));
  }

  private withAdminCommandCore<T extends Row>(command: string, idempotencyKey: string, payload: unknown, table: "cities" | "occurrences" | "reward_settlements" | "bookings", operation: () => T): { row: T; disposition: "CREATED" | "REPLAYED" } {
    const keyHash = sha256(idempotencyKey); const payloadHash = sha256(canonical(payload));
    const existing = one(this.db, "SELECT canonical_request_hash, entity_id FROM admin_command_idempotency WHERE command = ? AND idempotency_key_hash = ?", command, keyHash);
    if (existing) {
      if (existing.canonical_request_hash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return { row: one(this.db, `SELECT * FROM ${table} WHERE id = ?`, existing.entity_id)! as T, disposition: "REPLAYED" };
    }
    const created = operation();
    this.db.prepare("INSERT INTO admin_command_idempotency(command, idempotency_key_hash, canonical_request_hash, entity_id) VALUES (?, ?, ?, ?)").run(command, keyHash, payloadHash, created.id);
    return { row: created, disposition: "CREATED" };
  }

  private withAdminCommand<T extends Row>(command: string, idempotencyKey: string, payload: unknown, table: "cities" | "occurrences" | "reward_settlements" | "bookings", operation: () => T) {
    return withImmediateTransaction(this.db, () => this.withAdminCommandCore(command, idempotencyKey, payload, table, operation).row);
  }

  /** V2 captures the response before another operator can mutate its row. */
  private assertV2IdempotencyKey(idempotencyKey: string) {
    if (idempotencyKey.length < 16 || idempotencyKey.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", 400);
  }

  private withAdminCommandV2Core<T extends Row>(command: string, idempotencyKey: string, adminId: string, resourceId: string | null, body: unknown, auditContext: string | undefined, action: string, entityType: string, operation: () => T): { row: T; disposition: "CREATED" | "REPLAYED" } {
    const keyHash = sha256(idempotencyKey);
    const fingerprint = `v2:${sha256(canonicalV2({ admin_id: adminId, command, resource_id: resourceId, body, audit_context: auditContext ?? null }))}`;
    const existing = one(this.db, "SELECT canonical_request_hash, response_json FROM admin_command_idempotency WHERE command = ? AND idempotency_key_hash = ?", command, keyHash);
    if (existing) {
      if (existing.canonical_request_hash !== fingerprint) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      if (!existing.response_json) throw new DomainError("IDEMPOTENCY_CONTRACT_SUPERSEDED", 409);
      return { row: JSON.parse(String(existing.response_json)) as T, disposition: "REPLAYED" };
    }
    let created: T;
    try { created = operation(); }
    catch (error) {
      const sqlite = error as { code?: string; message?: string };
      if (sqlite.code === "SQLITE_CONSTRAINT_UNIQUE" && sqlite.message?.includes("agents.slug")) throw new DomainError("AGENT_SLUG_ALREADY_EXISTS", 409);
      if (sqlite.code === "SQLITE_CONSTRAINT_UNIQUE" && sqlite.message?.includes("promo_codes.normalized_code")) throw new DomainError("PROMO_CODE_ALREADY_EXISTS", 409);
      throw error;
    }
    this.recordAdminCommandAudit(adminId, action, entityType, String(created.id), auditContext, idempotencyKey, { command, resource_id: resourceId, body });
    this.db.prepare("INSERT INTO admin_command_idempotency(command, idempotency_key_hash, canonical_request_hash, entity_id, response_json) VALUES (?, ?, ?, ?, ?)")
      .run(command, keyHash, fingerprint, created.id, JSON.stringify(created));
    return { row: created, disposition: "CREATED" };
  }

  private withAdminCommandV2<T extends Row>(command: string, idempotencyKey: string, adminId: string, resourceId: string | null, body: unknown, auditContext: string | undefined, action: string, entityType: string, operation: () => T): T {
    this.assertV2IdempotencyKey(idempotencyKey);
    return withImmediateTransaction(this.db, () => this.withAdminCommandV2Core(command, idempotencyKey, adminId, resourceId, body, auditContext, action, entityType, operation).row);
  }

  recoverStaleCommands() {
    const timestamp = now();
    this.db.prepare("UPDATE payments SET state = 'CREATE_UNKNOWN', updated_at = ? WHERE state = 'CREATING' AND creation_started_at < datetime('now', '-120 seconds')").run(timestamp);
    this.db.prepare("UPDATE refunds SET status = 'SUBMIT_UNKNOWN' WHERE status = 'SUBMITTING' AND submission_started_at < datetime('now', '-120 seconds')").run();
    this.reconcileLegacyUnisenderHttp403();
    // A superseded in-flight send must never be retried, but a crashed worker
    // cannot leave it claiming SENDING forever. Record the honest ambiguous
    // outcome and retain supersession as the permanent no-retry guard.
    // Lease expiry is an attempt fact too: under ATTEMPT the message no longer
    // carries a lease, so scanning email_outbox.lease_expires_at would find
    // nothing and stale sends would never be recovered - a silent read defect
    // with no trigger to catch it.
    // Superseded stale sends: the scan chose them, and the write revalidates
    // that category. A superseded row must never be rescheduled, so no retry
    // time - supersession is the permanent no-retry guard.
    for (const outbox of staleLeasedSends(this.db, timestamp, true)) {
      withImmediateTransaction(this.db, () =>
        deferAmbiguousSend(this.db, { id: String(outbox.id) }, resolveAttemptRef(this.db, String(outbox.id)), null,
          { supersession: "REQUIRE_SUPERSEDED", requireUnsuppressed: true }));
    }
    for (const outbox of staleLeasedSends(this.db, timestamp, false)) {
      const id = String(outbox.id);
      withImmediateTransaction(this.db, () => {
        const ref = resolveAttemptRef(this.db, id);
        const tries = sendTryCount(this.db, { id, attempts: outbox.attempts });
        const guard = { supersession: "REQUIRE_UNSUPERSEDED" as const, requireUnsuppressed: true };
        if (tries >= EMAIL_SEND_UNKNOWN_MAX_ATTEMPTS) { failExhaustedAmbiguous(this.db, { id }, ref, "SENDING", guard); return; }
        deferAmbiguousSend(this.db, { id }, ref, this.unknownEmailRetryAt(Math.max(1, tries)), guard);
      });
    }
  }

}
