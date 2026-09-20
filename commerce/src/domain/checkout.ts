import type Database from "better-sqlite3";
import { now } from "../crypto";
import { providerErrorEvidence, type PaymentProvider } from "../provider";
import type { CheckoutRequest } from "../types";
import { DomainError, one, type Row } from "./shared";

type CheckoutInput = Omit<CheckoutRequest, "participant_age_band"> & { participant_age_band: string };

interface CheckoutHost {
  readonly db: Database.Database;
  readonly provider: PaymentProvider;
  checkout(input: CheckoutInput, idempotencyKey: string, acceptance?: { ip?: string; userAgent?: string }): { status_id: unknown; status: string; payment_url: unknown };
  checkoutResult(value: Row): { status_id: unknown; status: string; payment_url: unknown };
  checkoutStatus(statusId: string): { status_id: unknown; status: string; payment_url: unknown };
}

export const checkoutStatus = (host: CheckoutHost, statusId: string) => {
  const payment = one(host.db, `SELECT p.state, p.status, p.payment_url
    FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?`, statusId);
  if (!payment) throw new DomainError("CHECKOUT_NOT_FOUND", 404);
  return host.checkoutResult({ status_id: statusId, ...payment });
};

/** Performs external payment creation only after checkout state has committed. */
export const checkoutAsync = async (host: CheckoutHost, input: CheckoutInput, idempotencyKey: string, successBaseUrl: string, acceptance: { ip?: string; userAgent?: string } = {}) => {
  const first = host.checkout(input, idempotencyKey, acceptance);
  const payment = one(host.db, `SELECT p.*, p.id AS payment_id, o.id AS order_id, o.amount_kopecks, o.customer_email, o.fiscal_purpose_snapshot, o.fiscal_item_name_snapshot
    FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?`, first.status_id);
  if (!payment || payment.state !== "CREATING") return first;
  try {
    host.db.prepare("UPDATE payments SET provider_request_started_at = ?, updated_at = ? WHERE id = ? AND state = 'CREATING'").run(now(), now(), payment.payment_id);
    if (!payment.fiscal_item_name_snapshot || !payment.fiscal_purpose_snapshot) throw new Error("Order has no immutable fiscal snapshot.");
    const created = await host.provider.createPayment({ paymentId: String(payment.payment_id), paymentLinkId: String(payment.payment_id), amountKopecks: Number(payment.amount_kopecks), idempotencyKey: String(payment.provider_idempotency_key), successUrl: `${successBaseUrl}/payment/success?order=${first.status_id}`, customerEmail: String(payment.customer_email), purpose: String(payment.fiscal_purpose_snapshot), receiptItemName: String(payment.fiscal_item_name_snapshot) });
    host.db.prepare("UPDATE payments SET state = 'CREATED', provider_payment_id = ?, payment_url = ?, updated_at = ? WHERE id = ? AND state = 'CREATING'").run(created.providerPaymentId, created.paymentUrl, now(), payment.payment_id);
  } catch (error) {
    const evidence = providerErrorEvidence(error);
    host.db.prepare(`UPDATE payments
      SET state = 'CREATE_UNKNOWN', provider_error_class = ?, provider_error_code = ?, updated_at = ?
      WHERE id = ? AND state = 'CREATING'`).run(evidence.provider_error_class, evidence.provider_error_code, now(), payment.payment_id);
  }
  return host.checkoutStatus(String(first.status_id));
};
