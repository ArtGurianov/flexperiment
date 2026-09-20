import type Database from "better-sqlite3";
import { canonical, canonicalV2, decryptTicketCapability, id, now, publicId, sha256 } from "./crypto";
import { EmailProviderRejectedError, EventDumpCreateRejectedError, isEmailDeliveryEvidenceProvider, type EmailProvider, type UnisenderDumpEvent, UNISENDER_EVENT_DUMP_EVENT_LIMIT, UnconfiguredEmailProvider } from "./email-provider";
import type { LegalManifest } from "./legal-manifest";
import { loadCanonicalLegalRelease, verifyCurrentLegalSourceHashes, type CanonicalLegalRelease } from "./legal-release";
import { providerErrorEvidence, type PaymentProvider } from "./provider";
import { promoMergedSchema } from "./types";
import { isPromoPartnerOwned } from "./agent-referrals-promo";
import { getPartnerIdentityByAgentId } from "./agent-referrals-onboarding";
import { agreementStatusForPartner, effectiveFrameworkAcceptance } from "./agent-referrals-framework-issuance";
import { frameworkAgreementRevisionById } from "./agent-referrals-framework-delegation";
import { availabilityStatus, purchaseStatus, type AvailabilityStatus, type PurchaseStatus } from "./purchase-status";
import { availableSeatsSql } from "./occurrence-inventory";
import { occurrenceNotificationsCapabilityActive } from "./occurrence-notification-capability";
import { normalizeUnisenderReconciliationEvent, type UnisenderReconciliationEvent } from "./email-provider-reconciliation";
import {
  canRenewCityInterestNotification,
  consumeEligibleCityInterests,
  insertCityInterestRequest,
  isActiveCityInterestNotification,
  isActiveOccurrenceNotification,
  processCityInterestLifecycle,
  processOccurrenceNotificationLifecycle,
  purgeCityInterestRequest,
  purgeOccurrenceNotificationRequest,
  registerOccurrenceNotification,
  registerCityInterest,
  suppressCityInterestOutbox,
  suppressOccurrenceNotificationOutbox,
  withdrawNotificationConsent,
} from "./domain/city-interest";
import { addSettlementRecovery } from "./domain/settlements";
import {
  agentList,
  createAgent,
  createCity,
  createPromo,
  patchAgent,
  patchCity,
  patchPromo,
  promoList,
} from "./domain/admin-catalog";
import { cancellationFinancialOverview, cancelOccurrence, completeOccurrence, createAdminReauth, createOccurrence, createOccurrenceRecord, patchOccurrence, type CorruptOccurrenceNotification, type OccurrenceCreateInput, type PendingOccurrenceUpdateBaseline } from "./domain/occurrences";
import { checkout, checkoutAsync, checkoutContext, checkoutStatus, replayCheckout, type CheckoutInput } from "./domain/checkout";
import { applyTochkaPaymentWebhook, markPaymentPaid, reconcilePayment, reconcilePendingPayments, type TochkaPaymentWebhook } from "./domain/payments";
import { cancelCustomerBooking, confirmCustomerRefund, createCompensationRefund, createObligationRefunds, customerRefundConfirmationContext, ensureFullCapturedRefund, reconcilePendingRefunds, reconcileRefund, requestCustomerRefund, submitRequestedRefunds, upsertRefundObligation } from "./domain/refunds";
import { parseUtcTimestamp } from "./utc-timestamp";
import { emergencySalesPaused } from "./emergency-sales-gate";
import { claimForDispatch, deferAmbiguousObservation, deferAmbiguousSend, dispatchCandidates, failExhaustedAmbiguous, providerLookupIdentity, recordProviderAcceptance, recordProviderRefusal, applyProviderObservation, claimedAttemptRef, resolveAttemptRef, skipObsoletePendingMessage, supersedeQueuedMessage, sendTryCount, staleLeasedSends, type AttemptRef } from "./outbox-attempt-store";
import { OutboxAuthorityError, emailDispatchDrained, emailDispatchFenced, fenceEmailDispatch, lastAuthorityEvent, outboxAuthority, unfenceEmailDispatch, unknownAppliedMigrations, type DispatchEpoch } from "./outbox-authority";
import type { OtpDeliveryCapability } from "./agent-referrals-otp";
import {
  CITY_INTEREST_SWEEP_BATCH_SIZE,
  DomainError,
  legalManifest,
  many,
  one,
  isOccurrenceCustomerSnapshot,
  type OccurrenceCustomerSnapshot,
  type Row,
  withImmediateTransaction,
} from "./domain/shared";

export { classifyOccurrenceRevision, type OccurrenceRevisionClassification } from "./domain/occurrences";

export {
  CITY_INTEREST_SWEEP_BATCH_SIZE,
  DomainError,
  legalManifest,
  many,
  one,
  type Row,
  withImmediateTransaction,
} from "./domain/shared";

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

/**
 * Under ATTEMPT authority the provider job id and the dispatch instant live on
 * the message's latest attempt. `email_outbox.job_id`,
 * `provider_request_started_at` and `send_started_at` are frozen legacy columns
 * that nothing writes any more, so selecting Event Dump candidates by them
 * silently matched nothing and the delivery-reconciliation fallback went dead.
 */
const LATEST_ATTEMPT_JOIN = `LEFT JOIN outbox_attempt attempt ON attempt.id = (
    SELECT latest.id FROM outbox_attempt latest
    WHERE latest.message_id = outbox.id ORDER BY latest.attempt_no DESC LIMIT 1)`;
const ATTEMPT_DISPATCH_AT = "COALESCE(attempt.provider_request_started_at, attempt.started_at, outbox.created_at)";


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
  availability_status: AvailabilityStatus;
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
    availability_status: availabilityStatus(Number(occurrence.availability)),
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

// A stale PREPARED allocation is an operational-review condition, never a
// timeout-based cancellation. Keep this explicit and shared by the worker and
// Admin read model.
export const STALE_PREPARED_SETTLEMENT_MS = 30 * 60 * 1_000;
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
    e.id, e.type, e.status, e.created_at, e.sent_at, e.delivered_at, e.bounced_at,
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

export class CommerceDomain {
  constructor(
    readonly db: Database.Database,
    readonly provider: PaymentProvider,
    readonly emailProvider: EmailProvider = new UnconfiguredEmailProvider(),
    readonly clock: () => number = Date.now,
    private readonly otpDelivery: OtpDeliveryCapability = { configured: false, provider_id: null },
  ) {}

  /**
   * Joins the caller's transaction via a nested savepoint, or opens one.
   *
   * Suppression and supersession are reached both from inside the claim
   * transaction and from bare lifecycle sweeps, so neither "the caller has a
   * transaction" nor "the caller does not" is an invariant. Same shape as
   * enqueueEmail, for the same reason.
   */
  atomically<T>(operation: () => T): T {
    const run = this.db.transaction(operation);
    return this.db.inTransaction ? run() : run.immediate();
  }

  /**
   * Read-only operator-owned absolute latch. Deployment-session persistence is
   * intentionally not wired until P9, but this emergency authority stays live.
   */
  emergencySalesPaused() { return emergencySalesPaused(this.db); }

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
 * the durable fence, drain evidence, and last fence transition.
   */
  outboxAuthority() {
    return {
      ...outboxAuthority(this.db),
      dispatch: emailDispatchDrained(this.db),
      last_event: lastAuthorityEvent(this.db),
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

  unfenceEmailDispatch(input: { expected_revision: number; reason: string }, epoch: DispatchEpoch) {
    return this.mapOutboxAuthority(() =>
      withImmediateTransaction(this.db, () => ({ ...unfenceEmailDispatch(this.db, input, epoch), dispatch: emailDispatchDrained(this.db) })));
  }
  newOrdersBlocked() { return this.emergencySalesPaused(); }

  replayCheckout(input: unknown, idempotencyKey: string) {
    return replayCheckout(this, input, idempotencyKey);
  }

  assertNewOrdersOpen() {
    if (this.emergencySalesPaused()) throw new DomainError("SALES_TEMPORARILY_PAUSED", 503);
  }

  private publicOccurrences(where: string, options: { catalogue: boolean }, ...params: unknown[]) {
    const newOrdersBlocked = this.newOrdersBlocked();
    const nowMs = this.clock();
    return many(this.db, `SELECT
        o.id, c.slug AS city, c.title AS city_title, o.title, o.starts_at, o.ends_at,
        o.timezone, o.price_kopecks, o.sales_status, o.fulfillment_status,
        o.venue_status, o.venue_name, o.venue_address, o.venue_public,
        o.venue_disclosure_text, o.venue_announce_by,
        ${availableSeatsSql("o")} AS availability
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

  occurrenceNotificationsAvailable(manifest?: LegalManifest, activeVersion?: string) {
    const active = manifest ?? (() => {
      const release = one(this.db, "SELECT manifest_json, version FROM legal_releases WHERE active = 1");
      if (release) activeVersion = String(release.version);
      return release ? legalManifest(JSON.parse(String(release.manifest_json))) : undefined;
    })();
    if (!active) return false;
    let runtimeRelease: CanonicalLegalRelease;
    try {
      // Do not honor the publication helper's environment override here: this
      // is runtime evidence, so it must bind to the deployed canonical source.
      runtimeRelease = loadCanonicalLegalRelease("commerce/legal/production-manifest.json");
      verifyCurrentLegalSourceHashes(active);
    } catch { return false; }
    return occurrenceNotificationsCapabilityActive({
      activeVersion,
      activeManifest: active,
      runtimeRelease,
      currentLegalCopiesMatch: true,
    });
  }

  salesControl() {
    const emergency = one(this.db, `SELECT sales_paused, revision, paused_at, paused_reason, paused_by_admin_id
      FROM emergency_sales_gate WHERE singleton = 1`)!;
    return {
      id: "emergency-sales-gate", effective_status: this.emergencySalesPaused() ? "PAUSED" : "OPEN",
      emergency: { sales_paused: Boolean(emergency.sales_paused), revision: Number(emergency.revision), paused_at: emergency.paused_at, paused_reason: emergency.paused_reason, paused_by_admin_id: emergency.paused_by_admin_id },
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

  openOperationalIncident(
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
  openOccurrenceNotificationPayloadCorruptionIncident(input: {
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

  resolveOperationalIncidents(entityType: "refund" | "order" | "occurrence", entityId: string, note: string) {
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
    return registerCityInterest(this, input);
  }

  registerOccurrenceNotification(input: { email: string; occurrence_id: string }) {
    return registerOccurrenceNotification(this, input);
  }

  processOccurrenceNotificationLifecycle() {
    return processOccurrenceNotificationLifecycle(this);
  }

  /** Applies expiry before scanning for newly eligible requests. */
  processCityInterestLifecycle() {
    return processCityInterestLifecycle(this);
  }

  withdrawNotificationConsent(email: string, reason: string, adminId: string) {
    return withdrawNotificationConsent(this, email, reason, adminId);
  }

  /** Compatibility alias for existing operational runbooks and integrations. */
  withdrawCityInterest(email: string, reason: string, adminId: string) {
    const result = this.withdrawNotificationConsent(email, reason, adminId);
    return { withdrawn: result.withdrawn, deleted_count: result.city_interest_deleted };
  }

  checkoutContext(input: { occurrenceId: string; promoCode?: string; referralSlug?: string }) {
    return checkoutContext(this, input);
  }

  checkout(input: CheckoutInput, idempotencyKey: string, acceptance: { ip?: string; userAgent?: string } = {}) {
    return checkout(this, input, idempotencyKey, acceptance);
  }

  /** Performs external payment creation only after checkout state has committed. */
  async checkoutAsync(input: CheckoutInput, idempotencyKey: string, successBaseUrl: string, acceptance: { ip?: string; userAgent?: string } = {}) {
    return checkoutAsync(this, input, idempotencyKey, successBaseUrl, acceptance);
  }

  checkoutResult(value: Row) {
    return { status_id: value.status_id, status: value.status === "PAID" ? "PAID" : value.state === "CREATE_FAILED" || value.status === "EXPIRED" || value.status === "CANCELLED" ? "FAILED" : "PROCESSING", payment_url: value.payment_url ?? null };
  }

  checkoutStatus(statusId: string) {
    return checkoutStatus(this, statusId);
  }

  markPaymentPaid(paymentId: string, capturedAmount: number, providerPaymentId?: string) {
    return markPaymentPaid(this, paymentId, capturedAmount, providerPaymentId);
  }

  applyTochkaPaymentWebhook(input: TochkaPaymentWebhook, expected: { customerCode: string; merchantId: string }) {
    return applyTochkaPaymentWebhook(this, input, expected);
  }

  upsertRefundObligation(paymentId: string, source: string, target: number) {
    return upsertRefundObligation(this, paymentId, source, target);
  }

  /**
   * `refund_obligations.target_refunded_amount_kopecks` is a total target, not
   * a new command amount. The worker subtracts provider-confirmed successful
   * refunds before issuing a command. Keeping that unit here means a partial
   * historical refund and an organizer cancellation converge exactly to the
   * captured amount without ever over-refunding it.
   */
  ensureFullCapturedRefund(paymentId: string, source: string, capturedTotal: number) {
    return ensureFullCapturedRefund(this, paymentId, source, capturedTotal);
  }

  requestCustomerRefund(normalizedOrderNumber: string) {
    return requestCustomerRefund(this, normalizedOrderNumber);
  }

  customerRefundConfirmationContext(capability: string) {
    return customerRefundConfirmationContext(this, capability);
  }

  confirmCustomerRefund(capability: string) {
    return confirmCustomerRefund(this, capability);
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
    return cancelCustomerBooking(this, bookingId, input, idempotencyKey);
  }

  createCompensationRefund(orderId: string, input: { amount_kopecks: number; reason: string; note?: string }, idempotencyKey: string) {
    return createCompensationRefund(this, orderId, input, idempotencyKey);
  }

  createObligationRefunds() {
    return createObligationRefunds(this);
  }

  completeOccurrence(occurrenceId: string) {
    return completeOccurrence(this, occurrenceId);
  }

  createAdminReauth(input: { adminId: string; sessionId: string; purpose: "CANCEL_OCCURRENCE"; resourceId: string; capability: string }) {
    return createAdminReauth(this, input);
  }

  cancelOccurrence(occurrenceId: string, input: { reason: string; reauthCapability: string }, idempotencyKey: string, adminId: string, sessionId: string) {
    return cancelOccurrence(this, occurrenceId, input, idempotencyKey, adminId, sessionId);
  }

  cancellationFinancialOverview(occurrenceId: string) {
    return cancellationFinancialOverview(this, occurrenceId);
  }

  createCity(input: { city_slug: string; audit_context?: string }, idempotencyKey: string, adminId: string) {
    return createCity(this, input, idempotencyKey, adminId);
  }

  patchCity(cityId: string, input: { city_slug: string; audit_context?: string }, idempotencyKey: string, adminId: string) {
    return patchCity(this, cityId, input, idempotencyKey, adminId);
  }

  createOccurrenceRecord(input: OccurrenceCreateInput, occurrenceId: string = id()) {
    return createOccurrenceRecord(this, input, occurrenceId);
  }

  createOccurrence(input: OccurrenceCreateInput, idempotencyKey: string, adminId: string) {
    return createOccurrence(this, input, idempotencyKey, adminId);
  }

  patchOccurrence(occurrenceId: string, input: Record<string, unknown>, idempotencyKey: string, adminId: string) {
    return patchOccurrence(this, occurrenceId, input, idempotencyKey, adminId);
  }

  createAgent(input: Record<string, unknown>) {
    return createAgent(this, input);
  }

  /**
   * Current legal identity is a read-only projection of its revision chain.
   *
   * PR4 of the reissuance/evidence program: also joins required issuance +
   * effective acceptance (agent-referrals-framework-issuance.ts) into an
   * `agreement` projection for the admin "Договор" column - null for an
   * agent with no partner_identities row at all (an operational-only
   * agent, never a partner). Per-agent, not one bulk SQL join: these
   * resolvers are the sole authority for "required"/"effective" (PR2's own
   * rule - never a bare, unqualified lookup), and this list is an admin
   * page at operator scale, not a customer-facing hot path.
   */
  agentList() {
    return agentList(this);
  }

  agentAgreementProjection(agentId: string) {
    const partner = getPartnerIdentityByAgentId(this.db, agentId);
    if (!partner) return null;
    const status = agreementStatusForPartner(this.db, agentId, partner.id);
    const effective = effectiveFrameworkAcceptance(this.db, partner.id);
    const acceptedRevision = effective ? frameworkAgreementRevisionById(this.db, effective.issuance.framework_agreement_revision_id)?.revision ?? null : null;
    return { status, accepted_framework_agreement_revision: acceptedRevision, partner_identity_id: partner.id };
  }

  patchAgent(agentId: string, input: Record<string, unknown>) {
    return patchAgent(this, agentId, input);
  }

  createPromo(input: Record<string, unknown>, promoId: string = id()) {
    return createPromo(this, input, promoId);
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
    return promoList(this);
  }

  createAgentCommand(input: Record<string, unknown>, idempotencyKey: string, adminId: string, auditContext?: string) {
    return this.withAdminCommandV2("agent.create", idempotencyKey, adminId, null, input, auditContext, "AGENT_CREATED", "agent", () => this.createAgent(input));
  }

  patchAgentCommand(agentId: string, patch: Record<string, unknown>, idempotencyKey: string, adminId: string, auditContext?: string) {
    return this.withAdminCommandV2("agent.patch", idempotencyKey, adminId, agentId, patch, auditContext, "AGENT_EDITED", "agent", () => {
      const existing = one(this.db, "SELECT * FROM partners WHERE id = ?", agentId);
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
      // A partner-owned promo (agent-referrals-promo.ts's partner_promos) is
      // the partner's permanent identity, not legacy commercial authority
      // (§B-9) - the legacy admin surface may still toggle its global
      // availability, but agent_id/discount_type/discount_value are frozen
      // and must never be repointed or repriced through this endpoint.
      if (isPromoPartnerOwned(this.db, promoId)) {
        const disallowed = (["agent_id", "discount_type", "discount_value"] as const).filter((field) => patch[field] !== undefined);
        if (disallowed.length) throw new DomainError("PROMO_OWNED_BY_PARTNER", 409, disallowed.join(","));
      }
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
    return patchPromo(this, promoId, input);
  }

  /** Delegates to the shared reward-calculation.ts formula - see that module for why it was extracted verbatim. */

  /**
   * Recording an actual recovery against a paid settlement. Flow-agnostic by
   * construction: `settlement_recoveries` is read by the partner system's own
   * `recoveryExposure()`, and there is only one settlement model left, so this
   * carries no authority discriminator of its own.
   */
  addSettlementRecovery(settlementId: string, input: { amount_recovered_kopecks: number; recovered_at: string; method: string; evidence_reference: string; note?: string }, idempotencyKey: string) {
    return addSettlementRecovery(this, settlementId, input, idempotencyKey);
  }

  settlementTransaction<T>(operation: () => T): T {
    try { return withImmediateTransaction(this.db, operation); }
    catch (error) {
      if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) throw new DomainError("SETTLEMENT_BUSY", 409);
      throw error;
    }
  }

  async submitRequestedRefunds() {
    return submitRequestedRefunds(this);
  }

  async reconcilePayment(paymentId: string) {
    return reconcilePayment(this, paymentId);
  }

  async reconcileRefund(refundId: string) {
    return reconcileRefund(this, refundId);
  }

  async reconcilePendingRefunds() {
    return reconcilePendingRefunds(this);
  }

  async reconcilePendingPayments() {
    return reconcilePendingPayments(this);
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
      const isUnknown = outbox.status === "SEND_UNKNOWN";
      if (outbox.type === "CITY_INTEREST_AVAILABLE" || outbox.type === "OCCURRENCE_AVAILABLE") {
        const active = withImmediateTransaction(this.db, () => {
          if (outbox.type === "CITY_INTEREST_AVAILABLE" ? this.isActiveCityInterestNotification(String(outbox.id)) : this.isActiveOccurrenceNotification(String(outbox.id))) return true;
          // Provider acceptance may have been lost between the send and our
          // local write. Never turn a SEND_UNKNOWN into a suppression before
          // its existing provider identity has been reconciled.
          if (isUnknown) return true;
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
      // A known provider job is always reconciled before another send. It is
      // never considered proof that the original request was not dispatched.
      // Identity and try count are resolved ONCE, in one transaction, and
      // carried across the external provider call. Rediscovering "the current
      // attempt" afterwards would let evidence retrieved for one attempt be
      // applied to another if authority or the attempt changed in between.
      const { lookupIdentity, attemptRef, tryCount } = withImmediateTransaction(this.db, () => ({
        lookupIdentity: providerLookupIdentity(this.db, outbox as { id: string }),
        attemptRef: resolveAttemptRef(this.db, String(outbox.id)),
        tryCount: sendTryCount(this.db, { id: String(outbox.id) }),
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
          { id: String(outbox.id) },
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
        ${ATTEMPT_DISPATCH_AT} AS dispatch_at
        FROM email_outbox outbox
        ${LATEST_ATTEMPT_JOIN}
        WHERE outbox.superseded_at IS NULL AND outbox.status IN ('ACCEPTED', 'SENT')
          AND attempt.provider_job_id IS NOT NULL AND trim(attempt.provider_job_id) != ''
          AND datetime(${ATTEMPT_DISPATCH_AT}) <= datetime(?)
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
          ${ATTEMPT_DISPATCH_AT} AS dispatch_at,
          'TARGETED_JOB' AS recovery_mode
        FROM unisender_event_dump_targets target
        JOIN email_outbox outbox ON outbox.id = target.outbox_id
        ${LATEST_ATTEMPT_JOIN}
        WHERE target.state = 'RETRY_WAIT' AND target.recovery_mode = 'TARGETED_JOB'
          AND target.next_attempt_at <= ? AND outbox.superseded_at IS NULL
          AND outbox.status IN ('ACCEPTED', 'SENT') AND attempt.provider_job_id = target.job_id
        ORDER BY target.next_attempt_at, target.created_at LIMIT 1`, timestamp);
      const candidates = targeted ? [targeted] : many(this.db, `SELECT outbox.id, attempt.provider_job_id AS job_id,
          ${ATTEMPT_DISPATCH_AT} AS dispatch_at
        FROM email_outbox outbox
        ${LATEST_ATTEMPT_JOIN}
        WHERE outbox.superseded_at IS NULL AND outbox.status IN ('ACCEPTED', 'SENT')
          AND attempt.provider_job_id IS NOT NULL AND trim(attempt.provider_job_id) != ''
          AND datetime(${ATTEMPT_DISPATCH_AT}) <= datetime(?)
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
    if (!event.eventTime || !event.deliveryStatus) return;
    const providerStatus = event.status.toLowerCase();
    const semanticKey = `unisender:event-dump:${sha256(canonical({ outbox_id: target.outbox_id, job_id: event.jobId, status: providerStatus, delivery_status: event.deliveryStatus, event_time: event.eventTime }))}`;
    const observation = normalizeUnisenderReconciliationEvent({ outboxId: String(target.outbox_id), providerStatus, jobId: event.jobId, semanticKey });
    if (observation) this.applyUnisenderDelivery(observation);
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
  supersedePendingOccurrenceUpdatesForBooking(bookingId: string, reason: string) {
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

  pendingOccurrenceUpdateBaseline(bookingId: string): PendingOccurrenceUpdateBaseline | null {
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

  hasOpenOccurrenceChangeRefundEntitlement(bookingId: string) {
    return Boolean(one(this.db, `SELECT 1 AS present
      FROM occurrence_change_refund_entitlements
      WHERE booking_id = ? AND status = 'OPEN' LIMIT 1`, bookingId));
  }

  closeOccurrenceChangeRefundEntitlementsForBooking(bookingId: string, reason: string) {
    this.db.prepare(`UPDATE occurrence_change_refund_entitlements
      SET status = 'CLOSED', closed_at = ?, closed_reason = ?
      WHERE booking_id = ? AND status = 'OPEN'`).run(now(), reason, bookingId);
  }

  closeOccurrenceChangeRefundEntitlementsForOrder(orderId: string, reason: string) {
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
   * The provider key is minted ONCE, into the attempt, which is the only place
   * that holds it. The message used to carry a copy - the two were authoritative
   * in turn, depending on a selector column - and the baseline removed both the
   * copy and the selector.
   */
  enqueueEmail(type: string, recipientEmail: string, recipientEmailHash: string, template: string, payloadRef: string, payload: Record<string, unknown>) {
    const write = () => {
      const outboxId = id();
      const providerKey = publicId();
      this.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_ref, payload_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(outboxId, type, recipientEmail, recipientEmailHash, template, payloadRef, JSON.stringify(payload));
      this.db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES (?, ?, 1, ?)`).run(id(), outboxId, providerKey);
      return outboxId;
    };
    const atomicWrite = this.db.transaction(write);
    // Nested: SAVEPOINT. Outermost: BEGIN IMMEDIATE, matching every other
    // write path in this domain.
    return this.db.inTransaction ? atomicWrite() : atomicWrite.immediate();
  }

  insertCityInterestRequest(input: {
    requestId: string;
    email: string;
    emailHash: string;
    citySlug: string;
    manifest: LegalManifest;
    timestamp: string;
    expiresAt: string;
  }) { return insertCityInterestRequest(this, input); }

  consumeEligibleCityInterests(citySlug?: string, limit = CITY_INTEREST_SWEEP_BATCH_SIZE, timestamp = new Date(this.clock()).toISOString()) {
    return consumeEligibleCityInterests(this, citySlug, limit, timestamp);
  }

  private isActiveCityInterestNotification(outboxId: string) { return isActiveCityInterestNotification(this, outboxId); }

  /** A fresh CAPTCHA-protected submission may replace only a final failed intent. */
  canRenewCityInterestNotification(requestId: string) {
    return canRenewCityInterestNotification(this, requestId);
  }

  /** Stops future local dispatch and removes the now-unneeded local PII. An in-flight provider call cannot be recalled. */
  private suppressCityInterestOutbox(outboxId: string) { return suppressCityInterestOutbox(this, outboxId); }

  purgeCityInterestRequest(requestId: string) {
    return purgeCityInterestRequest(this, requestId);
  }

  private isActiveOccurrenceNotification(outboxId: string) { return isActiveOccurrenceNotification(this, outboxId); }

  private suppressOccurrenceNotificationOutbox(outboxId: string) { return suppressOccurrenceNotificationOutbox(this, outboxId); }

  private purgeOccurrenceNotificationRequest(requestId: string) { return purgeOccurrenceNotificationRequest(this, requestId); }

  recordProviderDrift(entityType: "PAYMENT" | "REFUND", entityId: string, observed: Record<string, unknown>) {
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

  applyUnisenderDelivery(input: UnisenderReconciliationEvent) {
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

  recordAdminCommandAudit(adminId: string, action: string, entityType: string, entityId: string, auditContext: string | undefined, idempotencyKey: string, payload: unknown, details?: Record<string, unknown>) {
    this.db.prepare("INSERT INTO admin_audit_log(id, admin_id, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id(), adminId, action, entityType, entityId, JSON.stringify({
        audit_context: auditContext ?? null,
        idempotency_key_hash: sha256(idempotencyKey),
        canonical_request_hash: sha256(canonical(payload)),
        ...details,
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

  withAdminCommand<T extends Row>(command: string, idempotencyKey: string, payload: unknown, table: "cities" | "occurrences" | "reward_settlements" | "bookings", operation: () => T) {
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
        const tries = sendTryCount(this.db, { id });
        const guard = { supersession: "REQUIRE_UNSUPERSEDED" as const, requireUnsuppressed: true };
        if (tries >= EMAIL_SEND_UNKNOWN_MAX_ATTEMPTS) { failExhaustedAmbiguous(this.db, { id }, ref, "SENDING", guard); return; }
        deferAmbiguousSend(this.db, { id }, ref, this.unknownEmailRetryAt(Math.max(1, tries)), guard);
      });
    }
  }

}
