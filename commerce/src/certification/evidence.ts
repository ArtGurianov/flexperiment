import { sanitizeDeliveryStatus, sanitizeDestinationResponse } from "../email-delivery-evidence";

/**
 * Classification of what production actually reports, kept entirely separate
 * from the code that talks to it.
 *
 * These were jq predicates embedded in a shell script, which meant the hardest
 * judgements in the whole procedure - is this exactly one refund? is a
 * DELIVERED row contradicted by a later provider event? - could only be
 * exercised by running the script against production. They are ordinary
 * functions now, and the cases that matter are the ones that never occur on a
 * good day.
 *
 * Nothing here performs a side effect. A classifier that could also act is a
 * classifier that can be tempted into "just retry it".
 */

export type OccurrenceView = {
  readonly id: string;
  readonly city_slug?: unknown;
  readonly title?: unknown;
  readonly timezone?: unknown;
  readonly price_kopecks?: unknown;
  readonly capacity?: unknown;
  readonly sales_status?: unknown;
  readonly visibility?: unknown;
  readonly availability?: unknown;
  readonly admin_revision?: unknown;
};

export type OrderEvidence = {
  readonly order?: Record<string, unknown>;
  readonly payment?: Record<string, unknown>;
  readonly booking?: Record<string, unknown>;
  readonly ticket?: Record<string, unknown>;
  readonly refund_obligation?: Record<string, unknown> | null;
  readonly refunds?: readonly Record<string, unknown>[];
  readonly email_outbox?: readonly Record<string, unknown>[];
  readonly email_provider_events?: readonly Record<string, unknown>[];
  readonly tochka_webhook_events?: readonly Record<string, unknown>[];
};

export type CertificationScope = {
  readonly citySlug: string;
  readonly title: string;
  readonly timezone: string;
  readonly priceKopecks: number;
  readonly capacity: number;
};

export type RunIdentifiers = {
  readonly orderId: string;
  readonly statusId: string;
  readonly occurrenceId: string;
  readonly paymentId: string;
  readonly bookingId: string;
  readonly ticketId: string;
  readonly amountKopecks: number;
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const integer = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) ? value : undefined);
const rows = (value: readonly Record<string, unknown>[] | undefined): readonly Record<string, unknown>[] => value ?? [];

/**
 * The occurrence is this run's own 1-rouble, single-seat fixture and not some
 * real event that happens to be open. Everything after this point mutates it.
 */
export const occurrenceIdentityDefect = (occurrence: OccurrenceView, scope: CertificationScope): string | undefined => {
  if (occurrence.city_slug !== scope.citySlug) return "CERTIFICATION_OCCURRENCE_CITY_MISMATCH";
  if (occurrence.title !== scope.title) return "CERTIFICATION_OCCURRENCE_TITLE_MISMATCH";
  if (occurrence.timezone !== scope.timezone) return "CERTIFICATION_OCCURRENCE_TIMEZONE_MISMATCH";
  if (integer(occurrence.price_kopecks) !== scope.priceKopecks) return "CERTIFICATION_OCCURRENCE_PRICE_MISMATCH";
  if (integer(occurrence.capacity) !== scope.capacity) return "CERTIFICATION_OCCURRENCE_CAPACITY_MISMATCH";
  return undefined;
};

/** Every identifier the run is about to act on belongs to the same order. */
export const orderIdentityDefect = (evidence: OrderEvidence, identifiers: RunIdentifiers): string | undefined => {
  const order = evidence.order ?? {};
  if (order.id !== identifiers.orderId) return "CERTIFICATION_ORDER_MISMATCH";
  if (order.public_status_id !== identifiers.statusId) return "CERTIFICATION_ORDER_STATUS_MISMATCH";
  if (order.occurrence_id !== identifiers.occurrenceId) return "CERTIFICATION_ORDER_OCCURRENCE_MISMATCH";
  if (integer(order.amount_kopecks) !== identifiers.amountKopecks) return "CERTIFICATION_ORDER_AMOUNT_MISMATCH";
  if (order.currency !== "RUB") return "CERTIFICATION_ORDER_CURRENCY_MISMATCH";
  if ((evidence.payment ?? {}).id !== identifiers.paymentId) return "CERTIFICATION_PAYMENT_MISMATCH";
  if ((evidence.booking ?? {}).id !== identifiers.bookingId) return "CERTIFICATION_BOOKING_MISMATCH";
  if ((evidence.ticket ?? {}).id !== identifiers.ticketId) return "CERTIFICATION_TICKET_MISMATCH";
  return undefined;
};

export type EmailEvidence =
  | { readonly delivered: true; readonly outboxId: string; readonly jobId: string }
  | { readonly delivered: false; readonly code: string };

/**
 * Delivery proved by the provider's own durable events, not by the outbox row
 * saying so.
 *
 * Three ways a DELIVERED row is not a delivery: no provider event backs it; a
 * provider event for this outbox carries a different job, meaning two sends
 * exist and one of them is unaccounted for; or a later event bounced or failed
 * and the row was never walked back. Each of those has to fail the run rather
 * than read as success.
 */
export const emailEvidence = (evidence: OrderEvidence, type: string, payloadRef: string): EmailEvidence => {
  const matching = rows(evidence.email_outbox).filter((row) => row.type === type && row.payload_ref === payloadRef);
  if (matching.length !== 1) return { delivered: false, code: matching.length === 0 ? "CERTIFICATION_EMAIL_OUTBOX_MISSING" : "CERTIFICATION_EMAIL_OUTBOX_NOT_UNIQUE" };

  const row = matching[0];
  const status = text(row.status);
  if (status !== "DELIVERED") return { delivered: false, code: `CERTIFICATION_EMAIL_NOT_DELIVERED:${status ?? "UNKNOWN"}` };

  const outboxId = text(row.id);
  const jobId = text(row.job_id);
  if (!outboxId) return { delivered: false, code: "CERTIFICATION_EMAIL_OUTBOX_ID_MISSING" };
  if (!jobId) return { delivered: false, code: "CERTIFICATION_EMAIL_JOB_ID_MISSING" };

  const events = rows(evidence.email_provider_events).filter((event) => event.outbox_id === outboxId);
  if (!events.some((event) => event.status === "DELIVERED" && event.provider_status === "delivered")) return { delivered: false, code: "CERTIFICATION_EMAIL_PROVIDER_EVIDENCE_MISSING" };
  if (events.some((event) => event.job_id != null && event.job_id !== jobId)) return { delivered: false, code: "CERTIFICATION_EMAIL_FOREIGN_JOB_EVENT" };
  if (events.some((event) => event.status === "BOUNCED" || event.status === "FAILED")) return { delivered: false, code: "CERTIFICATION_EMAIL_CONTRADICTED_BY_PROVIDER" };

  return { delivered: true, outboxId, jobId };
};

/** A stored timestamp as ISO UTC; SQLite's `datetime('now')` shape has no zone. */
const instant = (value: unknown): string | undefined => {
  const raw = text(value);
  if (!raw) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  return /^[0-9T:.\-Z]+$/.test(iso) ? iso : undefined;
};

/** Only the provider's own status words; nothing a payload could smuggle. */
const word = (value: unknown): string => {
  const raw = text(value) ?? "none";
  return /^[A-Za-z_]{1,32}$/.test(raw) ? raw : "unrecognised";
};

const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
};

/**
 * What an email wait saw before it gave up.
 *
 * "Timeout" alone cannot tell a sending failure from a receiver deferring the
 * message or a delivery webhook that never came. -r1's ticket (2026-09-24)
 * stopped at `sent` for the whole wait and was delivered three minutes after -
 * a recipient deferral - and that was not visible from the failure itself.
 *
 * The cancellation and refund emails that followed (same day) stayed `sent`
 * for hours, and "sent" alone could not say whether the receiver was deferring
 * them or the provider never tried again. So the report also carries the
 * provider's delivery classification and the receiving server's answer, when
 * either was recorded - and says UNKNOWN / UNAVAILABLE when not, rather than
 * leaving the reader to guess.
 *
 * Built from states, provider status words, timestamps and the receiver's
 * answer as email-delivery-evidence.ts sanitized it (sanitized again here):
 * never an address, a subject or a URL, because this becomes a durable failure
 * code and a log line.
 */
export const emailTimeoutDiagnosis = (evidence: OrderEvidence, type: string, payloadRef: string, waitedFrom: Date, observedAt: Date): string => {
  const outbox = rows(evidence.email_outbox).filter((row) => row.type === type && row.payload_ref === payloadRef);
  const waited = `waited=${duration(observedAt.getTime() - waitedFrom.getTime())} observed_at=${observedAt.toISOString()}`;
  if (outbox.length !== 1) return `last_status=${outbox.length === 0 ? "NO_OUTBOX" : "OUTBOX_NOT_UNIQUE"} ${waited}`;
  const row = outbox[0];
  const events = rows(evidence.email_provider_events)
    .filter((event) => event.outbox_id === row.id)
    .map((event) => ({ status: word(event.provider_status), at: instant(event.received_at) ?? "" }))
    .sort((left, right) => left.at.localeCompare(right.at));
  const firstSent = events.find((event) => event.status === "sent")?.at ?? instant(row.sent_at) ?? "none";
  const last = events.at(-1);
  return [
    `last_status=${word(row.status)}`,
    `last_provider=${last ? `${last.status}@${last.at || "unknown"}` : "none"}`,
    `provider_events=${events.length}`,
    `queued_at=${instant(row.created_at) ?? "unknown"}`,
    `first_sent_at=${firstSent}`,
    waited,
    ...deliveryDiagnosis(rows(evidence.email_provider_events).filter((event) => event.outbox_id === row.id)),
  ].join(" ");
};

/**
 * The most recent event that says anything about delivery, else the most
 * recent event. The receiver's answer is last and quoted: it is the one field
 * with spaces in it.
 */
const deliveryDiagnosis = (events: readonly Record<string, unknown>[]): string[] => {
  const ordered = [...events].sort((left, right) =>
    (instant(left.provider_event_time) ?? instant(left.received_at) ?? "").localeCompare(instant(right.provider_event_time) ?? instant(right.received_at) ?? ""));
  const informative = ordered.filter((event) => sanitizeDeliveryStatus(event.delivery_status) || sanitizeDestinationResponse(event.destination_response));
  const chosen = informative.at(-1) ?? ordered.at(-1);
  const source = chosen?.evidence_source === "WEBHOOK" || chosen?.evidence_source === "EVENT_DUMP" ? chosen.evidence_source : chosen ? "UNRECORDED" : "NONE";
  const response = sanitizeDestinationResponse(chosen?.destination_response);
  return [
    `delivery_status=${sanitizeDeliveryStatus(chosen?.delivery_status) ?? "UNKNOWN"}`,
    `evidence_source=${source}`,
    `destination_response=${response ? `"${response.replace(/"/g, "'")}"` : "UNAVAILABLE"}`,
  ];
};

/**
 * What a payment says about money that may need returning, which is not the
 * same question as whether the checkout succeeded.
 *
 *   NO_CAPTURE   the provider refused or the window closed. `domain.ts` turns
 *                both into a FAILED checkout and deliberately creates no refund
 *                obligation, because nothing was taken.
 *   CAPTURED     money exists at the provider. PARTIALLY_REFUNDED counts: some
 *                of it is still out. REFUNDED counts too - it still has to be
 *                proved by exactly one successful refund answering the
 *                obligation, rather than believed.
 *   UNRESOLVED   the provider has not said. Treating this as no-capture is the
 *                mistake that files an incident while a real rouble is gone.
 *
 * `CREATE_UNKNOWN` is on the other axis and overrides all of it: the create
 * call itself was ambiguous, so even a cancelled-looking payment is not
 * evidence that none exists at the provider.
 *
 * And a captured amount outranks the label. Nothing in the schema ties
 * `captured_amount_kopecks` to `status`, and the reconciler writes CANCELLED on
 * a provider FAILED without requiring the capture to be zero - so a payment
 * that was captured and then observed as failed reads as CANCELLED with money
 * against it. Believing the label there would close an incident while a real
 * rouble is still out, which is the one thing this recovery exists to prevent.
 */
export type PaymentRecoveryDisposition = "NO_CAPTURE" | "CAPTURED" | "UNRESOLVED";

export const paymentRecoveryDisposition = (payment: Record<string, unknown>): PaymentRecoveryDisposition => {
  const captured = Number(payment.captured_amount_kopecks);
  // Evidence we cannot read is not evidence that nothing was taken.
  if (!Number.isSafeInteger(captured) || captured < 0) return "UNRESOLVED";
  if (payment.state === "CREATE_UNKNOWN") return "UNRESOLVED";
  // Known captured money can never be classified as no-capture, whatever the
  // status has since been set to.
  if (captured > 0) return "CAPTURED";
  switch (payment.status) {
    case "CANCELLED":
    case "EXPIRED":
      return "NO_CAPTURE";
    case "PAID":
    case "PARTIALLY_REFUNDED":
    case "REFUNDED":
      return "CAPTURED";
    default:
      return "UNRESOLVED";
  }
};

export type RefundIdentifiers = {
  readonly paymentId: string;
  readonly obligationId: string;
  readonly refundId: string;
  readonly amountKopecks: number;
};

/**
 * The refund is complete: the obligation fulfilled, the payment refunded, and
 * exactly one refund answering that obligation. The uniqueness clause is the
 * one that matters - a second refund against the same obligation means the
 * customer's card was credited twice.
 */
export const refundConvergenceDefect = (evidence: OrderEvidence, identifiers: RefundIdentifiers): string | undefined => {
  const payment = evidence.payment ?? {};
  if (payment.id !== identifiers.paymentId) return "CERTIFICATION_PAYMENT_MISMATCH";
  if (payment.status !== "REFUNDED") return "CERTIFICATION_PAYMENT_NOT_REFUNDED";

  const obligation = evidence.refund_obligation ?? {};
  if (obligation.id !== identifiers.obligationId) return "CERTIFICATION_REFUND_OBLIGATION_MISMATCH";
  if (obligation.initial_source !== "CUSTOMER_CANCELLATION_PARTIAL") return "CERTIFICATION_REFUND_OBLIGATION_SOURCE_MISMATCH";
  if (integer(obligation.target_refunded_amount_kopecks) !== identifiers.amountKopecks) return "CERTIFICATION_REFUND_OBLIGATION_AMOUNT_MISMATCH";
  if (obligation.status !== "FULFILLED") return "CERTIFICATION_REFUND_OBLIGATION_NOT_FULFILLED";

  const answering = rows(evidence.refunds).filter((refund) =>
    refund.payment_id === identifiers.paymentId && refund.source === "REFUND_OBLIGATION" && refund.refund_obligation_id === identifiers.obligationId);
  if (answering.length !== 1) return answering.length === 0 ? "CERTIFICATION_REFUND_MISSING" : "CERTIFICATION_REFUND_NOT_UNIQUE";

  const refund = answering[0];
  if (refund.id !== identifiers.refundId) return "CERTIFICATION_REFUND_MISMATCH";
  if (integer(refund.amount_kopecks) !== identifiers.amountKopecks) return "CERTIFICATION_REFUND_AMOUNT_MISMATCH";
  if (refund.status !== "SUCCEEDED") return "CERTIFICATION_REFUND_NOT_SUCCEEDED";
  if (!text(refund.provider_reference)) return "CERTIFICATION_REFUND_PROVIDER_REFERENCE_MISSING";
  return undefined;
};

export type RefundPollAction =
  | { readonly kind: "CONVERGED" }
  /** The provider says it succeeded but the derived local facts have not caught up. Keep reading. */
  | { readonly kind: "WAIT_FOR_DERIVED"; readonly defect: string }
  | { readonly kind: "TERMINAL"; readonly status: string }
  | { readonly kind: "WAIT" };

/**
 * Only ever says to keep reading, or to stop. It cannot say to refund again:
 * a refund that already exists is reconciled, never re-issued, and there is no
 * observation of the provider that makes a second one correct.
 */
export const refundPollAction = (evidence: OrderEvidence, identifiers: RefundIdentifiers): RefundPollAction => {
  const refund = rows(evidence.refunds).find((candidate) => candidate.id === identifiers.refundId);
  const status = text(refund?.status);
  if (!status) return { kind: "WAIT" };
  if (status === "FAILED" || status === "REVIEW_REQUIRED") return { kind: "TERMINAL", status };
  if (status !== "SUCCEEDED") return { kind: "WAIT" };
  const defect = refundConvergenceDefect(evidence, identifiers);
  return defect ? { kind: "WAIT_FOR_DERIVED", defect } : { kind: "CONVERGED" };
};

/** The final artifact says PASS only if every terminal fact in it says so too. */
export const manifestDefect = (manifest: Record<string, unknown>, occurrenceId: string): string | undefined => {
  const section = (key: string): Record<string, unknown> => (manifest[key] ?? {}) as Record<string, unknown>;
  if (manifest.result !== "PASS") return "CERTIFICATION_MANIFEST_NOT_PASS";
  const occurrence = section("occurrence");
  if (occurrence.id !== occurrenceId) return "CERTIFICATION_MANIFEST_OCCURRENCE_MISMATCH";
  if (occurrence.final_sales_status !== "CLOSED" || occurrence.final_visibility !== "HIDDEN") return "CERTIFICATION_MANIFEST_OCCURRENCE_NOT_CLEANED";
  if (occurrence.public_cleanup_verified !== true) return "CERTIFICATION_MANIFEST_PUBLIC_CLEANUP_UNVERIFIED";
  if (section("booking").after_cancellation !== "CANCELLED") return "CERTIFICATION_MANIFEST_BOOKING_NOT_CANCELLED";
  if (section("ticket").after_cancellation !== "VOID") return "CERTIFICATION_MANIFEST_TICKET_NOT_VOID";
  if (section("refund").status !== "SUCCEEDED") return "CERTIFICATION_MANIFEST_REFUND_NOT_SUCCEEDED";
  if (section("payment").status !== "REFUNDED") return "CERTIFICATION_MANIFEST_PAYMENT_NOT_REFUNDED";
  return undefined;
};
