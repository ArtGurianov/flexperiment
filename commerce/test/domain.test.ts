import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain } from "../src/domain";
import type { EmailProvider } from "../src/email-provider";
import { MockProvider, type PaymentProvider } from "../src/provider";
import { decryptTicketCapability } from "../src/crypto";

const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };

function fixture() {
  const db = openDatabase(":memory:"); migrate(db);
  const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2026-10-01T10:00:00.000Z', '2026-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return { db, domain: new CommerceDomain(db, new MockProvider()), occurrenceId };
}

describe("commerce domain", () => {
  const databases: ReturnType<typeof fixture>["db"][] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  it("permanently binds a checkout idempotency key and reserves one seat", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
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
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
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
    expect(setup.domain.confirmCustomerRefund(capability)).toEqual({ confirmed: true });
    expect(setup.domain.confirmCustomerRefund(capability)).toEqual({ confirmed: true });
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

  it("replays the current settlement state for an idempotent prepare", async () => {
    const setup = fixture(); databases.push(setup.db);
    const agentId = randomUUID();
    setup.db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, enabled, default_reward_type, default_reward_value, npd_status_checked_at)
      VALUES (?, 'promoter', 'Promoter', 'Promoter Legal', 'promoter@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 1, 'PERCENT', 1000, datetime('now'))`).run(agentId);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Арт", customer_email: "art@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000008", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    setup.db.prepare("UPDATE orders SET attributed_agent_id = ?, reward_type_snapshot = 'PERCENT', reward_value_snapshot = 1000 WHERE id = ?").run(agentId, order.id);
    setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(setup.occurrenceId);
    setup.db.prepare("UPDATE occurrences SET sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.completeOccurrence(setup.occurrenceId);
    const input = { agent_id: agentId, occurrence_id: setup.occurrenceId, amount_kopecks: 10000, method: "TRANSFER" };
    const key = "8f3a27bc-77c6-47b1-b6d0-000000000009";
    const first = setup.domain.prepareSettlement(input, key, "admin");
    setup.domain.markSettlementPaymentMade(String(first.id), "I confirm the money was transferred");
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
});
