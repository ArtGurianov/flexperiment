import type Database from "better-sqlite3";
import { encryptTicketCapability, id, now, publicId, sha256 } from "../crypto";
import type { PaymentProvider } from "../provider";
import { DomainError, many, occurrenceCustomerSnapshot, one, type Row, withImmediateTransaction } from "./shared";

export type TochkaPaymentWebhook = {
  rawHash: string;
  operationId: string;
  paymentLinkId: string;
  amountKopecks: number;
  customerCode: string;
  merchantId: string;
  paymentType: string;
  status: string;
  webhookType: string;
  currency?: string;
};

interface PaymentsHost {
  readonly db: Database.Database;
  readonly provider: PaymentProvider;
  enqueueEmail(type: string, recipientEmail: string, recipientEmailHash: string, template: string, payloadRef: string, payload: Record<string, unknown>): string;
  markPaymentPaid(paymentId: string, capturedAmount: number, providerPaymentId?: string): Record<string, unknown>;
  recordProviderDrift(entityType: "PAYMENT" | "REFUND", entityId: string, observed: Record<string, unknown>): void;
  reconcilePayment(paymentId: string): Promise<unknown>;
  upsertRefundObligation(paymentId: string, source: string, target: number): Row;
}

/** Retains provider reconciliation as the authority for pending payment rows. */
export const reconcilePendingPayments = async (host: PaymentsHost) => {
  const payments = many(host.db, "SELECT id FROM payments WHERE provider_payment_id IS NOT NULL AND status = 'PENDING' AND state = 'CREATED' ORDER BY created_at LIMIT 50");
  for (const payment of payments) {
    try { await host.reconcilePayment(String(payment.id)); } catch { /* retain reservation until authoritative evidence arrives */ }
  }
};

export const reconcilePayment = async (host: PaymentsHost, paymentId: string) => {
  const payment = one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId);
  if (!payment) throw new DomainError("PAYMENT_NOT_FOUND", 404);
  if (!payment.provider_payment_id) throw new DomainError("PROVIDER_REFERENCE_REQUIRED", 422);
  const observed = await host.provider.reconcilePayment({ providerPaymentId: String(payment.provider_payment_id) });
  host.db.prepare("UPDATE payments SET last_reconcile_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), paymentId);
  if (observed.status === "PAID" && observed.capturedAmountKopecks !== undefined) return host.markPaymentPaid(paymentId, observed.capturedAmountKopecks, String(payment.provider_payment_id));
  if (observed.status === "FAILED") {
    return withImmediateTransaction(host.db, () => {
      host.db.prepare("UPDATE payments SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now(), paymentId);
      host.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancellation_reason = 'PAYMENT_PROVIDER_FAILED' WHERE order_id = ? AND status = 'RESERVED'").run(now(), payment.order_id);
      return one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
    });
  }
  // Pending or unknown provider evidence is not a failure proof; retain the
  // reservation and let a later reconciliation establish a terminal outcome.
  host.db.prepare("UPDATE payments SET updated_at = ? WHERE id = ?").run(now(), paymentId);
  return one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
};

const markPaymentPaidInTransaction = (host: PaymentsHost, paymentId: string, capturedAmount: number, providerPaymentId?: string) => {
  const payment = one(host.db, "SELECT p.*, o.occurrence_id, o.id AS order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?", paymentId);
  if (!payment) throw new DomainError("PAYMENT_NOT_FOUND", 404);
  if (payment.status === "PAID") return payment;
  host.db.prepare("UPDATE payments SET status = 'PAID', state = 'CREATED', captured_amount_kopecks = ?, provider_payment_id = COALESCE(?, provider_payment_id), updated_at = ? WHERE id = ?").run(capturedAmount, providerPaymentId ?? null, now(), paymentId);
  const booking = one(host.db, "SELECT * FROM bookings WHERE order_id = ?", payment.order_id);
  const occurrence = one(host.db, "SELECT fulfillment_status FROM occurrences WHERE id = ?", payment.occurrence_id);
  if (booking?.status === "RESERVED" && occurrence?.fulfillment_status === "SCHEDULED") {
    host.db.prepare("UPDATE bookings SET status = 'CONFIRMED' WHERE id = ? AND status = 'RESERVED'").run(booking.id);
    const capability = publicId();
    const encrypted = encryptTicketCapability(capability);
    const order = one(host.db, `SELECT o.customer_email, o.customer_email_hash, o.public_order_number,
      o.participant_age_band, o.participant_requires_adult_accompaniment,
      oc.title, oc.starts_at, oc.ends_at, oc.timezone, oc.venue_status, oc.venue_name,
      oc.venue_address, oc.venue_disclosure_text, oc.venue_announce_by, c.title AS city_title
      FROM orders o JOIN occurrences oc ON oc.id = o.occurrence_id JOIN cities c ON c.id = oc.city_id
      WHERE o.id = ?`, payment.order_id)!;
    const ticketId = id();
    host.db.prepare(`INSERT INTO tickets(id, booking_id, status, capability_hash, capability_ciphertext, capability_nonce, key_version)
      VALUES (?, ?, 'VALID', ?, ?, ?, 1)`).run(ticketId, booking.id, sha256(capability), encrypted.ciphertext, encrypted.nonce);
    host.enqueueEmail("TICKET", String(order.customer_email), String(order.customer_email_hash), "ticket", ticketId, {
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
  } else {
    const abandonment = one(host.db, "SELECT id FROM reservation_abandonments WHERE payment_id = ?", payment.id);
    const source = abandonment ? "LATE_PAYMENT_AFTER_RESERVATION_ABANDONMENT" : occurrence?.fulfillment_status === "SCHEDULED" ? "LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION" : "LATE_PAYMENT_AFTER_TERMINAL_OCCURRENCE";
    const obligation = host.upsertRefundObligation(String(payment.id), source, capturedAmount);
    if (abandonment) {
      host.db.prepare("UPDATE refund_obligations SET status = 'REVIEW_REQUIRED' WHERE id = ?").run(obligation.id);
      host.db.prepare("UPDATE reservation_abandonments SET status = 'LATE_PAYMENT_REVIEW_REQUIRED' WHERE id = ?").run(abandonment.id);
    }
  }
  return one(host.db, "SELECT * FROM payments WHERE id = ?", paymentId)!;
};

export const markPaymentPaid = (host: PaymentsHost, paymentId: string, capturedAmount: number, providerPaymentId?: string) =>
  withImmediateTransaction(host.db, () => markPaymentPaidInTransaction(host, paymentId, capturedAmount, providerPaymentId));

export const applyTochkaPaymentWebhook = (host: PaymentsHost, input: TochkaPaymentWebhook, expected: { customerCode: string; merchantId: string }) =>
  withImmediateTransaction(host.db, () => {
    const semanticKey = `${input.operationId}:${input.status}`;
    const known = one(host.db, "SELECT id, payload_hash, status, entity_id FROM provider_webhook_events WHERE provider = 'TOCHKA' AND semantic_key = ?", semanticKey);
    const payment = one(host.db, `SELECT p.*, o.amount_kopecks FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.id = ?`, input.paymentLinkId);
    const observed = JSON.stringify({ operation_id: input.operationId, payment_link_id: input.paymentLinkId, amount_kopecks: input.amountKopecks, payment_type: input.paymentType, status: input.status, webhook_type: input.webhookType, currency: input.currency ?? "RUB" });
    const valid = input.webhookType === "acquiringInternetPayment" && input.status === "APPROVED" && ["card", "sbp"].includes(input.paymentType) && (!input.currency || input.currency === "RUB") && input.customerCode === expected.customerCode && input.merchantId === expected.merchantId && payment && Number(payment.amount_kopecks) === input.amountKopecks;
    if (known) {
      if (known.payload_hash === input.rawHash) return { duplicate: true, applied: false };
      const knownVariant = one(host.db, `SELECT id FROM provider_webhook_event_conflicts
        WHERE provider = 'TOCHKA' AND semantic_key = ? AND payload_hash = ?`, semanticKey, input.rawHash);
      if (knownVariant) return { duplicate: true, applied: false };
      host.db.prepare(`INSERT INTO provider_webhook_event_conflicts(
        id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
      ) VALUES (?, 'TOCHKA', ?, ?, ?, ?, ?, ?)`).run(id(), semanticKey, known.id, input.rawHash, "CONFLICT_QUARANTINED", payment?.id ?? known.entity_id ?? null, observed);
      const affectedPaymentId = payment?.id ?? known.entity_id;
      if (affectedPaymentId) host.recordProviderDrift("PAYMENT", String(affectedPaymentId), {
        webhook_semantic_key_collision: { semantic_key: semanticKey, original_event_id: known.id, original_status: known.status, incoming_payload_hash: input.rawHash },
      });
      return { duplicate: false, applied: false, conflict: true };
    }
    if (!valid) {
      host.db.prepare("INSERT INTO provider_webhook_events(id, provider, semantic_key, payload_hash, status, entity_id, observed_json) VALUES (?, 'TOCHKA', ?, ?, 'QUARANTINED', ?, ?)").run(id(), semanticKey, input.rawHash, payment?.id ?? null, observed);
      if (payment) host.recordProviderDrift("PAYMENT", String(payment.id), { webhook: { operation_id: input.operationId, amount_kopecks: input.amountKopecks, payment_type: input.paymentType, status: input.status } });
      return { duplicate: false, applied: false };
    }
    host.db.prepare("INSERT INTO provider_webhook_events(id, provider, semantic_key, payload_hash, status, entity_id, observed_json) VALUES (?, 'TOCHKA', ?, ?, 'APPLIED', ?, ?)").run(id(), semanticKey, input.rawHash, payment.id, observed);
    markPaymentPaidInTransaction(host, String(payment.id), input.amountKopecks, input.operationId);
    return { duplicate: false, applied: true };
  });
