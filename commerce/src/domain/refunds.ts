import type Database from "better-sqlite3";
import { canonical, encryptTicketCapability, id, now, publicId, sha256 } from "../crypto";
import type { PaymentProvider } from "../provider";
import { DomainError, many, one, type Row, withImmediateTransaction } from "./shared";

interface RefundsHost {
  readonly db: Database.Database;
  readonly provider: PaymentProvider;
  readonly clock: () => number;
  enqueueEmail(type: string, recipientEmail: string, recipientEmailHash: string, template: string, payloadRef: string, payload: Record<string, unknown>): string;
  ensureFullCapturedRefund(paymentId: string, source: string, capturedTotal: number): Row | null;
  openOperationalIncident(code: string, entityType: "refund" | "order" | "occurrence", entityId: string, dedupeKey: string, details: Record<string, unknown>): void;
  resolveOperationalIncidents(entityType: "refund", entityId: string, resolution: string): void;
  supersedePendingOccurrenceUpdatesForBooking(bookingId: string, reason: string): void;
  closeOccurrenceChangeRefundEntitlementsForBooking(bookingId: string, reason: string): void;
  closeOccurrenceChangeRefundEntitlementsForOrder(orderId: string, reason: string): void;
  upsertRefundObligation(paymentId: string, source: string, target: number): Row;
}

export const submitRequestedRefunds = async (host: RefundsHost) => {
  const requests = many(host.db, "SELECT r.*, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.status = 'REQUESTED'");
  for (const refund of requests) {
    const claimed = withImmediateTransaction(host.db, () => host.db.prepare("UPDATE refunds SET status = 'SUBMITTING', submission_started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'REQUESTED'").run(now(), refund.id).changes);
    if (!claimed) continue;
    try {
      if (!refund.provider_payment_id) throw new Error("Provider payment reference is absent.");
      const submitted = await host.provider.refund({ refundId: String(refund.id), providerPaymentId: String(refund.provider_payment_id), amountKopecks: Number(refund.amount_kopecks), idempotencyKey: String(refund.idempotency_key_hash) });
      host.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = ?, last_reconcile_at = ? WHERE id = ? AND status = 'SUBMITTING'").run(submitted.providerReference, now(), refund.id);
    } catch (error) {
      host.db.prepare("UPDATE refunds SET status = 'SUBMIT_UNKNOWN', last_error = ? WHERE id = ? AND status = 'SUBMITTING'").run(error instanceof Error ? error.message : "Refund submission failed", refund.id);
    }
  }
};

/** Retains provider reconciliation as the authority for pending refund rows. */
export const reconcilePendingRefunds = async (host: RefundsHost) => {
  const refunds = many(host.db, "SELECT id FROM refunds WHERE status IN ('RECONCILING', 'SUBMIT_UNKNOWN') ORDER BY created_at LIMIT 50");
  for (const refund of refunds) {
    try { await reconcileRefund(host, String(refund.id)); } catch { /* retain the durable refund command for admin reconciliation */ }
  }
};

export const upsertRefundObligation = (host: RefundsHost, paymentId: string, source: string, target: number) => {
  const existing = one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId);
  if (existing && target > Number(existing.target_refunded_amount_kopecks)) {
    // A fulfilled partial customer-cancellation obligation can later be
    // superseded by a higher organizer/terminal-occurrence target. Reopen
    // only that fulfilled state so the worker can issue the remaining amount.
    host.db.prepare(`UPDATE refund_obligations
      SET target_refunded_amount_kopecks = ?,
        status = CASE WHEN status = 'FULFILLED' THEN 'OPEN' ELSE status END,
        fulfilled_at = CASE WHEN status = 'FULFILLED' THEN NULL ELSE fulfilled_at END
      WHERE id = ?`).run(target, existing.id);
  } else if (!existing) {
    host.db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, ?, ?, 'OPEN')").run(id(), paymentId, source, target);
  }
  const obligation = one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId)!;
  host.db.prepare("INSERT INTO refund_obligation_events(id, obligation_id, source) VALUES (?, ?, ?)").run(id(), obligation.id, source);
  return obligation;
};

export const ensureFullCapturedRefund = (host: RefundsHost, paymentId: string, source: string, capturedTotal: number) => {
  if (capturedTotal <= 0) return null;
  const succeeded = Number(one(host.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS total FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", paymentId)?.total ?? 0);
  if (succeeded >= capturedTotal) return one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId) ?? null;
  const existing = one(host.db, "SELECT * FROM refund_obligations WHERE payment_id = ?", paymentId);
  if (existing && Number(existing.target_refunded_amount_kopecks) >= capturedTotal) return existing;
  return host.upsertRefundObligation(paymentId, source, capturedTotal);
};

const validCustomerRefundToken = (host: RefundsHost, capability: string) => {
  const token = one(host.db, "SELECT * FROM customer_refund_confirmation_tokens WHERE token_hash = ?", sha256(capability));
  if (!token || token.invalidated_at || token.consumed_at || new Date(String(token.expires_at)).getTime() <= host.clock()) throw new DomainError("REFUND_CONFIRMATION_INVALID", 404);
  return token;
};

const customerRefundOrder = (host: RefundsHost, orderId: string) =>
  one(host.db, `SELECT o.id, o.public_order_number, o.customer_email, o.customer_email_hash,
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

const customerRefundEligibility = (host: RefundsHost, order: Row) => {
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
    return host.clock() < startsAt ? "ORGANIZER_CHANGE_ELIGIBLE" : "ORGANIZER_CHANGE_MANUAL_REVIEW";
  }
  const deadline = startsAt - 60 * 60_000;
  if (host.clock() >= deadline) return "CUTOFF_REACHED";
  return "ELIGIBLE";
};

export const requestCustomerRefund = (host: RefundsHost, normalizedOrderNumber: string) =>
  withImmediateTransaction(host.db, () => {
    const order = one(host.db, `SELECT o.id, o.public_order_number, o.customer_email, o.customer_email_hash, p.id AS payment_id, p.status AS payment_status,
      p.captured_amount_kopecks, b.id AS booking_id, b.status AS booking_status, oc.fulfillment_status, oc.starts_at
      FROM orders o JOIN payments p ON p.order_id = o.id JOIN bookings b ON b.order_id = o.id
      JOIN occurrences oc ON oc.id = o.occurrence_id
      WHERE replace(upper(o.public_order_number), '-', '') = ?`, normalizedOrderNumber);
    const currentOrder = order && customerRefundOrder(host, String(order.id));
    if (!currentOrder) return { accepted: true };
    const eligibility = customerRefundEligibility(host, currentOrder);
    if (eligibility === "ORGANIZER_CHANGE_MANUAL_REVIEW") {
      host.openOperationalIncident("ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW", "order", String(currentOrder.id), `organizer-change-refund-manual:${currentOrder.id}`, { order_id: currentOrder.id, booking_id: currentOrder.booking_id, reason: "OCCURRENCE_CHANGE_AFTER_START" });
      return { accepted: true };
    }
    if (eligibility !== "ELIGIBLE" && eligibility !== "ORGANIZER_CHANGE_ELIGIBLE") return { accepted: true };
    host.db.prepare(`UPDATE customer_refund_confirmation_tokens
      SET invalidated_at = ?
      WHERE order_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL
        AND EXISTS (SELECT 1 FROM email_outbox e WHERE e.type = 'CUSTOMER_REFUND_CONFIRMATION' AND e.payload_ref = customer_refund_confirmation_tokens.id AND e.status = 'PENDING')`).run(now(), order.id);
    const reusable = one(host.db, `SELECT t.id FROM customer_refund_confirmation_tokens t
      WHERE t.order_id = ? AND t.consumed_at IS NULL AND t.invalidated_at IS NULL AND t.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM email_outbox e WHERE e.type = 'CUSTOMER_REFUND_CONFIRMATION' AND e.payload_ref = t.id AND e.status = 'PENDING')
      ORDER BY t.created_at DESC LIMIT 1`, order.id, new Date(host.clock()).toISOString());
    if (reusable) return { accepted: true };
    const capability = publicId();
    const encrypted = encryptTicketCapability(capability);
    const tokenId = id();
    const expiresAt = new Date(host.clock() + 30 * 60_000).toISOString();
    host.db.prepare(`INSERT INTO customer_refund_confirmation_tokens(id, token_hash, token_ciphertext, token_nonce, order_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(tokenId, sha256(capability), encrypted.ciphertext, encrypted.nonce, order.id, expiresAt);
    host.enqueueEmail("CUSTOMER_REFUND_CONFIRMATION", String(order.customer_email), String(order.customer_email_hash), "customer-refund-confirmation", tokenId, { order_id: order.id, public_order_number: order.public_order_number, expires_at: expiresAt });
    return { accepted: true };
  });

export const customerRefundConfirmationContext = (host: RefundsHost, capability: string) => {
  const token = validCustomerRefundToken(host, capability);
  const order = customerRefundOrder(host, String(token.order_id));
  if (!order) throw new DomainError("REFUND_CONFIRMATION_INVALID", 404);
  const eligibility = customerRefundEligibility(host, order);
  return {
    order_number: order.public_order_number,
    occurrence: { title: order.occurrence_title, city: order.city_title, starts_at: order.starts_at, timezone: order.timezone },
    amount_remaining_kopecks: Math.max(0, Number(order.captured_amount_kopecks) - Number(order.successful_refunded_amount_kopecks)),
    eligibility,
    ...(["ELIGIBLE", "ORGANIZER_CHANGE_ELIGIBLE"].includes(String(eligibility)) ? {} : { manual_contact: "art@flexperiment.ru" }),
    expires_at: token.expires_at,
  };
};

export const confirmCustomerRefund = (host: RefundsHost, capability: string) =>
  withImmediateTransaction(host.db, () => {
    const token = validCustomerRefundToken(host, capability);
    const order = customerRefundOrder(host, String(token.order_id));
    const eligibility = order && customerRefundEligibility(host, order);
    if (order && eligibility === "ORGANIZER_CHANGE_MANUAL_REVIEW") {
      host.openOperationalIncident("ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW", "order", String(order.id), `organizer-change-refund-manual:${order.id}`, { order_id: order.id, booking_id: order.booking_id, reason: "OCCURRENCE_CHANGE_AFTER_START" });
      return { confirmed: false, manual_review: true, manual_contact: "art@flexperiment.ru" };
    }
    if (!order || !["ELIGIBLE", "ORGANIZER_CHANGE_ELIGIBLE"].includes(String(eligibility))) throw new DomainError("REFUND_NOT_ELIGIBLE", 409);
    host.db.prepare("UPDATE customer_refund_confirmation_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), token.id);
    host.db.prepare("UPDATE customer_refund_confirmation_tokens SET invalidated_at = ? WHERE order_id = ? AND id <> ? AND consumed_at IS NULL AND invalidated_at IS NULL").run(now(), order.id, token.id);
    host.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'CUSTOMER_SELF_SERVICE_REFUND' WHERE id = ? AND status = 'CONFIRMED'").run(now(), order.booking_id);
    host.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), order.booking_id);
    host.supersedePendingOccurrenceUpdatesForBooking(String(order.booking_id), "BOOKING_CANCELLED");
    host.closeOccurrenceChangeRefundEntitlementsForBooking(String(order.booking_id), "BOOKING_CANCELLED");
    host.ensureFullCapturedRefund(String(order.payment_id), "CUSTOMER_SELF_SERVICE_REFUND", Number(order.captured_amount_kopecks));
    host.enqueueEmail("CUSTOMER_REFUND_CONFIRMED", String(order.customer_email), String(order.customer_email_hash), "customer-refund-confirmed", String(order.id), { order_id: order.id, public_order_number: order.public_order_number });
    return { confirmed: true };
  });

export const cancelCustomerBooking = (
  host: RefundsHost,
  bookingId: string,
  input: { reason: string; confirmation_text: string; withheld_expense_amount_kopecks?: number; expense_justification?: string; evidence_reference?: string },
  idempotencyKey: string,
) => {
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256(canonical(input));
  return withImmediateTransaction(host.db, () => {
    const replay = one(host.db, "SELECT canonical_request_hash, booking_id FROM booking_cancellation_idempotency WHERE idempotency_key_hash = ?", keyHash);
    if (replay) {
      if (replay.canonical_request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return one(host.db, "SELECT * FROM bookings WHERE id = ?", replay.booking_id)!;
    }
    const booking = one(host.db, `SELECT b.*, p.id AS payment_id, p.status AS payment_status, p.captured_amount_kopecks, o.fulfillment_status, ord.customer_email, ord.customer_email_hash, ord.public_order_number
      FROM bookings b JOIN payments p ON p.order_id = b.order_id JOIN occurrences o ON o.id = b.occurrence_id JOIN orders ord ON ord.id = b.order_id WHERE b.id = ?`, bookingId);
    if (!booking || !["RESERVED", "CONFIRMED"].includes(String(booking.status))) throw new DomainError("BOOKING_NOT_CANCELLABLE", 409);
    if (booking.fulfillment_status !== "SCHEDULED") throw new DomainError("TERMINAL_OCCURRENCE", 409);
    if (input.confirmation_text !== `CANCEL ${bookingId}`) throw new DomainError("CONFIRMATION_REQUIRED", 422);
    const withheld = input.withheld_expense_amount_kopecks ?? 0;
    if (booking.payment_status !== "PAID" && withheld !== 0) throw new DomainError("WITHHOLDING_BEFORE_CAPTURE_FORBIDDEN", 422);
    if (withheld > Number(booking.captured_amount_kopecks)) throw new DomainError("WITHHOLDING_EXCEEDS_CAPTURED", 422);
    host.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = ? WHERE id = ?").run(now(), input.reason, bookingId);
    host.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), bookingId);
    host.supersedePendingOccurrenceUpdatesForBooking(bookingId, "BOOKING_CANCELLED");
    host.closeOccurrenceChangeRefundEntitlementsForBooking(bookingId, "BOOKING_CANCELLED");
    host.enqueueEmail("BOOKING_CANCELLED", String(booking.customer_email), String(booking.customer_email_hash), "booking-cancelled", bookingId, { booking_id: bookingId, reason: input.reason, public_order_number: booking.public_order_number });
    host.db.prepare("INSERT INTO booking_cancellation_idempotency(idempotency_key_hash, canonical_request_hash, booking_id) VALUES (?, ?, ?)").run(keyHash, requestHash, bookingId);
    if (booking.payment_status === "PAID") host.upsertRefundObligation(String(booking.payment_id), "CUSTOMER_CANCELLATION_PARTIAL", Number(booking.captured_amount_kopecks) - withheld);
    return one(host.db, "SELECT * FROM bookings WHERE id = ?", bookingId)!;
  });
};

export const createCompensationRefund = (
  host: RefundsHost,
  orderId: string,
  input: { amount_kopecks: number; reason: string; note?: string },
  idempotencyKey: string,
) => {
  const keyHash = sha256(idempotencyKey);
  const requestHash = sha256(canonical(input));
  return withImmediateTransaction(host.db, () => {
    const existing = one(host.db, "SELECT * FROM refunds WHERE idempotency_key_hash = ?", keyHash);
    if (existing) {
      if (existing.canonical_request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", 409);
      return existing;
    }
    const payment = one(host.db, "SELECT * FROM payments WHERE order_id = ?", orderId);
    if (!payment || !["PAID", "PARTIALLY_REFUNDED"].includes(String(payment.status))) throw new DomainError("PAYMENT_NOT_REFUNDABLE", 409);
    const used = one(host.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS succeeded FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", payment.id)!;
    const active = one(host.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS inflight FROM refunds WHERE payment_id = ? AND status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING')", payment.id)!;
    if (input.amount_kopecks > Number(payment.captured_amount_kopecks) - Number(used.succeeded) - Number(active.inflight)) throw new DomainError("REFUND_AMOUNT_EXCEEDS_AVAILABLE", 409);
    const refundId = id();
    host.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, note, source, status, idempotency_key_hash, canonical_request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ADMIN_COMPENSATION', 'REQUESTED', ?, ?)`)
      .run(refundId, publicId(), orderId, payment.id, input.amount_kopecks, input.reason, input.note ?? null, keyHash, requestHash);
    return one(host.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
  });
};

export const createObligationRefunds = (host: RefundsHost) =>
  withImmediateTransaction(host.db, () => many(host.db, `SELECT ro.*, p.order_id, p.captured_amount_kopecks FROM refund_obligations ro JOIN payments p ON p.id = ro.payment_id
    WHERE ro.status IN ('OPEN', 'FULFILLING')`).flatMap((obligation) => {
    const succeeded = Number(one(host.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS amount FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", obligation.payment_id)?.amount ?? 0);
    const active = one(host.db, "SELECT id FROM refunds WHERE payment_id = ? AND status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING')", obligation.payment_id);
    const outstanding = Number(obligation.target_refunded_amount_kopecks) - succeeded;
    if (outstanding <= 0) {
      host.db.prepare("UPDATE refund_obligations SET status = 'FULFILLED', fulfilled_at = ? WHERE id = ?").run(now(), obligation.id);
      return [];
    }
    if (active) return [];
    const refundId = id();
    host.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
      VALUES (?, ?, ?, ?, ?, 'Refund obligation', 'REFUND_OBLIGATION', 'REQUESTED', ?, ?)`)
      .run(refundId, publicId(), obligation.order_id, obligation.payment_id, outstanding, sha256(`obligation:${obligation.id}:${outstanding}`), sha256(`obligation:${obligation.id}:${outstanding}`));
    host.db.prepare("UPDATE refund_obligations SET status = 'FULFILLING' WHERE id = ?").run(obligation.id);
    return [one(host.db, "SELECT * FROM refunds WHERE id = ?", refundId)!];
  }));

const fulfillRefundObligationIfTargetMet = (host: RefundsHost, paymentId: string) => {
  const obligation = one(host.db, `SELECT id, target_refunded_amount_kopecks
    FROM refund_obligations
    WHERE payment_id = ? AND status IN ('OPEN', 'FULFILLING')`, paymentId);
  if (!obligation) return false;
  const succeeded = Number(one(host.db, `SELECT COALESCE(SUM(amount_kopecks), 0) AS amount
    FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'`, paymentId)?.amount ?? 0);
  if (succeeded < Number(obligation.target_refunded_amount_kopecks)) return false;
  host.db.prepare(`UPDATE refund_obligations
    SET status = 'FULFILLED', fulfilled_at = COALESCE(fulfilled_at, ?)
    WHERE id = ? AND status IN ('OPEN', 'FULFILLING')`).run(now(), obligation.id);
  return true;
};

const cancelConfirmedBookingForFullRefund = (host: RefundsHost, orderId: string) => {
  const booking = one(host.db, "SELECT id FROM bookings WHERE order_id = ? AND status = 'CONFIRMED'", orderId);
  if (!booking) {
    host.closeOccurrenceChangeRefundEntitlementsForOrder(orderId, "FULL_REFUND");
    return false;
  }
  const cancelled = host.db.prepare(`UPDATE bookings
    SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'FULL_REFUND'
    WHERE id = ? AND status = 'CONFIRMED'`).run(now(), booking.id);
  if (!cancelled.changes) {
    host.closeOccurrenceChangeRefundEntitlementsForOrder(orderId, "FULL_REFUND");
    return false;
  }
  host.db.prepare("UPDATE tickets SET status = 'VOID', voided_at = ? WHERE booking_id = ? AND status = 'VALID'").run(now(), booking.id);
  host.supersedePendingOccurrenceUpdatesForBooking(String(booking.id), "FULL_REFUND");
  host.closeOccurrenceChangeRefundEntitlementsForOrder(orderId, "FULL_REFUND");
  return true;
};

export const reconcileRefund = async (host: RefundsHost, refundId: string) => {
  const refund = one(host.db, "SELECT r.*, p.provider_payment_id FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = ?", refundId);
  if (!refund) throw new DomainError("REFUND_NOT_FOUND", 404);
  if (refund.status === "SUCCEEDED") return one(host.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
  if (!refund.provider_payment_id) throw new DomainError("PROVIDER_REFERENCE_REQUIRED", 422);
  const observed = await host.provider.reconcileRefund({ providerPaymentId: String(refund.provider_payment_id), providerReference: refund.provider_reference ? String(refund.provider_reference) : null, amountKopecks: Number(refund.amount_kopecks), idempotencyKey: String(refund.idempotency_key_hash) });
  host.db.prepare("UPDATE refunds SET last_reconcile_at = ?, provider_observed_total_refunded = ? WHERE id = ?").run(now(), observed.refundedAmountKopecks ?? null, refundId);
  if (observed.status === "SUCCEEDED" && observed.refundedAmountKopecks === Number(refund.amount_kopecks)) {
    return withImmediateTransaction(host.db, () => {
      const finalized = host.db.prepare("UPDATE refunds SET status = 'SUCCEEDED', succeeded_at = ? WHERE id = ? AND status <> 'SUCCEEDED'").run(now(), refundId);
      if (!finalized.changes) return one(host.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
      const totals = one(host.db, "SELECT COALESCE(SUM(amount_kopecks), 0) AS amount FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'", refund.payment_id)!;
      const payment = one(host.db, "SELECT captured_amount_kopecks FROM payments WHERE id = ?", refund.payment_id)!;
      const fullyRefunded = Number(totals.amount) >= Number(payment.captured_amount_kopecks);
      host.db.prepare("UPDATE payments SET status = ?, updated_at = ? WHERE id = ?").run(fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED", now(), refund.payment_id);
      fulfillRefundObligationIfTargetMet(host, String(refund.payment_id));
      if (fullyRefunded) cancelConfirmedBookingForFullRefund(host, String(refund.order_id));
      host.db.prepare("UPDATE reservation_abandonments SET status = 'LATE_PAYMENT_REFUNDED', resolved_at = ? WHERE payment_id = ? AND status = 'LATE_PAYMENT_REVIEW_REQUIRED'").run(now(), refund.payment_id);
      const order = one(host.db, "SELECT customer_email, customer_email_hash, public_order_number FROM orders WHERE id = ?", refund.order_id)!;
      host.enqueueEmail("REFUND_SUCCEEDED", String(order.customer_email), String(order.customer_email_hash), "refund-succeeded", refundId, {
        refund_id: refundId, amount_kopecks: refund.amount_kopecks, public_order_number: order.public_order_number,
        fulfillment_outcome: fullyRefunded ? "FULL" : "PARTIAL",
      });
      host.resolveOperationalIncidents("refund", refundId, "Provider refund succeeded");
      return one(host.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
    });
  }
  return withImmediateTransaction(host.db, () => {
    const failed = observed.status === "FAILED";
    host.db.prepare(`UPDATE refunds SET status = ?, failed_at = CASE WHEN ? THEN ? ELSE failed_at END WHERE id = ?`)
      .run(failed ? "FAILED" : "REVIEW_REQUIRED", failed ? 1 : 0, now(), refundId);
    const order = one(host.db, "SELECT public_order_number, customer_email FROM orders WHERE id = ?", refund.order_id);
    host.openOperationalIncident("REFUND_REQUIRES_REVIEW", "refund", refundId, `refund-attention:${refundId}`, {
      refund_id: refundId, state: failed ? "FAILED" : "REVIEW_REQUIRED", order_id: refund.order_id,
      public_order_number: order?.public_order_number ?? null, customer_email: order?.customer_email ?? null,
      amount_kopecks: refund.amount_kopecks, provider_reference: refund.provider_reference ?? null,
      provider_payment_id: refund.provider_payment_id,
    });
    return one(host.db, "SELECT * FROM refunds WHERE id = ?", refundId)!;
  });
};
