import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain, DomainError, STALE_PREPARED_SETTLEMENT_MS } from "../src/domain";
import { runWorkerSweep } from "../src/worker-sweep";
import type { EmailProvider } from "../src/email-provider";
import { MockProvider, type PaymentProvider } from "../src/provider";
import { decryptTicketCapability } from "../src/crypto";

const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };

function fixture(filename = ":memory:") {
  const db = openDatabase(filename); migrate(db);
  const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2026-10-01T10:00:00.000Z', '2026-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return { db, domain: new CommerceDomain(db, new MockProvider()), occurrenceId };
}

function checkoutPayload(quoteId: string) {
  return { quote_id: quoteId, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true as const, offer_accepted: true as const, pd_consent_accepted: true as const };
}

function promoter(setup: ReturnType<typeof fixture>, slug: string, rewardType: "PERCENT" | "FIXED" = "PERCENT", rewardValue = 1_000) {
  return setup.domain.createAgent({ slug, display_name: slug, legal_name: `${slug} legal`, email: `${slug}@example.test`, contractor_type: "SELF_EMPLOYED", inn: "123456789012", contract_reference: `C-${slug}`, default_reward_type: rewardType, default_reward_value: rewardValue });
}

async function maturedReward(setup: ReturnType<typeof fixture>, slug: string, amount = 10_000) {
  const agent = promoter(setup, slug, "FIXED", amount);
  const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: slug });
  const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), `settlement-${slug}-checkout`, "https://flexperiment.ru");
  const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string };
  setup.domain.markPaymentPaid(payment.id, 100_000, "settlement-provider");
  setup.domain.patchAgent(String(agent.id), { npd_status_checked_at: new Date().toISOString() });
  setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
  setup.domain.completeOccurrence(setup.occurrenceId);
  return agent;
}

async function reconcileSuccessfulRefund(setup: ReturnType<typeof fixture>, orderId: string, paymentId: string, amount: number) {
  const refundId = randomUUID();
  setup.db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, provider_reference) VALUES (?, ?, ?, ?, ?, 'test', 'ADMIN_COMPENSATION', 'RECONCILING', ?, ?, 'test-reference')")
    .run(refundId, randomUUID(), orderId, paymentId, amount, randomUUID(), randomUUID());
  (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: amount });
  await setup.domain.reconcileRefund(refundId);
}

describe("commerce domain", () => {
  const databases: ReturnType<typeof fixture>["db"][] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  it("permanently binds a checkout idempotency key and reserves one seat", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "promoter" });
    const payload = { quote_id: quote.quote_id, customer_name: "Арт Гурьянов", customer_email: "art@example.test", eligibility_confirmed: true as const, offer_accepted: true as const, pd_consent_accepted: true as const };
    const first = await setup.domain.checkoutAsync(payload, "8f3a27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    const replay = await setup.domain.checkoutAsync(payload, "8f3a27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    expect(first.status_id).toBe(replay.status_id);
    expect(replay.payment_url).toContain("/payment/success?order=");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM bookings").get()).toMatchObject({ count: 1 });
    expect(setup.db.prepare("SELECT public_offer_version, public_offer_sha256, public_offer_accepted_at, privacy_policy_version, privacy_policy_presented_at, pd_consent_version, pd_consent_accepted_at, checkout_disclosure_version FROM orders").get()).toMatchObject({ public_offer_version: "test-1", public_offer_sha256: "0".repeat(64), privacy_policy_version: "test-1", pd_consent_version: "test-1", checkout_disclosure_version: "test-1" });
    await expect(setup.domain.checkoutAsync({ ...payload, customer_name: "Другой" }, "8f3a27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("releases a reserved seat only after provider-authoritative failure", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    provider.reconcilePayment = async () => ({ status: "FAILED" as const });
    const domain = new CommerceDomain(setup.db, provider);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000010", "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT status FROM bookings").get()).toMatchObject({ status: "RESERVED" });
    await domain.reconcilePendingPayments();
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings").get()).toMatchObject({ status: "CANCELLED", cancellation_reason: "PAYMENT_PROVIDER_FAILED" });
    expect(domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(5);
  });

  it("retains a reservation when payment creation is unknown", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    provider.createPayment = async () => { throw new Error("response lost"); };
    const domain = new CommerceDomain(setup.db, provider);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000011", "https://flexperiment.ru");
    await domain.reconcilePendingPayments();
    expect(setup.db.prepare("SELECT state, status FROM payments").get()).toMatchObject({ state: "CREATE_UNKNOWN", status: "PENDING" });
    expect(setup.db.prepare("SELECT status FROM bookings").get()).toMatchObject({ status: "RESERVED" });
  });

  it("abandons a reservation idempotently and routes a late payment into refund review", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "promoter" });
    await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000012", "https://flexperiment.ru");
    const ids = setup.db.prepare("SELECT o.id AS order_id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id").get() as { order_id: string; payment_id: string };
    const key = "8f3a27bc-77c6-47b1-b6d0-000000000013";
    const first = setup.domain.abandonReservation(ids.order_id, { reason: "Certification interrupted before payment" }, key, "admin");
    const replay = setup.domain.abandonReservation(ids.order_id, { reason: "Certification interrupted before payment" }, key, "admin");
    expect(replay.id).toBe(first.id);
    expect(() => setup.domain.abandonReservation(ids.order_id, { reason: "Different reason" }, key, "admin")).toThrow("IDEMPOTENCY_CONFLICT");
    setup.domain.markPaymentPaid(ids.payment_id, 100000, "late-provider-payment");
    expect(setup.db.prepare("SELECT status FROM bookings WHERE id = ?").get(first.id)).toMatchObject({ status: "CANCELLED" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets").get()).toMatchObject({ count: 0 });
    expect(setup.db.prepare("SELECT initial_source, status FROM refund_obligations WHERE payment_id = ?").get(ids.payment_id)).toMatchObject({ initial_source: "LATE_PAYMENT_AFTER_RESERVATION_ABANDONMENT", status: "REVIEW_REQUIRED" });
    expect(setup.db.prepare("SELECT status FROM reservation_abandonments WHERE payment_id = ?").get(ids.payment_id)).toMatchObject({ status: "LATE_PAYMENT_REVIEW_REQUIRED" });
  });

  it("fails closed when the active legal release lacks checkout evidence", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare("UPDATE legal_releases SET manifest_json = '{}' WHERE active = 1").run();
    expect(() => setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId })).toThrow("LEGAL_RELEASE_INVALID");
  });

  it("does not resurrect a customer-cancelled booking when payment is approved late", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000002", "https://flexperiment.ru");
    const booking = setup.db.prepare("SELECT b.id, p.id AS payment_id FROM bookings b JOIN orders o ON o.id = b.order_id JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.cancelCustomerBooking(booking.id, { reason: "Support request", confirmation_text: `CANCEL ${booking.id}` }, "8f3a27bc-77c6-47b1-b6d0-000000000003");
    setup.domain.markPaymentPaid(booking.payment_id, 100000, "late-provider-payment");
    expect(setup.db.prepare("SELECT status FROM bookings WHERE id = ?").get(booking.id)).toMatchObject({ status: "CANCELLED" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets").get()).toMatchObject({ count: 0 });
    expect(setup.db.prepare("SELECT initial_source, target_refunded_amount_kopecks FROM refund_obligations WHERE payment_id = ?").get(booking.payment_id)).toMatchObject({ initial_source: "LATE_PAYMENT_AFTER_CUSTOMER_CANCELLATION", target_refunded_amount_kopecks: 100000 });
  });

  it("keeps a confirmed booking active for an admin compensation refund", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000004", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    const refund = setup.domain.createCompensationRefund(order.id, { amount_kopecks: 10000, reason: "Venue inconvenience" }, "8f3a27bc-77c6-47b1-b6d0-000000000005");
    expect(refund.source).toBe("ADMIN_COMPENSATION");
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT status FROM tickets").get()).toMatchObject({ status: "VALID" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM refunds").get()).toMatchObject({ count: 1 });
  });

  it("cancels an occurrence once and upserts a full refund obligation without a ticket", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000006", "https://flexperiment.ru");
    const data = setup.db.prepare("SELECT b.id AS booking_id, p.id AS payment_id FROM bookings b JOIN orders o ON o.id = b.order_id JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { booking_id: string; payment_id: string };
    setup.domain.markPaymentPaid(data.payment_id, 100000, "provider-payment");
    const key = "8f3a27bc-77c6-47b1-b6d0-000000000007";
    const sessionId = randomUUID(); const capability = "x".repeat(32);
    setup.db.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, 'admin', datetime('now', '+1 hour'))").run(sessionId);
    setup.domain.createAdminReauth({ adminId: "admin", sessionId, purpose: "CANCEL_OCCURRENCE", resourceId: setup.occurrenceId, capability });
    const first = setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer illness", reauthCapability: capability }, key, "admin", sessionId);
    const replay = setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer illness", reauthCapability: capability }, key, "admin", sessionId);
    expect(first.id).toBe(replay.id);
    expect(setup.db.prepare("SELECT status FROM bookings WHERE id = ?").get(data.booking_id)).toMatchObject({ status: "CANCELLED" });
    expect(setup.db.prepare("SELECT status FROM tickets WHERE booking_id = ?").get(data.booking_id)).toMatchObject({ status: "VOID" });
    expect(setup.db.prepare("SELECT initial_source, target_refunded_amount_kopecks FROM refund_obligations WHERE payment_id = ?").get(data.payment_id)).toMatchObject({ initial_source: "OCCURRENCE_CANCELLED", target_refunded_amount_kopecks: 100000 });
    expect(setup.db.prepare("SELECT type, payload_ref FROM email_outbox WHERE type = 'OCCURRENCE_CANCELLED'").get()).toMatchObject({ type: "OCCURRENCE_CANCELLED", payload_ref: expect.any(String) });
    expect(setup.domain.cancellationFinancialOverview(setup.occurrenceId)).toMatchObject({ paid_orders: 1, captured_kopecks: 100000, refund_target_kopecks: 100000, refund_succeeded_kopecks: 0, refund_outstanding_kopecks: 100000 });
  });

  it("uses a one-time email confirmation for a pre-cutoff self-service full refund", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000014", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    expect(setup.domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""))).toEqual({ accepted: true });
    const token = setup.db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const capability = decryptTicketCapability(token.token_ciphertext, token.token_nonce);
    const firstContext = setup.domain.customerRefundConfirmationContext(capability);
    const secondContext = setup.domain.customerRefundConfirmationContext(capability);
    expect(firstContext).toMatchObject({ order_number: order.public_order_number, amount_remaining_kopecks: 100000, eligibility: "ELIGIBLE" });
    expect(secondContext).toEqual(firstContext);
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT consumed_at FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id)).toMatchObject({ consumed_at: null });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM refund_obligations WHERE payment_id = ?").get(order.payment_id)).toMatchObject({ count: 0 });
    expect(setup.domain.confirmCustomerRefund(capability)).toEqual({ confirmed: true });
    expect(() => setup.domain.confirmCustomerRefund(capability)).toThrow("REFUND_CONFIRMATION_INVALID");
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CANCELLED", cancellation_reason: "CUSTOMER_SELF_SERVICE_REFUND" });
    expect(setup.db.prepare("SELECT initial_source, target_refunded_amount_kopecks FROM refund_obligations WHERE payment_id = ?").get(order.payment_id)).toMatchObject({ initial_source: "CUSTOMER_SELF_SERVICE_REFUND", target_refunded_amount_kopecks: 100000 });
    expect(setup.db.prepare("SELECT public_order_number FROM orders WHERE id = ?").get(order.id)).toMatchObject({ public_order_number: expect.stringMatching(/^FX-[A-F0-9]{20}$/) });
  });

  it("fails closed for a customer refund request at or after the one-hour cutoff", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000015", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    setup.db.prepare("UPDATE occurrences SET starts_at = ? WHERE id = ?").run(new Date(Date.now() + 30 * 60_000).toISOString(), setup.occurrenceId);
    expect(setup.domain.requestCustomerRefund(order.public_order_number)).toEqual({ accepted: true });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id)).toMatchObject({ count: 0 });
  });

  it("rechecks the cutoff at explicit confirmation with a deterministic clock", async () => {
    const setup = fixture(); databases.push(setup.db);
    const start = Date.parse("2030-01-01T12:00:00.000Z");
    setup.db.prepare("UPDATE occurrences SET starts_at = ? WHERE id = ?").run(new Date(start).toISOString(), setup.occurrenceId);
    const beforeCutoff = new CommerceDomain(setup.db, new MockProvider(), undefined, () => start - 60 * 60_000 - 1);
    const quote = beforeCutoff.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await beforeCutoff.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000018", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    beforeCutoff.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    beforeCutoff.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    const token = setup.db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const capability = decryptTicketCapability(token.token_ciphertext, token.token_nonce);
    expect(beforeCutoff.customerRefundConfirmationContext(capability)).toMatchObject({ eligibility: "ELIGIBLE" });
    const atCutoff = new CommerceDomain(setup.db, new MockProvider(), undefined, () => start - 60 * 60_000);
    const afterCutoff = new CommerceDomain(setup.db, new MockProvider(), undefined, () => start - 60 * 60_000 + 1);
    expect(atCutoff.customerRefundConfirmationContext(capability)).toMatchObject({ eligibility: "CUTOFF_REACHED" });
    expect(afterCutoff.customerRefundConfirmationContext(capability)).toMatchObject({ eligibility: "CUTOFF_REACHED" });
    expect(() => afterCutoff.confirmCustomerRefund(capability)).toThrow("REFUND_NOT_ELIGIBLE");
  });

  it("skips a superseded queued refund confirmation email and sends only the current token", async () => {
    const setup = fixture(); databases.push(setup.db);
    const calls: string[] = [];
    const email: EmailProvider = { async lookup() { return { status: "UNKNOWN" }; }, async send(input) { if (input.template === "customer-refund-confirmation" && input.outboxId) calls.push(input.outboxId); return { jobId: `mail-${calls.length}` }; } };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000019", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    const oldToken = setup.db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const oldCapability = decryptTicketCapability(oldToken.token_ciphertext, oldToken.token_nonce);
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    expect(() => domain.customerRefundConfirmationContext(oldCapability)).toThrow("REFUND_CONFIRMATION_INVALID");
    await domain.processEmailOutbox();
    expect(calls).toHaveLength(1);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE type = 'CUSTOMER_REFUND_CONFIRMATION' ORDER BY created_at").all()).toEqual([{ status: "SKIPPED" }, { status: "ACCEPTED" }]);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM customer_refund_confirmation_tokens WHERE invalidated_at IS NOT NULL").get()).toMatchObject({ count: 1 });
  });

  it("retains an in-flight refund confirmation capability instead of creating a second usable link", async () => {
    const setup = fixture(); databases.push(setup.db);
    const domain = new CommerceDomain(setup.db, new MockProvider());
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000024", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    const token = setup.db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const capability = decryptTicketCapability(token.token_ciphertext, token.token_nonce);
    setup.db.prepare("UPDATE email_outbox SET status = 'SENDING' WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").run();
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    expect(domain.customerRefundConfirmationContext(capability)).toMatchObject({ eligibility: "ELIGIBLE" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id)).toMatchObject({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").get()).toMatchObject({ count: 1 });
  });

  it("reconciles a SEND_UNKNOWN confirmation email before considering the token obsolete", async () => {
    const setup = fixture(); databases.push(setup.db);
    const email: EmailProvider = { async lookup() { return { status: "ACCEPTED", jobId: "mail-reconciled" }; }, async send() { throw new Error("must not resend before reconciliation"); } };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000025", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    setup.db.prepare("UPDATE customer_refund_confirmation_tokens SET invalidated_at = datetime('now') WHERE order_id = ?").run(order.id);
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").run();
    await domain.processEmailOutbox();
    expect(setup.db.prepare("SELECT status, job_id FROM email_outbox WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").get()).toEqual({ status: "ACCEPTED", job_id: "mail-reconciled" });
  });

  it("cannot turn a newer SEND_UNKNOWN confirmation email into SKIPPED from a stale PENDING snapshot", async () => {
    const setup = fixture(); databases.push(setup.db);
    const domain = new CommerceDomain(setup.db, new MockProvider());
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000028", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").get() as { id: string };
    setup.db.prepare("UPDATE customer_refund_confirmation_tokens SET consumed_at = datetime('now') WHERE order_id = ?").run(order.id);
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = ?").run(outbox.id);
    const stalePendingWorker = domain as unknown as { skipObsoleteRefundConfirmationOutbox(outboxId: string): number };
    expect(stalePendingWorker.skipObsoleteRefundConfirmationOutbox(outbox.id)).toBe(0);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SEND_UNKNOWN" });
  });

  it("fully unwinds captured money when an organizer cancels a previously cancelled booking", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000020", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; order_id: string };
    setup.domain.markPaymentPaid(payment.id, 5000, "provider-payment");
    setup.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancellation_reason = 'EARLIER_CUSTOMER_CASE' WHERE order_id = ?").run(payment.order_id);
    setup.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, succeeded_at)
      VALUES (?, ?, ?, ?, 1000, 'Earlier partial refund', 'REFUND_OBLIGATION', 'SUCCEEDED', ?, ?, datetime('now'))`).run(randomUUID(), randomUUID(), payment.order_id, payment.id, randomUUID(), randomUUID());
    const sessionId = randomUUID(); const capability = "z".repeat(32);
    setup.db.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, 'admin', datetime('now', '+1 hour'))").run(sessionId);
    setup.domain.createAdminReauth({ adminId: "admin", sessionId, purpose: "CANCEL_OCCURRENCE", resourceId: setup.occurrenceId, capability });
    setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer illness", reauthCapability: capability }, "8f3a27bc-77c6-47b1-b6d0-000000000021", "admin", sessionId);
    expect(setup.db.prepare("SELECT target_refunded_amount_kopecks FROM refund_obligations WHERE payment_id = ?").get(payment.id)).toMatchObject({ target_refunded_amount_kopecks: 5000 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM refund_obligations WHERE payment_id = ?").get(payment.id)).toMatchObject({ count: 1 });
    expect(setup.domain.cancellationFinancialOverview(setup.occurrenceId)).toMatchObject({ captured_kopecks: 5000, refund_target_kopecks: 5000, refund_succeeded_kopecks: 1000, refund_outstanding_kopecks: 4000 });
    expect(setup.db.prepare("SELECT type, payload_ref FROM email_outbox WHERE type = 'OCCURRENCE_CANCELLED'").get()).toMatchObject({ type: "OCCURRENCE_CANCELLED", payload_ref: payment.order_id });
  });

  it("does not issue another obligation refund while a previous provider submission is unknown", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000026", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; order_id: string };
    setup.domain.markPaymentPaid(payment.id, 5000, "provider-payment");
    setup.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
      VALUES (?, ?, ?, ?, 1000, 'Earlier refund', 'REFUND_OBLIGATION', 'SUBMIT_UNKNOWN', ?, ?)`).run(randomUUID(), randomUUID(), payment.order_id, payment.id, randomUUID(), randomUUID());
    const sessionId = randomUUID(); const capability = "q".repeat(32);
    setup.db.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, 'admin', datetime('now', '+1 hour'))").run(sessionId);
    setup.domain.createAdminReauth({ adminId: "admin", sessionId, purpose: "CANCEL_OCCURRENCE", resourceId: setup.occurrenceId, capability });
    setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer illness", reauthCapability: capability }, "8f3a27bc-77c6-47b1-b6d0-000000000027", "admin", sessionId);
    expect(setup.domain.createObligationRefunds()).toEqual([]);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM refunds WHERE payment_id = ?").get(payment.id)).toMatchObject({ count: 1 });
    setup.db.prepare("UPDATE refunds SET status = 'SUCCEEDED', succeeded_at = datetime('now') WHERE payment_id = ?").run(payment.id);
    expect(setup.domain.createObligationRefunds()).toMatchObject([{ amount_kopecks: 4000, status: "REQUESTED" }]);
    expect(setup.db.prepare("SELECT COALESCE(SUM(amount_kopecks), 0) AS total FROM refunds WHERE payment_id = ?").get(payment.id)).toMatchObject({ total: 5000 });
  });

  it("does not mature a referral reward when the organizer cancels an occurrence", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agentId = randomUUID();
    setup.db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, 'cancelled-promoter', 'Promoter', 'Promoter Legal', 'promoter@example.test', 'SELF_EMPLOYED', '123456789012', 'C-2', 1, 'PERCENT', 1000, datetime('now'))`).run(agentId);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000022", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; order_id: string };
    setup.domain.markPaymentPaid(payment.id, 100000, "provider-payment");
    setup.db.prepare("UPDATE orders SET attributed_agent_id = ?, reward_type_snapshot = 'PERCENT', reward_value_snapshot = 1000 WHERE id = ?").run(agentId, payment.order_id);
    const sessionId = randomUUID(); const capability = "r".repeat(32);
    setup.db.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, 'admin', datetime('now', '+1 hour'))").run(sessionId);
    setup.domain.createAdminReauth({ adminId: "admin", sessionId, purpose: "CANCEL_OCCURRENCE", resourceId: setup.occurrenceId, capability });
    setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer illness", reauthCapability: capability }, "8f3a27bc-77c6-47b1-b6d0-000000000023", "admin", sessionId);
    expect(setup.domain.rewardBalance(agentId, setup.occurrenceId)).toMatchObject({ accrued_total: 0, payable_gross_total: 0, available_to_settle: 0 });
  });

  it("replays the current settlement state for an idempotent prepare", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agentId = randomUUID();
    setup.db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, 'promoter', 'Promoter', 'Promoter Legal', 'promoter@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 1, 'PERCENT', 1000, datetime('now'))`).run(agentId);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "promoter" });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000008", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(setup.occurrenceId);
    setup.db.prepare("UPDATE occurrences SET sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.completeOccurrence(setup.occurrenceId);
    const input = { agent_id: agentId, occurrence_id: setup.occurrenceId, amount_kopecks: 10000, method: "TRANSFER" };
    const key = "8f3a27bc-77c6-47b1-b6d0-000000000009";
    const first = setup.domain.prepareSettlement(input, key, "admin");
    setup.domain.markSettlementPaymentMade(String(first.id), "I confirm the money was transferred", "phase11-current-state-payment");
    const replay = setup.domain.prepareSettlement(input, key, "admin");
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("PENDING_DOCUMENT");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlements").get()).toMatchObject({ count: 1 });
  });

  it("uses the stable email idempotence key after an ambiguous send", async () => {
    const setup = fixture(); databases.push(setup.db);
    const calls: string[] = [];
    const email: EmailProvider = {
      async lookup() { return { status: "UNKNOWN" }; },
      async send(input) { calls.push(input.idempotencyKey); return { jobId: "mail-1" }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, provider_idempotence_key)
      VALUES (?, 'BOOKING_CANCELLED', 'art@example.test', 'hash', 'booking', '{}', 'SEND_UNKNOWN', 'stable-provider-key')`).run(randomUUID());
    await domain.processEmailOutbox();
    expect(calls).toEqual(["stable-provider-key"]);
    expect(setup.db.prepare("SELECT status, job_id FROM email_outbox").get()).toMatchObject({ status: "ACCEPTED", job_id: "mail-1" });
  });

  it("attributes a valid established fx_ref marker at checkout", async () => {
    const setup = fixture(); databases.push(setup.db);
    const second = promoter(setup, "second-promoter");
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: String(second.slug) });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-fxref-valid-000001", "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT attributed_agent_id FROM orders WHERE public_status_id = ?").get(result.status_id)).toMatchObject({ attributed_agent_id: second.id });
  });

  it("does not attribute a disabled established fx_ref marker", () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "disabled-established-promoter");
    setup.domain.patchAgent(String(agent.id), { enabled: false });
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "disabled-established-promoter" });
    expect(setup.db.prepare("SELECT attributed_agent_id FROM quotes WHERE id = ?").get(quote.quote_id)).toMatchObject({ attributed_agent_id: null });
  });

  it("prioritizes eligible agent promo over fx_ref while pure discount promo keeps referral attribution", async () => {
    const setup = fixture(); databases.push(setup.db);
    const referral = promoter(setup, "referral-promoter");
    const promoAgent = promoter(setup, "promo-promoter");
    setup.domain.createPromo({ agent_id: promoAgent.id, code: "PROMO", status: "ACTIVE", discount_type: "PERCENT", discount_value: 500 });
    setup.domain.createPromo({ code: "DISCOUNT", status: "ACTIVE", discount_type: "FIXED", discount_value: 1000 });
    const override = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, promoCode: "PROMO", referralSlug: "referral-promoter" });
    const pureDiscount = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, promoCode: "DISCOUNT", referralSlug: "referral-promoter" });
    const first = await setup.domain.checkoutAsync(checkoutPayload(override.quote_id), "phase11-promo-override-00001", "https://flexperiment.ru");
    const second = await setup.domain.checkoutAsync({ ...checkoutPayload(pureDiscount.quote_id), customer_email: "second@example.test" }, "phase11-pure-discount-00001", "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT attributed_agent_id FROM orders WHERE public_status_id = ?").get(first.status_id)).toMatchObject({ attributed_agent_id: promoAgent.id });
    expect(setup.db.prepare("SELECT attributed_agent_id FROM orders WHERE public_status_id = ?").get(second.status_id)).toMatchObject({ attributed_agent_id: referral.id });
  });

  it("revalidates promoter and promo eligibility at checkout without changing promo status", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "disabled-promoter");
    const promo = setup.domain.createPromo({ agent_id: agent.id, code: "AGENT", status: "ACTIVE", discount_type: "NONE", discount_value: 0 });
    const referralQuote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "disabled-promoter" });
    const promoQuote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, promoCode: "AGENT" });
    setup.domain.patchAgent(String(agent.id), { enabled: false });
    const direct = await setup.domain.checkoutAsync(checkoutPayload(referralQuote.quote_id), "phase11-disabled-referral-001", "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT attributed_agent_id FROM orders WHERE public_status_id = ?").get(direct.status_id)).toMatchObject({ attributed_agent_id: null });
    const before = setup.db.prepare("SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM payments) AS payments").get();
    await expect(setup.domain.checkoutAsync(checkoutPayload(promoQuote.quote_id), "phase11-disabled-promo-000001", "https://flexperiment.ru")).rejects.toMatchObject({ code: "PROMO_NO_LONGER_ELIGIBLE" });
    expect(setup.db.prepare("SELECT (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM bookings) AS bookings, (SELECT COUNT(*) FROM payments) AS payments").get()).toEqual(before);
    expect(setup.db.prepare("SELECT status FROM promo_codes WHERE id = ?").get(promo.id)).toMatchObject({ status: "ACTIVE" });
    setup.domain.patchAgent(String(agent.id), { enabled: true });
    expect(() => setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, promoCode: "AGENT" })).not.toThrow();
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM bookings").get()).toMatchObject({ count: 1 });
  });

  it("freezes promo and reward snapshots despite later promoter and promo edits", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "snapshot-promoter", "PERCENT", 1_000);
    setup.domain.createPromo({ agent_id: agent.id, code: "SNAP", status: "ACTIVE", discount_type: "FIXED", discount_value: 1234 });
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, promoCode: "SNAP" });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-snapshot-freeze-0001", "https://flexperiment.ru");
    setup.domain.patchAgent(String(agent.id), { default_reward_type: "FIXED", default_reward_value: 99999 });
    const promo = setup.db.prepare("SELECT id FROM promo_codes WHERE normalized_code = 'SNAP'").get() as { id: string };
    setup.domain.patchPromo(promo.id, { discount_type: "PERCENT", discount_value: 9000 });
    expect(setup.db.prepare("SELECT promo_code_snapshot, discount_type_snapshot, discount_value_snapshot, reward_type_snapshot, reward_value_snapshot FROM orders WHERE public_status_id = ?").get(result.status_id))
      .toMatchObject({ promo_code_snapshot: "SNAP", discount_type_snapshot: "FIXED", discount_value_snapshot: 1234, reward_type_snapshot: "PERCENT", reward_value_snapshot: 1000 });
  });

  it("records append-only reward adjustments for partial/full refunds and cancelled bookings", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "reward-promoter", "PERCENT", 3333);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "reward-promoter" });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-reward-adjustments-01", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider");
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId).earned_total).toBe(33330);
    await reconcileSuccessfulRefund(setup, order.id, order.payment_id, 50000);
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId).earned_total).toBe(16665);
    const booking = setup.db.prepare("SELECT id FROM bookings WHERE order_id = ?").get(order.id) as { id: string };
    setup.domain.cancelCustomerBooking(booking.id, { reason: "test cancellation", confirmation_text: `CANCEL ${booking.id}` }, "phase11-cancelled-reward-001");
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId).earned_total).toBe(0);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM referral_rewards WHERE order_id = ?").get(order.id)).toMatchObject({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_adjustments WHERE order_id = ?").get(order.id)).toMatchObject({ count: 2 });
  });

  it("caps FIXED reward by captured value and records a full-refund adjustment", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "fixed-promoter", "FIXED", 200000);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "fixed-promoter" });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-fixed-reward-cap-0001", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider");
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId).earned_total).toBe(100000);
    await reconcileSuccessfulRefund(setup, order.id, order.payment_id, 100000);
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId).earned_total).toBe(0);
    expect(setup.db.prepare("SELECT amount_kopecks, reason FROM reward_adjustments WHERE order_id = ?").get(order.id)).toMatchObject({ amount_kopecks: -100000, reason: "NET_CAPTURED_CHANGED" });
  });

  it("rounds a half-kopeck PERCENT reward upward", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "half-up-promoter", "PERCENT", 5000);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "half-up-promoter" });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-half-up-boundary-001", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 1, "provider");
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId).earned_total).toBe(1);
  });

  it("derives a balance without allocating the same matured reward twice", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "allocation-promoter", "FIXED", 10000);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "allocation-promoter" });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-allocation-balance-001", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider");
    setup.domain.patchAgent(String(agent.id), { npd_status_checked_at: new Date().toISOString() });
    setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.completeOccurrence(setup.occurrenceId);
    const initial = setup.domain.rewardBalance(String(agent.id), setup.occurrenceId);
    expect(initial).toMatchObject({ accrued_total: 10000, available_to_settle: 10000 });
    const prepared = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 6000, method: "TRANSFER" }, "phase11-allocation-settlement-1", "admin");
    const after = setup.domain.rewardBalance(String(agent.id), setup.occurrenceId);
    expect(after).toMatchObject({ prepared_total: 6000, available_to_settle: 4000 });
    expect(() => setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 4001, method: "TRANSFER" }, "phase11-allocation-settlement-2", "admin")).toThrow("SETTLEMENT_EXCEEDS_AVAILABLE");
    expect(prepared.status).toBe("PREPARED");
    await reconcileSuccessfulRefund(setup, order.id, order.payment_id, 100000);
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ payable_gross_total: 0, prepared_total: 6000, late_adjustment_exposure: 6000, available_to_settle: 0 });
  });

  it("blocks settlement availability until the contractor check is recorded, then unblocks the same matured evidence", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = promoter(setup, "contractor-review-promoter", "FIXED", 10000);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "contractor-review-promoter" });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "phase11-contractor-review-001", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100000, "provider");
    setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.completeOccurrence(setup.occurrenceId);
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ payable_gross_total: 10000, blocked_payable_total: 10000, available_to_settle: 0 });
    setup.domain.patchAgent(String(agent.id), { npd_status_checked_at: new Date().toISOString() });
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ payable_gross_total: 10000, blocked_payable_total: 0, available_to_settle: 10000 });
  });

  it("derives allocation, recovery, and late-adjustment balances across settlement states", async () => {
    const cases = [
      { prepared: 0, pending: 0, settled: 0, recovered: 0, adjustment: 0, available: 10000, exposure: 0 },
      { prepared: 3000, pending: 2000, settled: 1000, recovered: 0, adjustment: 0, available: 4000, exposure: 0 },
      { prepared: 3000, pending: 2000, settled: 1000, recovered: 2000, adjustment: -7000, available: 0, exposure: 1000 },
      { prepared: 3000, pending: 2000, settled: 1000, recovered: 2000, adjustment: 0, available: 6000, exposure: 0 },
    ];
    for (const [index, item] of cases.entries()) {
      const setup = fixture(); databases.push(setup.db);
      const agent = promoter(setup, `balance-table-${index}`, "FIXED", 10000);
      const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: String(agent.slug) });
      const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), `phase11-balance-table-${index}-00001`, "https://flexperiment.ru");
      const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
      setup.domain.markPaymentPaid(order.payment_id, 100000, "provider");
      setup.domain.patchAgent(String(agent.id), { npd_status_checked_at: new Date().toISOString() });
      setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
      setup.domain.completeOccurrence(setup.occurrenceId);
      let paidSettlementId: string | undefined;
      if (item.prepared) setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: item.prepared, method: "TRANSFER" }, `phase11-table-prepared-${index}`, "admin");
      if (item.pending) {
        const pending = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: item.pending, method: "TRANSFER" }, `phase11-table-pending-${index}`, "admin");
        setup.domain.markSettlementPaymentMade(String(pending.id), "I confirm the money was transferred", `phase11-table-pending-payment-${index}`);
        paidSettlementId = String(pending.id);
      }
      if (item.settled) {
        const settled = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: item.settled, method: "TRANSFER" }, `phase11-table-settled-${index}`, "admin");
        setup.domain.markSettlementPaymentMade(String(settled.id), "I confirm the money was transferred", `phase11-table-settled-payment-${index}`);
        setup.domain.completeSettlementDocuments(String(settled.id), { document_reference: `settlement-document-${index}` }, `phase11-table-settled-document-${index}`);
        paidSettlementId ??= String(settled.id);
      }
      if (item.recovered) {
        expect(paidSettlementId).toBeDefined();
        setup.domain.addSettlementRecovery(paidSettlementId!, { amount_recovered_kopecks: item.recovered, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: `recovery-${index}` }, `phase11-table-recovery-${index}`);
      }
      if (item.adjustment) setup.db.prepare("INSERT INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason, semantic_key) VALUES (?, ?, ?, ?, 'TEST', ?)").run(randomUUID(), order.id, agent.id, item.adjustment, `table-${index}`);
      const balance = setup.domain.rewardBalance(String(agent.id), setup.occurrenceId);
      expect(balance.available_to_settle).toBe(item.available);
      expect(balance.late_adjustment_exposure).toBe(item.exposure);
      expect(balance.available_to_settle).toBeGreaterThanOrEqual(0);
      expect(balance.available_to_settle).toBeLessThanOrEqual(Math.max(0, balance.payable_gross_total - balance.prepared_total - balance.pending_document_total - balance.settled_total + balance.externally_recovered_total));
    }
  });

  it("keeps PREPARED allocation atomic when the transaction aborts before commit", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = await maturedReward(setup, "prepared-rollback");
    setup.db.exec("CREATE TRIGGER abort_prepared AFTER INSERT ON reward_settlements BEGIN SELECT RAISE(ABORT, 'test PREPARED abort'); END");
    const input = { agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" } as const;
    expect(() => setup.domain.prepareSettlement(input, "settlement-rollback-key", "admin")).toThrow("test PREPARED abort");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlements").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlement_idempotency").get()).toEqual({ count: 0 });
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ available_to_settle: 10_000 });
  });

  it("replays one PREPARED settlement across PREPARED, PENDING_DOCUMENT, and SETTLED without another allocation", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = await maturedReward(setup, "all-state-replay");
    const input = { agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" } as const;
    const prepareKey = "settlement-all-state-prepare";
    const prepared = setup.domain.prepareSettlement(input, prepareKey, "admin");
    expect(setup.domain.prepareSettlement(input, prepareKey, "admin")).toMatchObject({ id: prepared.id, status: "PREPARED", amount_kopecks: 10_000 });
    const pending = setup.domain.markSettlementPaymentMade(String(prepared.id), "I confirm the money was transferred", "settlement-all-state-payment");
    expect(setup.domain.prepareSettlement(input, prepareKey, "admin")).toMatchObject({ id: prepared.id, status: "PENDING_DOCUMENT" });
    expect(setup.domain.markSettlementPaymentMade(String(prepared.id), "I confirm the money was transferred", "settlement-all-state-payment")).toEqual(pending);
    const settled = setup.domain.completeSettlementDocuments(String(prepared.id), { document_reference: "payment-document-1" }, "settlement-all-state-document");
    expect(setup.domain.prepareSettlement(input, prepareKey, "admin")).toMatchObject({ id: prepared.id, status: "SETTLED", amount_kopecks: 10_000 });
    expect(setup.domain.completeSettlementDocuments(String(prepared.id), { document_reference: "payment-document-1" }, "settlement-all-state-document")).toEqual(settled);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlements").get()).toEqual({ count: 1 });
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ available_to_settle: 0, settled_total: 10_000 });
  });

  it("rejects conflicting settlement command replays and illegal backward transitions", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = await maturedReward(setup, "settlement-command-conflict");
    const settlement = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" }, "settlement-command-conflict-prepare", "admin");
    setup.domain.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "settlement-command-conflict-payment");
    expect(() => setup.domain.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "different-payment-key")).toThrow("SETTLEMENT_TRANSITION_FORBIDDEN");
    setup.domain.completeSettlementDocuments(String(settlement.id), { document_reference: "document" }, "settlement-command-conflict-document");
    expect(() => setup.domain.completeSettlementDocuments(String(settlement.id), { document_reference: "different" }, "settlement-command-conflict-document")).toThrow("IDEMPOTENCY_CONFLICT");
    expect(() => setup.domain.cancelSettlementBeforePayment(String(settlement.id), { confirmation_text: `NOT PAID ${settlement.id}`, reason: "never paid" }, "settlement-command-conflict-cancel")).toThrow("SETTLEMENT_TRANSITION_FORBIDDEN");
  });

  it("prevents both full and partial contention from allocating more than the mature reward", async () => {
    const full = fixture(); databases.push(full.db);
    const fullAgent = await maturedReward(full, "settlement-full-contention");
    const fullInput = { agent_id: String(fullAgent.id), occurrence_id: full.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" } as const;
    const firstFull = full.domain.prepareSettlement(fullInput, "settlement-full-contention-a", "admin");
    expect(() => full.domain.prepareSettlement(fullInput, "settlement-full-contention-b", "admin")).toThrow("SETTLEMENT_EXCEEDS_AVAILABLE");
    expect(firstFull.status).toBe("PREPARED");

    const partial = fixture(); databases.push(partial.db);
    const partialAgent = await maturedReward(partial, "settlement-partial-contention");
    const partialInput = { agent_id: String(partialAgent.id), occurrence_id: partial.occurrenceId, amount_kopecks: 7_000, method: "TRANSFER" } as const;
    partial.domain.prepareSettlement(partialInput, "settlement-partial-contention-a", "admin");
    expect(() => partial.domain.prepareSettlement(partialInput, "settlement-partial-contention-b", "admin")).toThrow("SETTLEMENT_EXCEEDS_AVAILABLE");
    expect(partial.domain.rewardBalance(String(partialAgent.id), partial.occurrenceId)).toMatchObject({ prepared_total: 7_000, available_to_settle: 3_000 });
  });

  it("returns SETTLEMENT_BUSY for a real competing SQLite writer, then retries without over-allocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-settlement-lock-")); const filename = join(directory, "commerce.sqlite");
    const setup = fixture(filename); const competingDb = openDatabase(filename); competingDb.pragma("busy_timeout = 1");
    try {
      const agent = await maturedReward(setup, "file-backed-contention");
      const input = { agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" } as const;
      const competing = new CommerceDomain(competingDb, new MockProvider());
      setup.db.exec("BEGIN IMMEDIATE");
      try {
        let busy: unknown;
        try { competing.prepareSettlement(input, "file-backed-contention-a", "admin-b"); } catch (error) { busy = error; }
        expect(busy).toMatchObject({ code: "SETTLEMENT_BUSY", status: 409 });
      } finally { setup.db.exec("ROLLBACK"); }
      expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlements").get()).toEqual({ count: 0 });
      expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlement_idempotency").get()).toEqual({ count: 0 });
      expect(competing.prepareSettlement(input, "file-backed-contention-a", "admin-b")).toMatchObject({ status: "PREPARED", amount_kopecks: 10_000 });
      expect(() => setup.domain.prepareSettlement(input, "file-backed-contention-b", "admin-a")).toThrow("SETTLEMENT_EXCEEDS_AVAILABLE");
      expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ prepared_total: 10_000, available_to_settle: 0 });
    } finally { competingDb.close(); setup.db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("records one stale PREPARED review without releasing its allocation", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = await maturedReward(setup, "stale-prepared");
    const settlement = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" }, "stale-prepared-key", "admin");
    setup.db.prepare("UPDATE reward_settlements SET prepared_at = ? WHERE id = ?").run(new Date(Date.now() - STALE_PREPARED_SETTLEMENT_MS - 1).toISOString(), settlement.id);
    expect(setup.domain.detectStalePreparedSettlements()).toBe(1);
    expect(setup.domain.detectStalePreparedSettlements()).toBe(1);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM settlement_prepared_reviews WHERE settlement_id = ?").get(settlement.id)).toEqual({ count: 1 });
    expect(setup.domain.settlementDetail(String(settlement.id)).settlement).toMatchObject({ stale_prepared: 1, prepared_review_status: "OPEN", status: "PREPARED" });
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ prepared_total: 10_000, available_to_settle: 0 });
  });

  it("uses the frozen 30-minute stale PREPARED boundary with the domain clock", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = await maturedReward(setup, "stale-prepared-boundary");
    const settlement = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" }, "stale-prepared-boundary-prepare", "admin");
    const fixedNow = Date.parse("2030-01-01T12:00:00.000Z");
    const observer = new CommerceDomain(setup.db, new MockProvider(), undefined, () => fixedNow);
    setup.db.prepare("UPDATE reward_settlements SET prepared_at = ? WHERE id = ?").run(new Date(fixedNow - STALE_PREPARED_SETTLEMENT_MS + 1).toISOString(), settlement.id);
    expect(observer.detectStalePreparedSettlements()).toBe(0);
    expect(observer.settlementDetail(String(settlement.id)).settlement).toMatchObject({ stale_prepared: 0, prepared_review_status: null });
    setup.db.prepare("UPDATE reward_settlements SET prepared_at = ? WHERE id = ?").run(new Date(fixedNow - STALE_PREPARED_SETTLEMENT_MS).toISOString(), settlement.id);
    expect(observer.detectStalePreparedSettlements()).toBe(1);
    expect(observer.settlementDetail(String(settlement.id)).settlement).toMatchObject({ stale_prepared: 1, prepared_review_status: "OPEN" });
    setup.db.prepare("UPDATE reward_settlements SET prepared_at = ? WHERE id = ?").run(new Date(fixedNow - STALE_PREPARED_SETTLEMENT_MS - 1).toISOString(), settlement.id);
    expect(observer.detectStalePreparedSettlements()).toBe(1);
  });

  it("persists one stale PREPARED review across restart and resolves it once on an explicit transition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-stale-prepared-")); const filename = join(directory, "commerce.sqlite");
    const setup = fixture(filename);
    try {
      const agent = await maturedReward(setup, "stale-prepared-restart");
      const settlement = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" }, "stale-prepared-restart-prepare", "admin");
      setup.db.prepare("UPDATE reward_settlements SET prepared_at = ? WHERE id = ?").run(new Date(Date.now() - STALE_PREPARED_SETTLEMENT_MS - 1).toISOString(), settlement.id);
      expect(setup.domain.detectStalePreparedSettlements()).toBe(1);
      setup.db.close();
      const reopenedDb = openDatabase(filename); migrate(reopenedDb);
      try {
        const reopened = new CommerceDomain(reopenedDb, new MockProvider());
        expect(reopened.detectStalePreparedSettlements()).toBe(1);
        expect(reopenedDb.prepare("SELECT COUNT(*) AS count FROM settlement_prepared_reviews WHERE settlement_id = ?").get(settlement.id)).toEqual({ count: 1 });
        expect(reopened.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ prepared_total: 10_000, available_to_settle: 0 });
        reopened.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "stale-prepared-restart-payment");
        const review = reopenedDb.prepare("SELECT status, resolved_at FROM settlement_prepared_reviews WHERE settlement_id = ?").get(settlement.id) as { status: string; resolved_at: string };
        expect(review).toMatchObject({ status: "RESOLVED", resolved_at: expect.any(String) });
        reopened.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "stale-prepared-restart-payment");
        expect(reopenedDb.prepare("SELECT status, resolved_at FROM settlement_prepared_reviews WHERE settlement_id = ?").get(settlement.id)).toEqual(review);
      } finally { reopenedDb.close(); }
    } finally { try { setup.db.close(); } catch { /* closed for restart */ } rmSync(directory, { recursive: true, force: true }); }
  });

  it("records recovery once only for an actually paid settlement and corrects exposure", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agent = await maturedReward(setup, "paid-recovery");
    const settlement = setup.domain.prepareSettlement({ agent_id: String(agent.id), occurrence_id: setup.occurrenceId, amount_kopecks: 10_000, method: "TRANSFER" }, "paid-recovery-prepare", "admin");
    expect(() => setup.domain.addSettlementRecovery(String(settlement.id), { amount_recovered_kopecks: 1_000, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: "too-early" }, "paid-recovery-too-early")).toThrow("SETTLEMENT_RECOVERY_NOT_PAID");
    setup.domain.markSettlementPaymentMade(String(settlement.id), "I confirm the money was transferred", "paid-recovery-payment");
    setup.db.prepare("INSERT INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason, semantic_key) SELECT ?, order_id, ?, -7000, 'TEST', 'paid-recovery-reduction' FROM referral_rewards WHERE agent_id = ?").run(randomUUID(), agent.id, agent.id);
    for (const amount of [0, -1, 1.5]) expect(() => setup.domain.addSettlementRecovery(String(settlement.id), { amount_recovered_kopecks: amount, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: `invalid-${amount}` }, `paid-recovery-invalid-${amount}`)).toThrow("SETTLEMENT_RECOVERY_AMOUNT_INVALID");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM reward_settlement_command_idempotency WHERE command = 'RECOVERY'").get()).toEqual({ count: 0 });
    expect(() => setup.domain.addSettlementRecovery(String(settlement.id), { amount_recovered_kopecks: 10_001, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: "too-much" }, "paid-recovery-too-much")).toThrow("SETTLEMENT_RECOVERY_EXCEEDS_REMAINING");
    const recoveryInput = { amount_recovered_kopecks: 6_000, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: "bank-return" } as const;
    const first = setup.domain.addSettlementRecovery(String(settlement.id), recoveryInput, "paid-recovery-key");
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ externally_recovered_total: 6_000, late_adjustment_exposure: 1_000, available_to_settle: 0 });
    const second = setup.domain.addSettlementRecovery(String(settlement.id), { amount_recovered_kopecks: 4_000, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: "bank-return-rest" }, "paid-recovery-second-key");
    expect(second.amount_recovered_kopecks).toBe(4_000);
    expect(() => setup.domain.addSettlementRecovery(String(settlement.id), { amount_recovered_kopecks: 1, recovered_at: new Date().toISOString(), method: "TRANSFER", evidence_reference: "one-too-many" }, "paid-recovery-excess-key")).toThrow("SETTLEMENT_RECOVERY_EXCEEDS_REMAINING");
    const replay = setup.domain.addSettlementRecovery(String(settlement.id), recoveryInput, "paid-recovery-key");
    expect(replay).toEqual(first);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM settlement_recoveries WHERE settlement_id = ?").get(settlement.id)).toEqual({ count: 2 });
    expect(setup.db.prepare("SELECT SUM(amount_recovered_kopecks) AS amount FROM settlement_recoveries WHERE settlement_id = ?").get(settlement.id)).toEqual({ amount: 10_000 });
    expect(setup.domain.rewardBalance(String(agent.id), setup.occurrenceId)).toMatchObject({ externally_recovered_total: 10_000, late_adjustment_exposure: 0, available_to_settle: 3_000 });
  });

  it("defers only stale-review busy contention and continues the financial worker sequence", async () => {
    const calls: string[] = [];
    const busyDomain = {
      recoverStaleCommands: () => { calls.push("recover-stale"); },
      detectStalePreparedSettlements: () => { calls.push("detect"); throw new DomainError("SETTLEMENT_BUSY", 409); },
      reconcilePendingPayments: async () => { calls.push("payments"); },
      createObligationRefunds: () => { calls.push("obligations"); },
      submitRequestedRefunds: async () => { calls.push("submit-refunds"); },
      reconcilePendingRefunds: async () => { calls.push("reconcile-refunds"); },
      processEmailOutbox: async () => { calls.push("email"); },
    };
    await runWorkerSweep(busyDomain as never);
    expect(calls).toEqual(["recover-stale", "detect", "payments", "obligations", "submit-refunds", "reconcile-refunds", "email"]);

    const unexpectedDomain = { ...busyDomain, detectStalePreparedSettlements: () => { throw new Error("unexpected stale detector failure"); } };
    await expect(runWorkerSweep(unexpectedDomain as never)).rejects.toThrow("unexpected stale detector failure");
  });
});
