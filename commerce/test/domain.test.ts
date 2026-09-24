import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain, CREATE_UNKNOWN_LOOKUP_INITIAL_BACKOFF_MS, CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS, DomainError, EMAIL_SEND_UNKNOWN_MAX_ATTEMPTS, STALE_PREPARED_SETTLEMENT_MS, classifyOccurrenceRevision } from "../src/domain";
import { runWorkerSweep } from "../src/worker-sweep";
import { EventDumpCreateRejectedError, UnisenderGoProvider, type EmailDeliveryEvidenceProvider, type EmailProvider } from "../src/email-provider";
import { MockProvider, TochkaProviderError, type PaymentProvider } from "../src/provider";
import { decryptTicketCapability, emailHash, sha256 } from "../src/crypto";

const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };
const unisenderTestConfig = { apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" };

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
  return { quote_id: quoteId, customer_email: "art@example.test", customer_adult_confirmed: true as const, participant_age_band: "ADULT", offer_accepted: true as const, pd_consent_accepted: true as const };
}

const controlledRelease = (releaseId = randomUUID()) => ({
  release_id: releaseId,
  mode: "CONTROLLED_CUTOVER" as const,
  expected: {
    source_commit: "a".repeat(40), migration: "0034_worker_sweep_evidence.sql", legal_version: "2026-08-25.1", legal_manifest_sha256: "b".repeat(64),
    legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
  },
});

const promoCandidateHead = (releaseId = `promo-codes-v0:${randomUUID()}`) => ({
  release_id: releaseId, candidate_generation: 1, source_commit: "a".repeat(40),
  migration_inventory: { files: { "0035_promo_codes_v0.sql": "b".repeat(64) } },
  legal_baseline: { legal_version: "2026-08-25.1", legal_manifest_sha256: "c".repeat(64), legal_hashes: { PUBLIC_OFFER: "d".repeat(64), PRIVACY_POLICY: "e".repeat(64), PD_CONSENT: "f".repeat(64), CHECKOUT_DISCLOSURE: "1".repeat(64) } },
  release_family: "promo-codes-v0", checkout_contract_version: "promo-codes-v0", admin_contract_version: "promo-codes-v0",
  phase: "PAUSED" as const, phase_sequence: 0,
});

/**
 * A partner. It carries no reward terms: a reward is decided by the engagement
 * revision that authorises it, and the columns that once held defaults are not
 * in the baseline.
 */
function promoter(setup: ReturnType<typeof fixture>, slug: string) {
  return setup.domain.createAgent({ slug, display_name: slug, email: `${slug}@example.test` });
}

function bindSettlementLegalIdentity(setup: ReturnType<typeof fixture>, agentId: string, email: string) {
  const legalProfileId = randomUUID(); const partnerIdentityId = randomUUID();
  setup.db.prepare(`INSERT INTO agent_referrals_legal_profile_revisions(id, agent_id, revision, legal_form, tax_mode, projected_contractor_type, full_name, inn, registration_number, reason, assertion_source)
    VALUES (?, ?, 1, 'INDIVIDUAL_ENTREPRENEUR', 'OTHER', 'INDIVIDUAL_ENTREPRENEUR', 'Settlement Agent', '123456789012', '123456789012345', 'test', 'PARTNER_ASSERTED')`).run(legalProfileId, agentId);
  setup.db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, legal_profile_revision_id, created_by_admin_id)
    VALUES (?, ?, ?, 'hash', ?, 'admin')`).run(partnerIdentityId, agentId, email, legalProfileId);
}

async function maturedReward(setup: ReturnType<typeof fixture>, slug: string, amount = 10_000) {
  const agent = promoter(setup, slug);
  const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: slug });
  const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), `settlement-${slug}-checkout`, "https://flexperiment.ru");
  const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string };
  setup.domain.markPaymentPaid(payment.id, 100_000, "settlement-provider");
  bindSettlementLegalIdentity(setup, String(agent.id), `${slug}-partner@example.test`);
  setup.db.prepare("UPDATE occurrences SET ends_at = '2020-01-01T00:00:00.000Z', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
  setup.domain.completeOccurrence(setup.occurrenceId);
  return agent;
}

async function reconcileSuccessfulRefund(
  setup: ReturnType<typeof fixture>,
  orderId: string,
  paymentId: string,
  amount: number,
  source: "ADMIN_COMPENSATION" | "REFUND_OBLIGATION" = "ADMIN_COMPENSATION",
) {
  const refundId = randomUUID();
  setup.db.prepare("INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, provider_reference) VALUES (?, ?, ?, ?, ?, 'test', ?, 'RECONCILING', ?, ?, 'test-reference')")
    .run(refundId, randomUUID(), orderId, paymentId, amount, source, randomUUID(), randomUUID());
  (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: amount });
  await setup.domain.reconcileRefund(refundId);
  return refundId;
}

async function createUnknownPayment(setup: ReturnType<typeof fixture>, provider: PaymentProvider, timestamp: number) {
  const domain = new CommerceDomain(setup.db, provider, undefined, () => timestamp);
  const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
  const checkout = await domain.checkoutAsync(checkoutPayload(quote.quote_id), `create-unknown-${randomUUID()}`, "https://flexperiment.ru");
  const payment = setup.db.prepare("SELECT p.id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string; order_id: string };
  setup.db.prepare(`UPDATE payments
    SET state = 'CREATE_UNKNOWN', status = 'PENDING', provider_payment_id = NULL,
        payment_url = NULL, creation_started_at = ?, create_unknown_lookup_attempts = 0,
        create_unknown_next_lookup_at = NULL
    WHERE id = ?`).run(new Date(timestamp).toISOString(), payment.id);
  return { domain, paymentId: payment.id, orderId: payment.order_id };
}

async function tochkaWebhookCheckout(setup: ReturnType<typeof fixture>) {
  const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
  const checkout = await setup.domain.checkoutAsync(
    checkoutPayload(quote.quote_id),
    `tochka-webhook-${randomUUID()}`,
    "https://flexperiment.ru",
  );
  const payment = setup.db.prepare(`SELECT p.id FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.public_status_id = ?`).get(checkout.status_id) as { id: string };
  return {
    expected: { customerCode: "tochka-customer", merchantId: "tochka-merchant" },
    paymentId: payment.id,
    input: {
      rawHash: "tochka-webhook-payload-1",
      operationId: "tochka-webhook-operation",
      paymentLinkId: payment.id,
      amountKopecks: 100_000,
      customerCode: "tochka-customer",
      merchantId: "tochka-merchant",
      paymentType: "card",
      status: "APPROVED",
      webhookType: "acquiringInternetPayment",
      currency: "RUB",
    },
  };
}

/**
 * Under ATTEMPT authority the provider's job id lives on the attempt, not on
 * the frozen `email_outbox.job_id` column, so a test that asserts on a real
 * send must read it from there.
 */
const attemptJobId = (db: import("better-sqlite3").Database, outboxId: string): string | null =>
  (db.prepare("SELECT provider_job_id FROM outbox_attempt WHERE message_id = ? ORDER BY attempt_no DESC LIMIT 1")
    .get(outboxId) as { provider_job_id: string | null } | undefined)?.provider_job_id ?? null;

/**
 * Gives one seeded message the attempt that a real dispatch would have left.
 *
 * Fixtures that INSERT into `email_outbox` directly skip `enqueueEmail` and the
 * dispatch path, so nothing writes the attempt - and the attempt is now the
 * only holder of the provider identity and the dispatch instant that Event Dump
 * recovery selects on. One message, one attempt, one job id: a helper that
 * back-filled every message at once could hand the same provider job to two of
 * them, which is not a state the real path can produce.
 *
 * Tests that go through `processEmailOutbox()` need none of this; the code path
 * writes its own attempt.
 */
const seedAttemptForMessage = (
  db: import("better-sqlite3").Database,
  outboxId: string,
  providerJobId: string,
  dispatchAt: string,
  outcome: string | null = "ACCEPTED",
) => {
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key,
      provider_job_id, started_at, provider_request_started_at, outcome, completed_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), outboxId, `key-${outboxId}`, providerJobId, dispatchAt, dispatchAt, outcome, outcome ? dispatchAt : null);
};

describe("commerce domain", () => {
  const databases: ReturnType<typeof fixture>["db"][] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });

  it("purges a terminated occurrence notification beyond fifty older live requests", () => {
    const setup = fixture(); databases.push(setup.db);
    const cityId = setup.db.prepare("SELECT city_id FROM occurrences WHERE id = ?").get(setup.occurrenceId) as { city_id: string };
    const cancelledId = randomUUID();
    setup.db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, fulfillment_status, cancelled_at, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Cancelled', '2030-01-01T10:00:00Z', '2030-01-01T12:00:00Z', 'UTC', 100, 1, 'PUBLISHED', 'CLOSED', 'CANCELLED', datetime('now'), 'CONFIRMED', 'Studio', 'Address')`).run(cancelledId, cityId.city_id);
    const insert = setup.db.prepare(`INSERT INTO occurrence_notification_requests(id, email_normalized, email_hash, occurrence_id, privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at) VALUES (?, ?, ?, ?, 'v', ?, 'v', ?, ?, ?)`);
    for (let index = 0; index < 50; index += 1) {
      const createdAt = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
      insert.run(randomUUID(), `live-${index}@example.test`, `live-${index}`, setup.occurrenceId, "0".repeat(64), "0".repeat(64), createdAt, createdAt);
    }
    const terminatedId = randomUUID();
    insert.run(terminatedId, "terminated@example.test", "terminated", cancelledId, "0".repeat(64), "0".repeat(64), "2030-01-01T00:00:00.000Z", "2030-01-01T00:00:00.000Z");
    (setup.domain as unknown as { occurrenceNotificationsAvailable: () => boolean }).occurrenceNotificationsAvailable = () => true;
    setup.domain.processOccurrenceNotificationLifecycle();
    expect(setup.db.prepare("SELECT id FROM occurrence_notification_requests WHERE id = ?").get(terminatedId)).toBeUndefined();
  });

  it("suppresses a stale pending occurrence intent once and creates a new intent for the next availability transition", async () => {
    const setup = fixture(); databases.push(setup.db);
    const email: EmailProvider = {
      async send() { throw new Error("stale occurrence notification must not send"); },
      async lookup() { return { status: "UNKNOWN" }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    (domain as unknown as { occurrenceNotificationsAvailable: () => boolean }).occurrenceNotificationsAvailable = () => true;
    setup.db.prepare("UPDATE occurrences SET capacity = 0 WHERE id = ?").run(setup.occurrenceId);
    domain.registerOccurrenceNotification({ email: "availability@example.test", occurrence_id: setup.occurrenceId });

    setup.db.prepare("UPDATE occurrences SET capacity = 1 WHERE id = ?").run(setup.occurrenceId);
    expect(domain.processOccurrenceNotificationLifecycle()).toEqual({ deleted: 0, intents_created: 1 });
    const first = setup.db.prepare(`SELECT intent.id AS intent_id, outbox.id AS outbox_id, outbox.status
      FROM occurrence_notification_intents intent JOIN email_outbox outbox ON outbox.id = intent.outbox_id`).get() as { intent_id: string; outbox_id: string; status: string };
    expect(first.status).toBe("PENDING");

    setup.db.prepare("UPDATE occurrences SET capacity = 0 WHERE id = ?").run(setup.occurrenceId);
    await domain.processEmailOutbox();
    expect(setup.db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(first.outbox_id)).toEqual({ status: "SKIPPED", superseded_at: null });
    expect(setup.db.prepare("SELECT superseded_at FROM occurrence_notification_intents WHERE id = ?").get(first.intent_id)).toEqual({ superseded_at: expect.any(String) });

    setup.db.prepare("UPDATE occurrences SET capacity = 1 WHERE id = ?").run(setup.occurrenceId);
    expect(domain.processOccurrenceNotificationLifecycle()).toEqual({ deleted: 0, intents_created: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_notification_intents").get()).toEqual({ count: 2 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_notification_intents WHERE superseded_at IS NULL").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'OCCURRENCE_AVAILABLE'").get()).toEqual({ count: 2 });
  });

  it("reconciles SEND_UNKNOWN occurrence evidence before an eligibility loss can suppress it", async () => {
    const setup = fixture(); databases.push(setup.db);
    let lookups = 0;
    const email: EmailProvider = {
      async send() { throw new Error("SEND_UNKNOWN must reconcile before any resend"); },
      async lookup() { lookups += 1; return { status: "ACCEPTED", jobId: "already-accepted" }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    (domain as unknown as { occurrenceNotificationsAvailable: () => boolean }).occurrenceNotificationsAvailable = () => true;
    setup.db.prepare("UPDATE occurrences SET capacity = 0 WHERE id = ?").run(setup.occurrenceId);
    domain.registerOccurrenceNotification({ email: "unknown@example.test", occurrence_id: setup.occurrenceId });
    setup.db.prepare("UPDATE occurrences SET capacity = 1 WHERE id = ?").run(setup.occurrenceId);
    domain.processOccurrenceNotificationLifecycle();
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'OCCURRENCE_AVAILABLE'").get() as { id: string };
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = ?").run(outbox.id);
    setup.db.prepare("UPDATE outbox_attempt SET next_retry_at = '2000-01-01T00:00:00.000Z' WHERE message_id = ?").run(outbox.id);
    setup.db.prepare("UPDATE occurrences SET capacity = 0 WHERE id = ?").run(setup.occurrenceId);

    await domain.processEmailOutbox();

    expect(lookups).toBe(1);
    expect(setup.db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "ACCEPTED", superseded_at: null });
  });

  it("classifies normalized occurrence facts without treating every notice as a refund right", () => {
    const base = {
      title: "FLEXPERIMENT", starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T13:00:00.000Z", timezone: "Asia/Novosibirsk",
      venue_status: "TO_BE_ANNOUNCED", venue_name: null, venue_address: null, venue_disclosure_text: "Venue announced later", venue_announce_by: "2026-09-20T10:00:00.000Z",
    };
    expect(classifyOccurrenceRevision(base, { ...base, title: "New title" })).toMatchObject({ changed: true, notificationMaterial: true, refundMaterial: false });
    expect(classifyOccurrenceRevision(base, { ...base, venue_status: "CONFIRMED", venue_name: "Studio", venue_address: "Lenina 1" })).toMatchObject({ notificationMaterial: true, refundMaterial: false });
    expect(classifyOccurrenceRevision({ ...base, venue_status: "CONFIRMED", venue_name: "Studio", venue_address: "Lenina 1" }, { ...base, venue_status: "CONFIRMED", venue_name: "New Studio", venue_address: "Lenina 1" })).toMatchObject({ refundMaterial: true });
    expect(classifyOccurrenceRevision(base, { ...base, venue_announce_by: "2026-09-22T10:00:00.000Z" })).toMatchObject({ refundMaterial: true });
    expect(classifyOccurrenceRevision(base, { ...base, venue_announce_by: "2026-09-19T10:00:00.000Z" })).toMatchObject({ notificationMaterial: true, refundMaterial: false });
  });

  it("merges promo PATCHes with the stored mutable contract before enforcing promo terms", () => {
    const setup = fixture(); databases.push(setup.db);
    const promo = setup.domain.createPromo({ code: "PATCHSAFE", status: "ACTIVE", discount_type: "PERCENT", discount_value: 1000 });
    const updated = setup.domain.patchPromoCommand(String(promo.id), { discount_type: "FIXED" }, randomUUID(), "admin");
    expect(updated).toMatchObject({ discount_type: "FIXED", discount_value: 1000 });
    expect(() => setup.domain.patchPromoCommand(String(promo.id), { discount_type: "NONE" }, randomUUID(), "admin")).toThrow();
  });

  it("does not reactivate a disabled promo when PATCH omits status", () => {
    const setup = fixture(); databases.push(setup.db);
    const promo = setup.domain.createPromo({ code: "DISABLEDSAFE", status: "DISABLED", discount_type: "PERCENT", discount_value: 1000 });
    const updated = setup.domain.patchPromoCommand(String(promo.id), { discount_type: "FIXED", discount_value: 100 }, randomUUID(), "admin");
    expect(updated).toMatchObject({ status: "DISABLED", discount_type: "FIXED", discount_value: 100 });
  });

  it("can disable a legacy promo without rewriting its historical code identity", () => {
    const setup = fixture(); databases.push(setup.db);
    const promo = setup.domain.createPromo({ code: "LEGACYSAFE", status: "ACTIVE", discount_type: "FIXED", discount_value: 100 });
    setup.db.prepare("UPDATE promo_codes SET code = ?, normalized_code = ? WHERE id = ?").run("СТАРЫЙ КОД", "СТАРЫЙ КОД", promo.id);
    const updated = setup.domain.patchPromoCommand(String(promo.id), { status: "DISABLED" }, randomUUID(), "admin");
    expect(updated).toMatchObject({ code: "СТАРЫЙ КОД", normalized_code: "СТАРЫЙ КОД", status: "DISABLED" });
  });

  it("commits certification fixture facts and their command evidence atomically", () => {
    const setup = fixture(); databases.push(setup.db);
    const occurrenceId = randomUUID(); const promoId = randomUUID();
    const input = {
      occurrence: { city_id: (setup.db.prepare("SELECT city_id FROM occurrences WHERE id = ?").get(setup.occurrenceId) as { city_id: string }).city_id, title: "Certification fixture", starts_at: "2027-03-01T09:00:00.000Z", ends_at: "2027-03-01T10:00:00.000Z", timezone: "Asia/Novosibirsk", price_kopecks: 101, capacity: 1, venue_status: "CONFIRMED" as const, venue_name: "Studio", venue_address: "Street 1", audit_context: "fixture" },
      occurrence_id: occurrenceId, occurrence_key: randomUUID(), promo: { code: "CERTFIXTURE", status: "ACTIVE", discount_type: "FIXED", discount_value: 1 }, promo_id: promoId, promo_key: randomUUID(), admin_id: "admin", audit_context: "fixture",
    };
    setup.domain.createCertificationFixture(input);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrences WHERE id = ?").get(occurrenceId)).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE id = ?").get(promoId)).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id IN (?, ?)").get(occurrenceId, promoId)).toEqual({ count: 2 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_command_idempotency WHERE idempotency_key_hash IN (?, ?)").get(sha256(input.occurrence_key), sha256(input.promo_key))).toEqual({ count: 2 });

    expect(() => setup.domain.createCertificationFixture(input)).toThrow("CERTIFICATION_FIXTURE_IDEMPOTENCY_REPLAY");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrences WHERE id = ?").get(occurrenceId)).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE id = ?").get(promoId)).toEqual({ count: 1 });

    const mixedPromoId = randomUUID(); const mixedPromoKey = randomUUID();
    expect(() => setup.domain.createCertificationFixture({ ...input, promo_id: mixedPromoId, promo_key: mixedPromoKey, promo: { code: "CERTMIXEDPROMO", status: "ACTIVE", discount_type: "FIXED", discount_value: 1 } })).toThrow("CERTIFICATION_FIXTURE_IDEMPOTENCY_REPLAY");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM promo_codes WHERE id = ?").get(mixedPromoId)).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id = ?").get(mixedPromoId)).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_command_idempotency WHERE idempotency_key_hash = ?").get(sha256(mixedPromoKey))).toEqual({ count: 0 });

    const mixedOccurrenceId = randomUUID(); const mixedOccurrenceKey = randomUUID();
    expect(() => setup.domain.createCertificationFixture({ ...input, occurrence_id: mixedOccurrenceId, occurrence_key: mixedOccurrenceKey })).toThrow("CERTIFICATION_FIXTURE_IDEMPOTENCY_REPLAY");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrences WHERE id = ?").get(mixedOccurrenceId)).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id = ?").get(mixedOccurrenceId)).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_command_idempotency WHERE idempotency_key_hash = ?").get(sha256(mixedOccurrenceKey))).toEqual({ count: 0 });

    const failedOccurrenceId = randomUUID();
    const failedOccurrenceKey = randomUUID(); const failedPromoKey = randomUUID();
    expect(() => setup.domain.createCertificationFixture({ ...input, occurrence_id: failedOccurrenceId, occurrence_key: failedOccurrenceKey, promo_id: promoId, promo_key: failedPromoKey, promo: { code: "BROKEN", status: "ACTIVE", discount_type: "FIXED", discount_value: 1 } })).toThrow();
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrences WHERE id = ?").get(failedOccurrenceId)).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_audit_log WHERE entity_id = ?").get(failedOccurrenceId)).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM admin_command_idempotency WHERE idempotency_key_hash IN (?, ?)").get(sha256(failedOccurrenceKey), sha256(failedPromoKey))).toEqual({ count: 0 });
  });

  it("includes the venue-announcement deadline in a checkout quote", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare(`UPDATE occurrences
      SET venue_status = 'TO_BE_ANNOUNCED', venue_name = NULL, venue_address = NULL,
        venue_disclosure_text = 'Площадка уточняется.', venue_announce_by = '2026-09-20T10:00:00.000Z'
      WHERE id = ?`).run(setup.occurrenceId);

    expect(setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId }).venue_disclosure)
      .toMatch(/Площадка уточняется\. Сообщим адрес участникам на email не позднее 20 сентября 2026 г\. в 17:00\./);
  });

  it("emits immutable occurrence notices, supersedes stale pending notices, and grants refunds only for adverse changes", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
    const firstRevisionKey = randomUUID();
    const firstRevisionPayload = { title: "FLEXPERIMENT обновлён", reason: "Updated title", expected_revision: 1 };
    setup.domain.patchOccurrence(setup.occurrenceId, firstRevisionPayload, firstRevisionKey, "admin");
    setup.domain.patchOccurrence(setup.occurrenceId, firstRevisionPayload, firstRevisionKey, "admin");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_update_notifications").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements").get()).toEqual({ count: 0 });
    const first = setup.db.prepare("SELECT payload_snapshot FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").get() as { payload_snapshot: string };
    expect(JSON.parse(first.payload_snapshot)).toMatchObject({ before: { title: "FLEXPERIMENT" }, after: { title: "FLEXPERIMENT обновлён" } });

    setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-02T10:00:00.000Z", ends_at: "2026-10-02T13:00:00.000Z", reason: "Moved one day", expected_revision: 2 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT status, superseded_reason FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED' ORDER BY created_at LIMIT 1").get()).toEqual({ status: "SKIPPED", superseded_reason: "NEWER_OCCURRENCE_REVISION" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements WHERE status = 'OPEN'").get()).toEqual({ count: 1 });
    const beforeNoop = setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_revisions").get();
    setup.domain.patchOccurrence(setup.occurrenceId, { title: "FLEXPERIMENT обновлён", venue_public: false, reason: "No normalized change", expected_revision: 3 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_revisions").get()).toEqual(beforeNoop);
  });

  it("coalesces definitely-unsent occurrence changes and retains the durable organizer-change entitlement", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");

    setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-01T12:00:00.000Z", ends_at: "2026-10-01T15:00:00.000Z", reason: "Moved later", expected_revision: 1 }, randomUUID(), "admin");
    setup.domain.patchOccurrence(setup.occurrenceId, { title: "FLEXPERIMENT: новая редакция", reason: "Corrected title", expected_revision: 2 }, randomUUID(), "admin");

    const notices = setup.db.prepare("SELECT status, payload_snapshot FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").all() as Array<{ status: string; payload_snapshot: string }>;
    expect(notices.filter((notice) => notice.status === "SKIPPED")).toHaveLength(1);
    const replacementRow = notices.find((notice) => notice.status === "PENDING");
    expect(replacementRow).toBeDefined();
    const replacement = JSON.parse(replacementRow!.payload_snapshot) as { before: { starts_at: string }; after: { title: string }; material_changes: Array<{ field: string }>; organizer_change_full_refund_available: boolean; coalesced_unsent_revision_ids: string[] };
    expect(replacement.before.starts_at).toBe("2026-10-01T10:00:00.000Z");
    expect(replacement.after.title).toBe("FLEXPERIMENT: новая редакция");
    expect(replacement.material_changes.map((change) => change.field)).toEqual(expect.arrayContaining(["starts_at", "ends_at", "title"]));
    expect(replacement.organizer_change_full_refund_available).toBe(true);
    expect(replacement.coalesced_unsent_revision_ids).toHaveLength(1);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements WHERE status = 'OPEN'").get()).toEqual({ count: 1 });
  });

  it("recovers a corrupt pending occurrence notice from its linked immutable revision baseline", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
    setup.domain.patchOccurrence(setup.occurrenceId, { title: "First notice", reason: "First change", expected_revision: 1 }, randomUUID(), "admin");
    const corrupt = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").get() as { id: string };
    setup.db.prepare("UPDATE email_outbox SET payload_snapshot = '{not json' WHERE id = ?").run(corrupt.id);

    setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-01T12:00:00.000Z", ends_at: "2026-10-01T15:00:00.000Z", reason: "Material change", expected_revision: 2 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(corrupt.id)).toEqual({ status: "SKIPPED", superseded_at: expect.any(String) });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_update_notifications").get()).toEqual({ count: 2 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements WHERE status = 'OPEN'").get()).toEqual({ count: 1 });
    const replacement = setup.db.prepare(`SELECT payload_snapshot FROM email_outbox
      WHERE type = 'OCCURRENCE_UPDATED' AND status = 'PENDING'`).get() as { payload_snapshot: string };
    expect(JSON.parse(replacement.payload_snapshot)).toMatchObject({
      before: { title: "FLEXPERIMENT", starts_at: "2026-10-01T10:00:00.000Z" },
      after: { title: "First notice", starts_at: "2026-10-01T12:00:00.000Z" },
    });
    expect(setup.db.prepare("SELECT kind, entity_type, entity_id, status, details_json FROM operational_incidents WHERE incident_key = ?").get(`occurrence-notification-payload-corrupt:${corrupt.id}`)).toEqual({
      kind: "OCCURRENCE_NOTIFICATION_PAYLOAD_CORRUPT", entity_type: "occurrence", entity_id: setup.occurrenceId,
      status: "OPEN", details_json: expect.stringContaining('"recovered_from_occurrence_revision":true'),
    });
  });

  it("fails closed and reopens attention when both pending outbox and revision baselines are corrupt", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
    setup.domain.patchOccurrence(setup.occurrenceId, { title: "First notice", reason: "First change", expected_revision: 1 }, randomUUID(), "admin");
    const corrupt = setup.db.prepare(`SELECT outbox.id, notification.occurrence_revision_id
      FROM email_outbox outbox JOIN occurrence_update_notifications notification ON notification.outbox_id = outbox.id
      WHERE outbox.type = 'OCCURRENCE_UPDATED'`).get() as { id: string; occurrence_revision_id: string };
    setup.db.prepare("UPDATE email_outbox SET payload_snapshot = '{not json' WHERE id = ?").run(corrupt.id);
    setup.db.prepare("UPDATE occurrence_revisions SET before_json = '{not json' WHERE id = ?").run(corrupt.occurrence_revision_id);

    setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-01T12:00:00.000Z", ends_at: "2026-10-01T15:00:00.000Z", reason: "Material change", expected_revision: 2 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(corrupt.id)).toEqual({ status: "PENDING", superseded_at: null });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_update_notifications").get()).toEqual({ count: 1 });
    const incident = setup.db.prepare("SELECT id, status FROM operational_incidents WHERE incident_key = ?").get(`occurrence-notification-payload-corrupt:${corrupt.id}`) as { id: string; status: string };
    expect(incident.status).toBe("OPEN");

    setup.domain.resolveOperationalIncident(incident.id, "Reviewed without remediation");
    setup.domain.patchOccurrence(setup.occurrenceId, { title: "Later title", reason: "Follow-up", expected_revision: 3 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT status, resolution_note, resolved_at FROM operational_incidents WHERE id = ?").get(incident.id)).toEqual({
      status: "OPEN", resolution_note: null, resolved_at: null,
    });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_update_notifications").get()).toEqual({ count: 1 });
  });

  it("supersedes only definitely-unsent notices and continues to record provider delivery evidence", async () => {
    const statuses = ["SENDING", "ACCEPTED", "SEND_UNKNOWN"] as const;
    for (const status of statuses) {
      const setup = fixture(); databases.push(setup.db);
      const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
      const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
      const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
      setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
      setup.domain.patchOccurrence(setup.occurrenceId, { title: `First ${status}`, reason: "First change", expected_revision: 1 }, randomUUID(), "admin");
      const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").get() as { id: string };
      setup.db.prepare("UPDATE email_outbox SET status = ? WHERE id = ?").run(status, outbox.id);
      setup.domain.patchOccurrence(setup.occurrenceId, { title: `Second ${status}`, reason: "Second change", expected_revision: 2 }, randomUUID(), "admin");
      expect(setup.db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status, superseded_at: expect.any(String) });
      expect(setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "SENT", providerStatus: "sent", semanticKey: `sent-${status}` })).toEqual({ duplicate: false });
      expect(setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "DELIVERED", providerStatus: "delivered", semanticKey: `delivered-${status}` })).toEqual({ duplicate: false });
      expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "DELIVERED" });
    }
  });

  it("recovers an expired superseded in-flight notice as SEND_UNKNOWN without retrying it", async () => {
    const setup = fixture(); databases.push(setup.db);
    const sentOutboxIds: string[] = [];
    const email: EmailProvider = {
      async lookup() { throw new Error("superseded notice must not be reconciled by worker"); },
      async send(input) { sentOutboxIds.push(String(input.outboxId)); throw new Error("test provider unavailable"); },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    domain.markPaymentPaid(payment.id, 100_000, "paid");
    domain.patchOccurrence(setup.occurrenceId, { title: "First notice", reason: "First change", expected_revision: 1 }, randomUUID(), "admin");
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").get() as { id: string };
    setup.db.prepare("UPDATE email_outbox SET status = 'SENDING' WHERE id = ?").run(outbox.id);
    // The dispatch lease lives on the attempt under ATTEMPT authority; the
    // message's own lease columns are frozen and nothing reads them.
    setup.db.prepare("UPDATE outbox_attempt SET lease_owner = 'crashed-worker', lease_expires_at = datetime('now', '-1 second') WHERE message_id = ? AND outcome IS NULL").run(outbox.id);
    domain.patchOccurrence(setup.occurrenceId, { title: "Replacement notice", reason: "Second change", expected_revision: 2 }, randomUUID(), "admin");

    domain.recoverStaleCommands();
    expect(setup.db.prepare("SELECT status, superseded_at FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({
      status: "SEND_UNKNOWN", superseded_at: expect.any(String),
    });
    expect(setup.db.prepare("SELECT lease_owner, lease_expires_at, next_retry_at FROM outbox_attempt WHERE message_id = ?").get(outbox.id)).toEqual({
      lease_owner: null, lease_expires_at: null, next_retry_at: null,
    });
    await domain.processEmailOutbox();
    expect(sentOutboxIds).not.toContain(outbox.id);
    expect(domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "SENT", providerStatus: "sent", semanticKey: "superseded-stale-sent" })).toEqual({ duplicate: false });
    expect(domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "superseded-stale-delivered" })).toEqual({ duplicate: false });
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "DELIVERED" });
  });

  it("rolls a material revision back without orphan notification or entitlement when its effects cannot persist", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
    setup.db.exec(`CREATE TRIGGER fail_occurrence_update_before_insert
      BEFORE INSERT ON occurrence_update_notifications BEGIN SELECT RAISE(ABORT, 'TEST_NOTIFICATION_INSERT_FAILURE'); END`);
    expect(() => setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-02T10:00:00.000Z", ends_at: "2026-10-02T13:00:00.000Z", reason: "must roll back", expected_revision: 1 }, randomUUID(), "admin")).toThrow("TEST_NOTIFICATION_INSERT_FAILURE");
    expect(setup.db.prepare("SELECT starts_at, admin_revision, material_revision FROM occurrences WHERE id = ?").get(setup.occurrenceId)).toMatchObject({ starts_at: "2026-10-01T10:00:00.000Z", admin_revision: 1, material_revision: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_revisions").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_update_notifications").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements").get()).toEqual({ count: 0 });
  });

  it("uses organizer-change entitlement before start and creates manual review only after start", async () => {
    const timestamp = Date.parse("2026-08-01T00:00:00.000Z");
    const setup = fixture(); databases.push(setup.db);
    const domain = new CommerceDomain(setup.db, new MockProvider(), undefined, () => timestamp);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    domain.markPaymentPaid(payment.id, 100_000, "paid");
    domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-02T10:00:00.000Z", ends_at: "2026-10-02T13:00:00.000Z", reason: "Organizer moved event", expected_revision: 1 }, randomUUID(), "admin");
    const order = setup.db.prepare("SELECT public_order_number FROM orders").get() as { public_order_number: string };
    expect(domain.requestCustomerRefund(order.public_order_number.replaceAll("-", ""))).toEqual({ accepted: true });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").get()).toEqual({ count: 1 });
    setup.db.prepare("UPDATE occurrences SET starts_at = '2026-07-01T10:00:00.000Z', ends_at = '2026-07-01T13:00:00.000Z' WHERE id = ?").run(setup.occurrenceId);
    expect(domain.requestCustomerRefund(order.public_order_number.replaceAll("-", ""))).toEqual({ accepted: true });
    expect(setup.db.prepare("SELECT kind, entity_type FROM operational_incidents WHERE kind = 'ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW'").get()).toEqual({ kind: "ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW", entity_type: "order" });
  });

  it("routes an already-issued organizer-change confirmation to manual review after the start", async () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare("UPDATE occurrences SET starts_at = '2030-01-01T12:00:00.000Z', ends_at = '2030-01-01T15:00:00.000Z' WHERE id = ?").run(setup.occurrenceId);
    const paidDomain = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2030-01-01T11:00:00.000Z"));
    const quote = paidDomain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await paidDomain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    paidDomain.markPaymentPaid(payment.id, 100_000, "paid");
    const beforeStart = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2030-01-01T12:05:00.000Z"));
    beforeStart.patchOccurrence(setup.occurrenceId, { starts_at: "2030-01-01T12:15:00.000Z", ends_at: "2030-01-01T15:15:00.000Z", reason: "Organizer moved event", expected_revision: 1 }, randomUUID(), "admin");
    const order = setup.db.prepare("SELECT id, public_order_number FROM orders").get() as { id: string; public_order_number: string };
    beforeStart.requestCustomerRefund(order.public_order_number.replaceAll("-", ""));
    const token = setup.db.prepare("SELECT token_ciphertext, token_nonce FROM customer_refund_confirmation_tokens WHERE order_id = ?").get(order.id) as { token_ciphertext: string; token_nonce: string };
    const afterStart = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2030-01-01T12:20:00.000Z"));
    expect(afterStart.confirmCustomerRefund(decryptTicketCapability(token.token_ciphertext, token.token_nonce))).toEqual({ confirmed: false, manual_review: true, manual_contact: "art@flexperiment.ru" });
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toEqual({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM operational_incidents WHERE kind = 'ORGANIZER_CHANGE_REFUND_MANUAL_REVIEW' AND entity_id = ?").get(order.id)).toEqual({ count: 1 });
  });

  it("rejects stale Admin occurrence revisions and resolves an overdue TBA incident only after disclosure", () => {
    const setup = fixture(); databases.push(setup.db);
    const clock = Date.parse("2026-08-01T00:00:00.000Z");
    const domain = new CommerceDomain(setup.db, new MockProvider(), undefined, () => clock);
    setup.db.prepare(`UPDATE occurrences SET venue_status = 'TO_BE_ANNOUNCED', venue_name = NULL, venue_address = NULL,
      venue_disclosure_text = 'Venue later', venue_announce_by = '2026-07-01T00:00:00.000Z' WHERE id = ?`).run(setup.occurrenceId);
    expect(domain.detectOverdueVenueAnnouncements()).toBe(1);
    expect(domain.detectOverdueVenueAnnouncements()).toBe(1);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM operational_incidents WHERE kind = 'VENUE_ANNOUNCEMENT_OVERDUE'").get()).toEqual({ count: 1 });
    expect(() => domain.patchOccurrence(setup.occurrenceId, { title: "Stale", expected_revision: 0, reason: "stale" }, randomUUID(), "admin")).toThrow("OCCURRENCE_REVISION_CONFLICT");
    domain.patchOccurrence(setup.occurrenceId, { venue_status: "CONFIRMED", venue_name: "Studio", venue_address: "Lenina 1", expected_revision: 1, reason: "Venue confirmed" }, randomUUID(), "admin");
    domain.detectOverdueVenueAnnouncements();
    expect(setup.db.prepare("SELECT status FROM operational_incidents WHERE kind = 'VENUE_ANNOUNCEMENT_OVERDUE'").get()).toEqual({ status: "RESOLVED" });
  });

  it("supersedes queued updates on full refund without superseding a partial-refund participant", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const row = setup.db.prepare("SELECT p.id AS payment_id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { payment_id: string; order_id: string };
    setup.domain.markPaymentPaid(row.payment_id, 100_000, "paid");
    setup.domain.patchOccurrence(setup.occurrenceId, { title: "First update", expected_revision: 1, reason: "notify" }, randomUUID(), "admin");
    const partialId = await reconcileSuccessfulRefund(setup, row.order_id, row.payment_id, 10_000);
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(row.order_id)).toEqual({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").get()).toEqual({ status: "PENDING" });
    await reconcileSuccessfulRefund(setup, row.order_id, row.payment_id, 90_000);
    expect(partialId).toBeTruthy();
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings WHERE order_id = ?").get(row.order_id)).toEqual({ status: "CANCELLED", cancellation_reason: "FULL_REFUND" });
    expect(setup.db.prepare("SELECT status FROM tickets").get()).toEqual({ status: "VOID" });
    expect(setup.db.prepare("SELECT status, superseded_reason FROM email_outbox WHERE type = 'OCCURRENCE_UPDATED'").get()).toEqual({ status: "SKIPPED", superseded_reason: "FULL_REFUND" });
  });

  it("deduplicates refund operational attention and resolves it only on authoritative success", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id, p.order_id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string; order_id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
    const refundId = randomUUID();
    setup.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash, provider_reference)
      VALUES (?, ?, ?, ?, 100000, 'test', 'ADMIN_COMPENSATION', 'RECONCILING', ?, ?, 'reference')`).run(refundId, randomUUID(), payment.order_id, payment.id, randomUUID(), randomUUID());
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "FAILED" });
    await setup.domain.reconcileRefund(refundId);
    await setup.domain.reconcileRefund(refundId);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM operational_incidents WHERE entity_id = ? AND kind = 'REFUND_REQUIRES_REVIEW'").get(refundId)).toEqual({ count: 1 });
    expect(JSON.parse((setup.db.prepare("SELECT details_json FROM operational_incidents WHERE entity_id = ?").get(refundId) as { details_json: string }).details_json)).toMatchObject({
      refund_id: refundId, state: "FAILED", order_id: payment.order_id, amount_kopecks: 100_000, provider_reference: "reference", provider_payment_id: "paid",
    });
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: 100_000 });
    await setup.domain.reconcileRefund(refundId);
    expect(setup.db.prepare("SELECT status FROM operational_incidents WHERE entity_id = ?").get(refundId)).toEqual({ status: "RESOLVED" });
  });

  it("permanently binds a checkout idempotency key and reserves one seat", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "promoter" });
    const payload = { quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true as const, participant_age_band: "ADULT", offer_accepted: true as const, pd_consent_accepted: true as const };
    const first = await setup.domain.checkoutAsync(payload, "8f3a27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    const replay = await setup.domain.checkoutAsync(payload, "8f3a27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    expect(first.status_id).toBe(replay.status_id);
    expect(replay.payment_url).toContain("/payment/success?order=");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM bookings").get()).toMatchObject({ count: 1 });
    expect(setup.db.prepare("SELECT public_offer_version, public_offer_sha256, public_offer_accepted_at, privacy_policy_version, privacy_policy_presented_at, pd_consent_version, pd_consent_accepted_at, checkout_disclosure_version FROM orders").get()).toMatchObject({ public_offer_version: "test-1", public_offer_sha256: "0".repeat(64), privacy_policy_version: "test-1", pd_consent_version: "test-1", checkout_disclosure_version: "test-1" });
    await expect(setup.domain.checkoutAsync({ ...payload, participant_age_band: "MINOR_14_17", minor_legal_representative_confirmed: true }, "8f3a27bc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru")).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("releases a reserved seat only after provider-authoritative failure", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    provider.reconcilePayment = async () => ({ status: "FAILED" as const });
    const domain = new CommerceDomain(setup.db, provider);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000010", "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT status FROM bookings").get()).toMatchObject({ status: "RESERVED" });
    await domain.reconcilePendingPayments();
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings").get()).toMatchObject({ status: "CANCELLED", cancellation_reason: "PAYMENT_PROVIDER_FAILED" });
    expect(domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(5);
  });

  it("retains a reservation when payment creation is unknown", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    provider.createPayment = async () => { throw Object.assign(new Error("certificate details must not be stored"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }); };
    const domain = new CommerceDomain(setup.db, provider);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000011", "https://flexperiment.ru");
    await domain.reconcilePendingPayments();
    expect(setup.db.prepare("SELECT state, status, provider_error_class, provider_error_code FROM payments").get()).toEqual({
      state: "CREATE_UNKNOWN", status: "PENDING", provider_error_class: "TLS_CERT_CHAIN_UNTRUSTED", provider_error_code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    expect(setup.db.prepare("SELECT status FROM bookings").get()).toMatchObject({ status: "RESERVED" });
  });

  it("recovers one matching CREATE_UNKNOWN operation, then uses normal payment reconciliation", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-23T12:00:00.000Z");
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, timestamp);
    provider.findPaymentOperationsByLinkId = async ({ paymentLinkId }) => [{
      paymentLinkId, operationId: "tochka-operation-1", paymentLink: "https://pay.example.test/tochka-operation-1",
      amountKopecks: 100000, customerMatches: true, merchantMatches: true,
    }];
    provider.reconcilePayment = async () => ({ status: "PAID", capturedAmountKopecks: 100000 });

    await unknown.domain.reconcileCreateUnknownPayments();
    expect(setup.db.prepare("SELECT state, status, provider_payment_id, payment_url FROM payments WHERE id = ?").get(unknown.paymentId))
      .toEqual({ state: "CREATED", status: "PENDING", provider_payment_id: "tochka-operation-1", payment_url: "https://pay.example.test/tochka-operation-1" });
    await unknown.domain.reconcilePendingPayments();
    expect(setup.db.prepare("SELECT status, captured_amount_kopecks FROM payments WHERE id = ?").get(unknown.paymentId)).toEqual({ status: "PAID", captured_amount_kopecks: 100000 });
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(unknown.orderId)).toEqual({ status: "CONFIRMED" });
  });

  it("retains zero-match or unavailable CREATE_UNKNOWN payments with persisted backoff", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-23T12:00:00.000Z");
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, timestamp);
    provider.findPaymentOperationsByLinkId = async () => [];
    await unknown.domain.reconcileCreateUnknownPayments();
    expect(setup.db.prepare("SELECT state, status, create_unknown_lookup_attempts, create_unknown_next_lookup_at FROM payments WHERE id = ?").get(unknown.paymentId))
      .toEqual({ state: "CREATE_UNKNOWN", status: "PENDING", create_unknown_lookup_attempts: 1, create_unknown_next_lookup_at: new Date(timestamp + CREATE_UNKNOWN_LOOKUP_INITIAL_BACKOFF_MS).toISOString() });

    setup.db.prepare("UPDATE payments SET create_unknown_next_lookup_at = NULL WHERE id = ?").run(unknown.paymentId);
    provider.findPaymentOperationsByLinkId = async () => { throw Object.assign(new Error("provider list unavailable"), { code: "ECONNRESET" }); };
    await unknown.domain.reconcileCreateUnknownPayments();
    expect(setup.db.prepare("SELECT state, status, create_unknown_lookup_attempts, provider_error_class, provider_error_code FROM payments WHERE id = ?").get(unknown.paymentId))
      .toEqual({ state: "CREATE_UNKNOWN", status: "PENDING", create_unknown_lookup_attempts: 2, provider_error_class: "PROVIDER_NETWORK", provider_error_code: "ECONNRESET" });

    let calls = 0;
    setup.db.prepare("UPDATE payments SET create_unknown_lookup_attempts = ?, create_unknown_next_lookup_at = NULL WHERE id = ?").run(CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS, unknown.paymentId);
    provider.findPaymentOperationsByLinkId = async () => { calls += 1; return []; };
    await unknown.domain.reconcileCreateUnknownPayments();
    expect(calls).toBe(0);
  });

  it("persists the completing CREATE_UNKNOWN attempt when a lookup exhausts", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    setup.db.prepare("UPDATE payments SET create_unknown_lookup_attempts = ?, create_unknown_next_lookup_at = NULL WHERE id = ?")
      .run(CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS - 1, unknown.paymentId);
    provider.findPaymentOperationsByLinkId = async () => [];

    await unknown.domain.reconcileCreateUnknownPayments();
    expect(setup.db.prepare("SELECT state, status, create_unknown_lookup_attempts, create_unknown_next_lookup_at FROM payments WHERE id = ?").get(unknown.paymentId))
      .toEqual({ state: "CREATE_UNKNOWN", status: "REVIEW_REQUIRED", create_unknown_lookup_attempts: CREATE_UNKNOWN_LOOKUP_MAX_ATTEMPTS, create_unknown_next_lookup_at: null });
  });

  it("does not count a deterministic CREATE_UNKNOWN page-limit review as an attempted lookup", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    setup.db.prepare("UPDATE payments SET create_unknown_lookup_attempts = 3, create_unknown_next_lookup_at = NULL WHERE id = ?").run(unknown.paymentId);
    provider.findPaymentOperationsByLinkId = async () => {
      throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "PAYMENT_LIST_PAGE_LIMIT", pages_scanned: 20, page_limit: 20 }, "pagination cap reached");
    };

    await unknown.domain.reconcileCreateUnknownPayments();
    expect(setup.db.prepare("SELECT state, status, create_unknown_lookup_attempts, create_unknown_next_lookup_at FROM payments WHERE id = ?").get(unknown.paymentId))
      .toEqual({ state: "CREATE_UNKNOWN", status: "REVIEW_REQUIRED", create_unknown_lookup_attempts: 3, create_unknown_next_lookup_at: null });
  });

  it.each([
    ["multiple operations", [{ paymentLinkId: "ignored", operationId: "one", paymentLink: "https://pay/one" }, { paymentLinkId: "ignored", operationId: "two", paymentLink: "https://pay/two" }]],
    ["amount mismatch", [{ paymentLinkId: "ignored", operationId: "one", paymentLink: "https://pay/one", amountKopecks: 99999 }]],
    ["customer mismatch", [{ paymentLinkId: "ignored", operationId: "one", paymentLink: "https://pay/one", customerMatches: false }]],
    ["merchant mismatch", [{ paymentLinkId: "ignored", operationId: "one", paymentLink: "https://pay/one", merchantMatches: false }]],
  ])("fails closed into review for CREATE_UNKNOWN %s", async (_label, operations) => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    provider.findPaymentOperationsByLinkId = async () => operations.map((operation) => ({ ...operation, paymentLinkId: operation.paymentLinkId === "ignored" ? unknown.paymentId : operation.paymentLinkId }));
    await unknown.domain.reconcileCreateUnknownPayments();
    expect(setup.db.prepare("SELECT state, status, provider_payment_id FROM payments WHERE id = ?").get(unknown.paymentId))
      .toEqual({ state: "CREATE_UNKNOWN", status: "REVIEW_REQUIRED", provider_payment_id: null });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM provider_drift_reviews WHERE entity_type = 'PAYMENT' AND entity_id = ?").get(unknown.paymentId)).toEqual({ count: 1 });
  });

  it("repairs only a proven legacy CREATE_UNKNOWN absence and releases its reservation once", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    expect(unknown.domain.repairCreateUnknownPayment(unknown.orderId, unknown.paymentId)).toBe(true);
    expect(unknown.domain.repairCreateUnknownPayment(unknown.orderId, unknown.paymentId)).toBe(false);
    expect(setup.db.prepare("SELECT state, status FROM payments WHERE id = ?").get(unknown.paymentId)).toEqual({ state: "CREATE_FAILED", status: "CANCELLED" });
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings WHERE order_id = ?").get(unknown.orderId))
      .toEqual({ status: "CANCELLED", cancellation_reason: "CREATE_UNKNOWN_PROVIDER_ABSENCE_CONFIRMED" });
    expect(unknown.domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(5);
  });

  it("terminalizes a technically abandoned CREATE_UNKNOWN payment without rewriting the booking", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    unknown.domain.abandonReservation(unknown.orderId, { reason: "Interrupted certification" }, "create-unknown-abandonment-001", "admin");
    const before = setup.db.prepare("SELECT status, cancellation_reason, cancelled_at FROM bookings WHERE order_id = ?").get(unknown.orderId);

    expect(unknown.domain.repairCreateUnknownPayment(unknown.orderId, unknown.paymentId)).toBe(true);
    expect(unknown.domain.repairCreateUnknownPayment(unknown.orderId, unknown.paymentId)).toBe(false);
    expect(setup.db.prepare("SELECT state, status FROM payments WHERE id = ?").get(unknown.paymentId)).toEqual({ state: "CREATE_FAILED", status: "CANCELLED" });
    expect(setup.db.prepare("SELECT status, cancellation_reason, cancelled_at FROM bookings WHERE order_id = ?").get(unknown.orderId)).toEqual(before);
  });

  it("rejects CREATE_UNKNOWN repair for a booking cancelled for another reason", async () => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    setup.db.prepare("UPDATE bookings SET status = 'CANCELLED', cancelled_at = '2026-08-23T12:00:00.000Z', cancellation_reason = 'CUSTOMER_CANCELLED' WHERE order_id = ?").run(unknown.orderId);

    expect(unknown.domain.repairCreateUnknownPayment(unknown.orderId, unknown.paymentId)).toBe(false);
    expect(setup.db.prepare("SELECT state, status FROM payments WHERE id = ?").get(unknown.paymentId)).toEqual({ state: "CREATE_UNKNOWN", status: "PENDING" });
  });

  it.each(["provider_payment_id", "captured_amount_kopecks", "ticket", "successful_refund"] as const)("keeps CREATE_UNKNOWN repair fail-closed when %s exists", async (blocker) => {
    const setup = fixture(); databases.push(setup.db);
    const provider: PaymentProvider = new MockProvider();
    const unknown = await createUnknownPayment(setup, provider, Date.parse("2026-08-23T12:00:00.000Z"));
    if (blocker === "provider_payment_id") setup.db.prepare("UPDATE payments SET provider_payment_id = 'provider-payment' WHERE id = ?").run(unknown.paymentId);
    if (blocker === "captured_amount_kopecks") setup.db.prepare("UPDATE payments SET captured_amount_kopecks = 1 WHERE id = ?").run(unknown.paymentId);
    if (blocker === "ticket") {
      const booking = setup.db.prepare("SELECT id FROM bookings WHERE order_id = ?").get(unknown.orderId) as { id: string };
      setup.db.prepare("INSERT INTO tickets(id, booking_id, status, capability_hash, capability_ciphertext, capability_nonce, key_version) VALUES (?, ?, 'VALID', ?, 'ciphertext', 'nonce', 1)")
        .run(randomUUID(), booking.id, randomUUID());
    }
    if (blocker === "successful_refund") {
      setup.db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
        VALUES (?, ?, ?, ?, 1, 'evidence', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, ?)`)
        .run(randomUUID(), randomUUID(), unknown.orderId, unknown.paymentId, randomUUID(), randomUUID());
    }

    expect(unknown.domain.repairCreateUnknownPayment(unknown.orderId, unknown.paymentId)).toBe(false);
    expect(setup.db.prepare("SELECT state, status FROM payments WHERE id = ?").get(unknown.paymentId)).toEqual({ state: "CREATE_UNKNOWN", status: "PENDING" });
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(unknown.orderId)).toEqual({ status: "RESERVED" });
  });

  it("abandons a reservation idempotently and routes a late payment into refund review", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId, referralSlug: "promoter" });
    await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000012", "https://flexperiment.ru");
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
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000002", "https://flexperiment.ru");
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
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000004", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    const refund = setup.domain.createCompensationRefund(order.id, { amount_kopecks: 10000, reason: "Venue inconvenience" }, "8f3a27bc-77c6-47b1-b6d0-000000000005");
    expect(refund.source).toBe("ADMIN_COMPENSATION");
    setup.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = 'compensation-reference' WHERE id = ?").run(refund.id);
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: 10_000 });
    await setup.domain.reconcileRefund(String(refund.id));

    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT status FROM tickets").get()).toMatchObject({ status: "VALID" });
    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(order.payment_id)).toMatchObject({ status: "PARTIALLY_REFUNDED" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM refund_obligations WHERE payment_id = ?").get(order.payment_id)).toMatchObject({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM refunds").get()).toMatchObject({ count: 1 });
  });

  it("fulfills a customer-cancellation obligation atomically with its successful provider refund", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "obligation-refund-atomic-001", "https://flexperiment.ru");
    const row = setup.db.prepare(`SELECT b.id AS booking_id, o.id AS order_id, p.id AS payment_id
      FROM bookings b JOIN orders o ON o.id = b.order_id JOIN payments p ON p.order_id = o.id
      WHERE o.public_status_id = ?`).get(checkout.status_id) as { booking_id: string; order_id: string; payment_id: string };
    setup.domain.markPaymentPaid(row.payment_id, 100_000, "provider-payment");
    setup.domain.cancelCustomerBooking(row.booking_id, { reason: "Customer requested", confirmation_text: `CANCEL ${row.booking_id}` }, "obligation-refund-cancel-001");

    const [refund] = setup.domain.createObligationRefunds();
    expect(refund).toMatchObject({ source: "REFUND_OBLIGATION", amount_kopecks: 100_000, status: "REQUESTED" });
    setup.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = 'obligation-reference' WHERE id = ?").run(refund.id);
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: 100_000 });
    await setup.domain.reconcileRefund(String(refund.id));

    expect(setup.db.prepare("SELECT status FROM refunds WHERE id = ?").get(refund.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(row.payment_id)).toMatchObject({ status: "REFUNDED" });
    expect(setup.db.prepare("SELECT status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id)).toMatchObject({ status: "FULFILLED", fulfilled_at: expect.any(String) });
    expect(setup.domain.createObligationRefunds()).toEqual([]);

    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => { throw new Error("already-finalized refund must not reconcile again"); };
    await setup.domain.reconcileRefund(String(refund.id));
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'REFUND_SUCCEEDED' AND payload_ref = ?").get(refund.id)).toMatchObject({ count: 1 });
    expect(setup.db.prepare("SELECT status FROM refund_obligations WHERE payment_id = ?").get(row.payment_id)).toMatchObject({ status: "FULFILLED" });
  });

  it("leaves a partial obligation fulfilling until cumulative successful refunds reach its target", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "obligation-refund-cumulative-001", "https://flexperiment.ru");
    const row = setup.db.prepare(`SELECT b.id AS booking_id, o.id AS order_id, p.id AS payment_id
      FROM bookings b JOIN orders o ON o.id = b.order_id JOIN payments p ON p.order_id = o.id
      WHERE o.public_status_id = ?`).get(checkout.status_id) as { booking_id: string; order_id: string; payment_id: string };
    setup.domain.markPaymentPaid(row.payment_id, 100_000, "provider-payment");
    setup.domain.cancelCustomerBooking(row.booking_id, { reason: "Customer requested", confirmation_text: `CANCEL ${row.booking_id}` }, "obligation-refund-cancel-002");
    setup.db.prepare("UPDATE refund_obligations SET status = 'FULFILLING' WHERE payment_id = ?").run(row.payment_id);

    await reconcileSuccessfulRefund(setup, row.order_id, row.payment_id, 40_000, "REFUND_OBLIGATION");
    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(row.payment_id)).toMatchObject({ status: "PARTIALLY_REFUNDED" });
    expect(setup.db.prepare("SELECT status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id)).toMatchObject({ status: "FULFILLING", fulfilled_at: null });

    const [remainder] = setup.domain.createObligationRefunds();
    expect(remainder).toMatchObject({ source: "REFUND_OBLIGATION", amount_kopecks: 60_000, status: "REQUESTED" });
    setup.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = 'remaining-obligation-reference' WHERE id = ?").run(remainder.id);
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: 60_000 });
    await setup.domain.reconcileRefund(String(remainder.id));

    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(row.payment_id)).toMatchObject({ status: "REFUNDED" });
    expect(setup.db.prepare("SELECT status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id)).toMatchObject({ status: "FULFILLED", fulfilled_at: expect.any(String) });
  });

  it("reopens a fulfilled partial-cancellation obligation when organizer cancellation raises its target", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "obligation-target-escalation-001", "https://flexperiment.ru");
    const row = setup.db.prepare(`SELECT b.id AS booking_id, o.id AS order_id, p.id AS payment_id
      FROM bookings b JOIN orders o ON o.id = b.order_id JOIN payments p ON p.order_id = o.id
      WHERE o.public_status_id = ?`).get(checkout.status_id) as { booking_id: string; order_id: string; payment_id: string };
    setup.domain.markPaymentPaid(row.payment_id, 100_000, "provider-payment");
    setup.domain.cancelCustomerBooking(
      row.booking_id,
      { reason: "Customer requested", confirmation_text: `CANCEL ${row.booking_id}`, withheld_expense_amount_kopecks: 40_000 },
      "obligation-target-escalation-cancel",
    );
    const [partialRefund] = setup.domain.createObligationRefunds();
    expect(partialRefund).toMatchObject({ source: "REFUND_OBLIGATION", amount_kopecks: 60_000 });
    setup.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = 'partial-obligation-reference' WHERE id = ?").run(partialRefund.id);
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: 60_000 });
    await setup.domain.reconcileRefund(String(partialRefund.id));
    expect(setup.db.prepare("SELECT target_refunded_amount_kopecks, status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id))
      .toMatchObject({ target_refunded_amount_kopecks: 60_000, status: "FULFILLED", fulfilled_at: expect.any(String) });

    const sessionId = randomUUID(); const capability = "r".repeat(32);
    setup.db.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, 'admin', datetime('now', '+1 hour'))").run(sessionId);
    setup.domain.createAdminReauth({ adminId: "admin", sessionId, purpose: "CANCEL_OCCURRENCE", resourceId: setup.occurrenceId, capability });
    setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer cancellation", reauthCapability: capability }, "obligation-target-escalation-occurrence", "admin", sessionId);

    expect(setup.db.prepare("SELECT target_refunded_amount_kopecks, status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id))
      .toMatchObject({ target_refunded_amount_kopecks: 100_000, status: "OPEN", fulfilled_at: null });
    const [remainingRefund] = setup.domain.createObligationRefunds();
    expect(remainingRefund).toMatchObject({ source: "REFUND_OBLIGATION", amount_kopecks: 40_000, status: "REQUESTED" });
    setup.db.prepare("UPDATE refunds SET status = 'RECONCILING', provider_reference = 'remaining-obligation-reference' WHERE id = ?").run(remainingRefund.id);
    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => ({ status: "SUCCEEDED", refundedAmountKopecks: 40_000 });
    await setup.domain.reconcileRefund(String(remainingRefund.id));

    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(row.payment_id)).toMatchObject({ status: "REFUNDED" });
    expect(setup.db.prepare("SELECT status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id)).toMatchObject({ status: "FULFILLED", fulfilled_at: expect.any(String) });
    expect(setup.db.prepare("SELECT COALESCE(SUM(amount_kopecks), 0) AS amount FROM refunds WHERE payment_id = ? AND status = 'SUCCEEDED'").get(row.payment_id)).toMatchObject({ amount: 100_000 });
    expect(setup.domain.createObligationRefunds()).toEqual([]);
  });

  it("does not reopen an operator-owned review obligation when organizer cancellation raises its target", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "obligation-review-escalation-001", "https://flexperiment.ru");
    const row = setup.db.prepare(`SELECT b.id AS booking_id, p.id AS payment_id
      FROM bookings b JOIN orders o ON o.id = b.order_id JOIN payments p ON p.order_id = o.id
      WHERE o.public_status_id = ?`).get(checkout.status_id) as { booking_id: string; payment_id: string };
    setup.domain.markPaymentPaid(row.payment_id, 100_000, "provider-payment");
    setup.domain.cancelCustomerBooking(
      row.booking_id,
      { reason: "Customer requested", confirmation_text: `CANCEL ${row.booking_id}`, withheld_expense_amount_kopecks: 40_000 },
      "obligation-review-escalation-cancel",
    );
    setup.db.prepare("UPDATE refund_obligations SET status = 'REVIEW_REQUIRED' WHERE payment_id = ?").run(row.payment_id);

    const sessionId = randomUUID(); const capability = "s".repeat(32);
    setup.db.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, 'admin', datetime('now', '+1 hour'))").run(sessionId);
    setup.domain.createAdminReauth({ adminId: "admin", sessionId, purpose: "CANCEL_OCCURRENCE", resourceId: setup.occurrenceId, capability });
    setup.domain.cancelOccurrence(setup.occurrenceId, { reason: "Organizer cancellation", reauthCapability: capability }, "obligation-review-escalation-occurrence", "admin", sessionId);

    expect(setup.db.prepare("SELECT target_refunded_amount_kopecks, status, fulfilled_at FROM refund_obligations WHERE payment_id = ?").get(row.payment_id))
      .toMatchObject({ target_refunded_amount_kopecks: 100_000, status: "REVIEW_REQUIRED", fulfilled_at: null });
    expect(setup.domain.createObligationRefunds()).toEqual([]);
  });

  it("releases the fulfilled seat and voids its ticket after one full refund", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "full-refund-fulfilment-001", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    expect(setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(4);

    const refundId = await reconcileSuccessfulRefund(setup, order.id, order.payment_id, 100000);

    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(order.payment_id)).toMatchObject({ status: "REFUNDED" });
    expect(setup.db.prepare("SELECT status, cancellation_reason, cancelled_at FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CANCELLED", cancellation_reason: "FULL_REFUND", cancelled_at: expect.any(String) });
    expect(setup.db.prepare("SELECT status, voided_at FROM tickets WHERE booking_id = (SELECT id FROM bookings WHERE order_id = ?)").get(order.id)).toMatchObject({ status: "VOID", voided_at: expect.any(String) });
    expect(setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(5);

    (setup.domain.provider as PaymentProvider).reconcileRefund = async () => { throw new Error("already-finalized refund must not reconcile again"); };
    await setup.domain.reconcileRefund(refundId);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'REFUND_SUCCEEDED' AND payload_ref = ?").get(refundId)).toMatchObject({ count: 1 });
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CANCELLED", cancellation_reason: "FULL_REFUND" });
  });

  it("releases fulfilment only when cumulative successful refunds reach the captured total", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync(checkoutPayload(quote.quote_id), "cumulative-full-refund-001", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; payment_id: string };
    setup.domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");

    await reconcileSuccessfulRefund(setup, order.id, order.payment_id, 40000);
    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(order.payment_id)).toMatchObject({ status: "PARTIALLY_REFUNDED" });
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT status FROM tickets WHERE booking_id = (SELECT id FROM bookings WHERE order_id = ?)").get(order.id)).toMatchObject({ status: "VALID" });
    expect(setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(4);

    await reconcileSuccessfulRefund(setup, order.id, order.payment_id, 60000);
    expect(setup.db.prepare("SELECT status FROM payments WHERE id = ?").get(order.payment_id)).toMatchObject({ status: "REFUNDED" });
    expect(setup.db.prepare("SELECT status, cancellation_reason FROM bookings WHERE order_id = ?").get(order.id)).toMatchObject({ status: "CANCELLED", cancellation_reason: "FULL_REFUND" });
    expect(setup.db.prepare("SELECT status FROM tickets WHERE booking_id = (SELECT id FROM bookings WHERE order_id = ?)").get(order.id)).toMatchObject({ status: "VOID" });
    expect(setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId }).availability).toBe(5);
  });

  it("cancels an occurrence once and upserts a full refund obligation without a ticket", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000006", "https://flexperiment.ru");
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
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000014", "https://flexperiment.ru");
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
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000015", "https://flexperiment.ru");
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
    const result = await beforeCutoff.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000018", "https://flexperiment.ru");
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
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000019", "https://flexperiment.ru");
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
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000024", "https://flexperiment.ru");
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
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000025", "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT o.id, o.public_order_number, p.id AS payment_id FROM orders o JOIN payments p ON p.order_id = o.id WHERE o.public_status_id = ?").get(result.status_id) as { id: string; public_order_number: string; payment_id: string };
    domain.markPaymentPaid(order.payment_id, 100000, "provider-payment");
    domain.requestCustomerRefund(order.public_order_number.replace(/-/g, ""));
    setup.db.prepare("UPDATE customer_refund_confirmation_tokens SET invalidated_at = datetime('now') WHERE order_id = ?").run(order.id);
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").run();
    await domain.processEmailOutbox();
    const confirmation = setup.db.prepare("SELECT id, status FROM email_outbox WHERE type = 'CUSTOMER_REFUND_CONFIRMATION'").get() as { id: string; status: string };
    expect(confirmation.status).toBe("ACCEPTED");
    expect(attemptJobId(setup.db, confirmation.id)).toBe("mail-reconciled");
  });

  it("cannot turn a newer SEND_UNKNOWN confirmation email into SKIPPED from a stale PENDING snapshot", async () => {
    const setup = fixture(); databases.push(setup.db);
    const domain = new CommerceDomain(setup.db, new MockProvider());
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000028", "https://flexperiment.ru");
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
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000020", "https://flexperiment.ru");
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
    const result = await setup.domain.checkoutAsync({ quote_id: quote.quote_id, customer_email: "art@example.test", customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, "8f3a27bc-77c6-47b1-b6d0-000000000026", "https://flexperiment.ru");
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


  it("keeps delivery evidence separate from operational email acknowledgement", async () => {
    const setup = fixture(); databases.push(setup.db);
    const domain = new CommerceDomain(setup.db, new MockProvider());
    const insert = setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, sent_at, bounced_at, delivery_outcome)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', ?,
      '2026-08-23T00:00:00.000Z', '2026-08-23T00:01:00.000Z',
      CASE WHEN ? = 'FAILED' THEN 'KNOWN_FAILED' END)`);
    for (const status of ["FAILED", "BOUNCED", "SEND_UNKNOWN", "DELIVERED"]) insert.run(`attention-${status}`, status, status);

    expect(domain.emailAttentionCount()).toBe(3);
    expect(domain.emailAttentionIncidents().map((incident) => incident.status)).toEqual(["SEND_UNKNOWN", "FAILED", "BOUNCED"]);
    const before = setup.db.prepare(`SELECT status, sent_at, bounced_at, delivery_outcome
      FROM email_outbox WHERE id = 'attention-FAILED'`).get();
    const first = domain.acknowledgeEmailAttention("attention-FAILED", "Recipient was contacted through support.");
    const replay = domain.acknowledgeEmailAttention("attention-FAILED", "A different reason must not overwrite the first.");

    expect(first.acknowledged_now).toBe(true);
    expect(replay.acknowledged_now).toBe(false);
    expect(domain.emailAttentionCount()).toBe(2);
    expect(setup.db.prepare(`SELECT status, sent_at, bounced_at, delivery_outcome,
      ops_acknowledged_reason FROM email_outbox WHERE id = 'attention-FAILED'`).get())
      .toEqual({ ...(before as object), ops_acknowledged_reason: "Recipient was contacted through support." });
    expect(domain.emailAttentionIncidents().find((incident) => incident.id === "attention-FAILED"))
      .toMatchObject({ ops_acknowledged_at: expect.any(String), ops_acknowledged_reason: "Recipient was contacted through support." });
    expect(domain.acknowledgeEmailAttention("attention-BOUNCED", "   ")).toMatchObject({ acknowledged_now: true, incident: { status: "BOUNCED", ops_acknowledged_reason: null } });
    expect(domain.acknowledgeEmailAttention("attention-BOUNCED", "Hard bounce was handled outside email delivery.")).toMatchObject({ acknowledged_now: false, incident: { status: "BOUNCED", ops_acknowledged_reason: null } });
    expect(domain.emailAttentionCount()).toBe(1);
    expect(() => domain.acknowledgeEmailAttention("attention-DELIVERED", "Delivery needs no acknowledgement.")).toThrow("EMAIL_ATTENTION_NOT_ACTIONABLE");
    expect(() => domain.acknowledgeEmailAttention("missing-outbox", "No such outbox.")).toThrow("EMAIL_OUTBOX_NOT_FOUND");
  });

  it("does not send an acknowledged terminal email row", async () => {
    const setup = fixture(); databases.push(setup.db);
    let sends = 0;
    const email: EmailProvider = {
      async lookup() { throw new Error("acknowledged terminal row must not be looked up"); },
      async send() { sends += 1; return { jobId: "must-not-send" }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, ops_acknowledged_at, ops_acknowledged_reason, delivery_outcome)
      VALUES ('acknowledged-terminal', 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}',
      'FAILED', '2026-08-23T00:00:00.000Z', 'LEGACY_PROVIDER_CONFIGURATION',
      'KNOWN_FAILED')`).run();

    await domain.processEmailOutbox();

    expect(sends).toBe(0);
    expect(setup.db.prepare("SELECT status, ops_acknowledged_reason FROM email_outbox WHERE id = 'acknowledged-terminal'").get())
      .toEqual({ status: "FAILED", ops_acknowledged_reason: "LEGACY_PROVIDER_CONFIGURATION" });
  });

  it("clears only an acknowledged operational email flag for exact attention states", () => {
    const setup = fixture(); databases.push(setup.db);
    const domain = new CommerceDomain(setup.db, new MockProvider());
    const insert = setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, sent_at, delivered_at, bounced_at, suppressed_at, ops_acknowledged_at, ops_acknowledged_reason, delivery_outcome)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{"snapshot":true}', ?, '2026-08-23T00:00:00.000Z', '2026-08-23T00:01:00.000Z',
      '2026-08-23T00:02:00.000Z', NULL,
      '2026-08-23T00:03:00.000Z', 'Mistaken acknowledgement',
      CASE WHEN ? = 'FAILED' THEN 'KNOWN_FAILED' END)`);
    for (const status of ["FAILED", "BOUNCED", "SEND_UNKNOWN"]) insert.run(`unack-${status}`, status, status);
    const before = setup.db.prepare(`SELECT status, sent_at, delivered_at, bounced_at,
      suppressed_at, recipient_email, recipient_email_hash, payload_snapshot
      FROM email_outbox WHERE id = 'unack-FAILED'`).get();

    expect(domain.clearEmailOperationalAcknowledgement("unack-FAILED")).toBe(true);
    expect(domain.clearEmailOperationalAcknowledgement("unack-FAILED")).toBe(false);
    expect(domain.clearEmailOperationalAcknowledgement("unack-BOUNCED")).toBe(true);
    expect(domain.clearEmailOperationalAcknowledgement("unack-SEND_UNKNOWN")).toBe(true);
    expect(setup.db.prepare(`SELECT status, sent_at, delivered_at, bounced_at,
      suppressed_at, recipient_email, recipient_email_hash, payload_snapshot,
      ops_acknowledged_at, ops_acknowledged_reason
      FROM email_outbox WHERE id = 'unack-FAILED'`).get())
      .toEqual({ ...(before as object), ops_acknowledged_at: null, ops_acknowledged_reason: null });
    expect(domain.clearEmailOperationalAcknowledgement("missing-outbox")).toBe(false);

    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, ops_acknowledged_at, ops_acknowledged_reason)
      VALUES ('unack-delivered', 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}',
      'DELIVERED', '2026-08-23T00:03:00.000Z', 'Delivery cannot be unacknowledged.')`).run();
    expect(domain.clearEmailOperationalAcknowledgement("unack-delivered")).toBe(false);
    expect(setup.db.prepare("SELECT status, ops_acknowledged_at, ops_acknowledged_reason FROM email_outbox WHERE id = 'unack-delivered'").get())
      .toEqual({ status: "DELIVERED", ops_acknowledged_at: "2026-08-23T00:03:00.000Z", ops_acknowledged_reason: "Delivery cannot be unacknowledged." });
  });

  it("expires city-interest PII at twelve months without touching fresh rows or refreshing re-submissions", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    const firstAt = Date.parse("2026-01-31T12:00:00.000Z");
    const first = new CommerceDomain(setup.db, new MockProvider(), undefined, () => firstAt);
    first.registerCityInterest({ email: "renew@example.test", city: "novosibirsk" });
    const before = setup.db.prepare("SELECT id, consent_accepted_at, expires_at FROM city_interest_requests WHERE email_normalized = 'renew@example.test'").get() as { id: string; consent_accepted_at: string; expires_at: string };
    expect(before).toMatchObject({ consent_accepted_at: "2026-01-31T12:00:00.000Z", expires_at: "2027-01-31T12:00:00.000Z" });

    const resubmittedAt = Date.parse("2026-06-01T12:00:00.000Z");
    setup.db.prepare("UPDATE legal_releases SET manifest_json = ? WHERE active = 1").run(JSON.stringify({ documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-2", sha256: "1".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) }));
    const resubmitted = new CommerceDomain(setup.db, new MockProvider(), undefined, () => resubmittedAt);
    resubmitted.registerCityInterest({ email: "renew@example.test", city: "novosibirsk" });
    expect(setup.db.prepare("SELECT id, privacy_policy_version, pd_consent_version, consent_accepted_at, expires_at FROM city_interest_requests WHERE email_normalized = 'renew@example.test'").get()).toEqual({ id: before.id, privacy_policy_version: "test-2", pd_consent_version: "test-2", consent_accepted_at: "2026-06-01T12:00:00.000Z", expires_at: "2027-06-01T12:00:00.000Z" });

    const beforeExpiry = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2027-05-31T12:00:00.000Z"));
    expect(beforeExpiry.processCityInterestLifecycle()).toEqual({ expired_deleted: 0, intents_created: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests").get()).toEqual({ count: 1 });
    const atExpiry = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2027-06-01T12:00:00.000Z"));
    expect(atExpiry.processCityInterestLifecycle()).toEqual({ expired_deleted: 1, intents_created: 0 });
    expect(atExpiry.processCityInterestLifecycle()).toEqual({ expired_deleted: 0, intents_created: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests").get()).toEqual({ count: 0 });
  });

  it("keeps city-interest PII through intermediate provider states and completes only on DELIVERED", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-09-01T12:00:00.000Z");
    const email: EmailProvider = {
      async send() { return { jobId: "city-interest-provider-job" }; },
      async lookup() { return { status: "UNKNOWN" }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    setup.db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    domain.registerCityInterest({ email: "novosibirsk@example.test", city: "novosibirsk" });
    domain.registerCityInterest({ email: "tomsk@example.test", city: "tomsk" });

    setup.db.exec(`CREATE TRIGGER fail_city_interest_outbox BEFORE INSERT ON email_outbox
      WHEN NEW.type = 'CITY_INTEREST_AVAILABLE' BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END;`);
    expect(() => domain.patchOccurrence(setup.occurrenceId, { visibility: "PUBLISHED", reason: "Publish schedule", expected_revision: 1 }, "city-interest-publish", "admin")).toThrow("test outbox failure");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE city_slug = 'novosibirsk'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_notification_intents").get()).toEqual({ count: 0 });
    setup.db.exec("DROP TRIGGER fail_city_interest_outbox");

    domain.patchOccurrence(setup.occurrenceId, { visibility: "PUBLISHED", reason: "Publish schedule", expected_revision: 1 }, "city-interest-publish", "admin");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE city_slug = 'novosibirsk'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE city_slug = 'tomsk'").get()).toEqual({ count: 1 });
    const outbox = setup.db.prepare("SELECT id, type, recipient_email, payload_snapshot FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string; type: string; recipient_email: string; payload_snapshot: string };
    expect(outbox).toEqual({ id: expect.any(String), type: "CITY_INTEREST_AVAILABLE", recipient_email: "novosibirsk@example.test", payload_snapshot: expect.stringContaining("Новосибирск") });
    expect(setup.db.prepare("SELECT city_interest_request_id, outbox_id FROM city_interest_notification_intents").get()).toEqual({ city_interest_request_id: expect.any(String), outbox_id: outbox.id });
    expect(domain.processCityInterestLifecycle()).toEqual({ expired_deleted: 0, intents_created: 0 });
    await domain.processEmailOutbox();
    expect(setup.db.prepare("SELECT status, recipient_email, recipient_email_hash, payload_snapshot FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "ACCEPTED", recipient_email: "novosibirsk@example.test", recipient_email_hash: expect.any(String), payload_snapshot: expect.stringContaining("Новосибирск") });
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "SENT", providerStatus: "sent", semanticKey: "city-interest-sent" });
    expect(setup.db.prepare("SELECT status, recipient_email, payload_snapshot FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SENT", recipient_email: "novosibirsk@example.test", payload_snapshot: expect.stringContaining("Новосибирск") });
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "BOUNCED", providerStatus: "soft_bounced", semanticKey: "city-interest-soft-bounced" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE city_slug = 'novosibirsk'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT recipient_email FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ recipient_email: "novosibirsk@example.test" });
    expect(setup.db.prepare("SELECT provider_status FROM email_provider_events WHERE outbox_id = ? ORDER BY received_at").all(outbox.id)).toEqual(expect.arrayContaining([{ provider_status: "sent" }, { provider_status: "soft_bounced" }]));
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "city-interest-delivered" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE city_slug = 'novosibirsk'").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT status, recipient_email, recipient_email_hash, payload_snapshot FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "DELIVERED", recipient_email: "", recipient_email_hash: "", payload_snapshot: "{}" });
    expect(domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "city-interest-delivered" })).toEqual({ duplicate: true });
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "BOUNCED", providerStatus: "spam", semanticKey: "city-interest-spam" });
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "DELIVERED" });
  });

  it("atomically removes a current city-interest request on ACCEPTED then DELIVERED and ignores late SENT", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.domain.registerCityInterest({ email: "delivery-sequence@example.test", city: "novosibirsk" });
    const row = setup.db.prepare(`SELECT request.id AS request_id, outbox.id AS outbox_id
      FROM city_interest_requests request
      JOIN city_interest_notification_intents intent ON intent.city_interest_request_id = request.id
      JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE request.email_normalized = 'delivery-sequence@example.test'`).get() as { request_id: string; outbox_id: string };

    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: row.outbox_id, status: "ACCEPTED", providerStatus: "accepted", semanticKey: "delivery-sequence-accepted", jobId: "job-delivery-sequence" });
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: row.outbox_id, status: "SENT", providerStatus: "sent", semanticKey: "delivery-sequence-sent", jobId: "job-delivery-sequence" });
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: row.outbox_id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "delivery-sequence-delivered", jobId: "job-delivery-sequence" });
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: row.outbox_id, status: "SENT", providerStatus: "sent", semanticKey: "delivery-sequence-late-sent", jobId: "job-delivery-sequence" });

    expect(setup.db.prepare("SELECT id FROM city_interest_requests WHERE id = ?").get(row.request_id)).toBeUndefined();
    expect(setup.db.prepare("SELECT id FROM city_interest_notification_intents WHERE outbox_id = ?").get(row.outbox_id)).toBeUndefined();
    expect(setup.db.prepare("SELECT status, recipient_email, recipient_email_hash, payload_snapshot FROM email_outbox WHERE id = ?").get(row.outbox_id)).toEqual({
      status: "DELIVERED", recipient_email: "", recipient_email_hash: "", payload_snapshot: "{}",
    });
  });

  it("does not resend or invent a lookup for a SENT outbox with a durable job ID", async () => {
    const setup = fixture(); databases.push(setup.db);
    let sends = 0;
    let lookups = 0;
    const email: EmailProvider = {
      async send() { sends += 1; return { jobId: "sent-job" }; },
      async lookup() { lookups += 1; return { status: "UNKNOWN" }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await domain.checkoutAsync(checkoutPayload(quote.quote_id), "sent-no-resend-001", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    domain.markPaymentPaid(payment.id, 100_000, "provider-payment");
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'TICKET'").get() as { id: string };

    await domain.processEmailOutbox();
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "ACCEPTED" });
    expect(attemptJobId(setup.db, outbox.id)).toBe("sent-job");
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "SENT", providerStatus: "sent", jobId: "sent-job", semanticKey: "sent-no-resend" });
    await domain.processEmailOutbox();

    expect(sends).toBe(1);
    expect(lookups).toBe(0);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SENT" });
    expect(attemptJobId(setup.db, outbox.id)).toBe("sent-job");
  });

  it("converges a lost delivered callback from strictly correlated Event Dump evidence without resend", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T08:45:00.000Z");
    let sends = 0; let creates = 0; let polls = 0;
    let outboxId = "";
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { sends += 1; return { jobId: "1wyQ8z-000RJT-KwD8" }; },
      async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump(input) { creates += 1; expect(input.startTime).toMatch(/^2026-08-24 /); return { dumpId: "dump-production-fixture" }; },
      async getEventDump() {
        polls += 1;
        return { status: "ready", events: [
          { eventTime: "2026-08-24 08:35:01", jobId: "1wyQ8z-000RJT-KwD8", status: "accepted", deliveryStatus: "ok_accepted", metadata: { outbox_id: outboxId } },
          { eventTime: "2026-08-24 08:35:19", jobId: "1wyQ8z-000RJT-KwD8", status: "sent", deliveryStatus: "ok_sent", metadata: { outbox_id: outboxId } },
          { eventTime: "2026-08-24 08:35:20", jobId: "1wyQ8z-000RJT-KwD8", status: "delivered", deliveryStatus: "ok_delivered", destinationResponse: "250 2.0.0 Ok: queued as 4Xyz for <buyer@example.test>", metadata: { outbox_id: outboxId } },
        ] };
      },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await domain.checkoutAsync(checkoutPayload(quote.quote_id), "event-dump-production-fixture", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    domain.markPaymentPaid(payment.id, 100_000, "provider-payment");
    outboxId = (setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'TICKET'").get() as { id: string }).id;
    await domain.processEmailOutbox();
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId, status: "SENT", providerStatus: "sent", jobId: "1wyQ8z-000RJT-KwD8", semanticKey: "webhook-sent-production-fixture" });
    setup.db.prepare("UPDATE email_outbox SET created_at = ? WHERE id = ?").run(new Date(timestamp - 10 * 60_000).toISOString(), outboxId);
    // A settled attempt is immutable by design (0041), so "this was dispatched
    // ten minutes ago" is expressed by advancing the clock, not by rewriting
    // the attempt's own dispatch instant.
    timestamp += 10 * 60_000;

    await domain.reconcileUnisenderEventDumps();
    expect(creates).toBe(1); expect(polls).toBe(0);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "SENT" });
    timestamp += 61_000;
    await domain.reconcileUnisenderEventDumps();
    expect(polls).toBe(1); expect(sends).toBe(1);
    expect(setup.db.prepare("SELECT status, delivered_at FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "DELIVERED", delivered_at: expect.any(String) });
    expect(setup.db.prepare("SELECT provider_status, job_id FROM email_provider_events WHERE outbox_id = ? AND provider_status = 'delivered'").get(outboxId)).toEqual({ provider_status: "delivered", job_id: "1wyQ8z-000RJT-KwD8" });
    // The export's evidence is kept, sanitized, and marked as the export's.
    expect(setup.db.prepare(`SELECT evidence_source, delivery_status, destination_response, provider_event_time
      FROM email_provider_events WHERE outbox_id = ? AND provider_status = 'delivered'`).get(outboxId)).toEqual({
      evidence_source: "EVENT_DUMP", delivery_status: "ok_delivered", destination_response: "250 2.0.0 Ok: queued as 4Xyz for <address>", provider_event_time: "2026-08-24T08:35:20Z",
    });
    await domain.reconcileUnisenderEventDumps();
    expect(creates).toBe(1); expect(polls).toBe(1);
  });

  it("rejects uncorrelated or malformed Event Dump rows without changing SENT email state", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T08:45:00.000Z"); let outboxId = "";
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { return { jobId: "target-job" }; }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { return { dumpId: "dump-mismatch" }; },
      async getEventDump() { return { status: "ready", events: [
        { eventTime: "2026-08-24 08:35:20", jobId: "target-job", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: "other-outbox" } },
        { eventTime: "2026-08-24 08:35:21", jobId: "other-job", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: outboxId } },
        { eventTime: "", jobId: "target-job", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: outboxId } },
      ] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    const quote = domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const checkout = await domain.checkoutAsync(checkoutPayload(quote.quote_id), "event-dump-mismatch-fixture", "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(checkout.status_id) as { id: string };
    domain.markPaymentPaid(payment.id, 100_000, "provider-payment");
    outboxId = (setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'TICKET'").get() as { id: string }).id;
    await domain.processEmailOutbox();
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId, status: "SENT", providerStatus: "sent", jobId: "target-job", semanticKey: "webhook-sent-mismatch" });
    setup.db.prepare("UPDATE email_outbox SET created_at = ? WHERE id = ?").run(new Date(timestamp - 10 * 60_000).toISOString(), outboxId);
    // A settled attempt is immutable by design (0041), so "this was dispatched
    // ten minutes ago" is expressed by advancing the clock, not by rewriting
    // the attempt's own dispatch instant.
    timestamp += 10 * 60_000;
    await domain.reconcileUnisenderEventDumps();
    timestamp += 61_000;
    await domain.reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "SENT" });
    expect(setup.db.prepare(`SELECT target.state AS target_state, run.state AS run_state
      FROM unisender_event_dump_targets target JOIN unisender_event_dump_runs run ON run.id = target.run_id
      WHERE target.outbox_id = ?`).get(outboxId)).toEqual({ target_state: "RETRY_WAIT", run_state: "CONSUMED" });
  });

  it("persists a dump lease across domain restart and rate-limits new dump creation", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T08:45:00.000Z"); let creates = 0; let polls = 0;
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { creates += 1; return { dumpId: `dump-${creates}` }; },
      async getEventDump() { polls += 1; return { status: "in_process", events: [] }; },
    };
    const insert = setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, created_at) VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT', ?)`);
    const first = randomUUID(); const second = randomUUID();
    insert.run(first, new Date(timestamp - 10 * 60_000).toISOString());
    insert.run(second, new Date(timestamp - 10 * 60_000).toISOString());
    seedAttemptForMessage(setup.db, first, "job-one", new Date(timestamp - 10 * 60_000).toISOString());
    seedAttemptForMessage(setup.db, second, "job-two", new Date(timestamp - 10 * 60_000).toISOString());
    const firstWorker = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await firstWorker.reconcileUnisenderEventDumps();
    expect(creates).toBe(1);
    // A replacement worker finds the durable dump id and polls it; it does
    // not create another dump for either candidate while the global creation
    // interval remains active.
    timestamp += 61_000;
    const restartedWorker = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await restartedWorker.reconcileUnisenderEventDumps();
    expect(polls).toBe(1); expect(creates).toBe(1);
    await restartedWorker.reconcileUnisenderEventDumps();
    expect(creates).toBe(1);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM unisender_event_dump_runs WHERE state IN ('POLL_READY', 'POLL_RETRY')").get()).toEqual({ count: 1 });
  });

  it("retries a transient Event Dump poll using the same durable dump id", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let creates = 0; let polls = 0;
    const outboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, "retry-job", new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { creates += 1; return { dumpId: "same-dump" }; },
      async getEventDump() {
        polls += 1;
        if (polls === 1) throw new Error("temporary network failure");
        return { status: "ready", events: [{ eventTime: "2026-08-24 10:00:02", jobId: "retry-job", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: outboxId } }] };
      },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    timestamp += 16_000;
    await domain.reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT state, dump_id FROM unisender_event_dump_runs").get()).toEqual({ state: "POLL_RETRY", dump_id: "same-dump" });
    timestamp += 31_000;
    await domain.reconcileUnisenderEventDumps();
    expect(creates).toBe(1); expect(polls).toBe(2);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "DELIVERED" });
  });

  it("fences concurrent workers before Event Dump create dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flexperiment-event-dump-"));
    const filename = join(directory, "commerce.sqlite");
    const setup = fixture(filename);
    const secondDb = openDatabase(filename);
    try {
      const timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let creates = 0; let release: (() => void) | undefined;
      const outboxId = randomUUID();
      setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, `job-${outboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
      const email: EmailProvider & EmailDeliveryEvidenceProvider = {
        async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
        async listEventDumps() { return { count: 0 }; },
        async createEventDump() { creates += 1; await new Promise<void>((resolve) => { release = resolve; }); return { dumpId: "concurrent-dump" }; },
        async getEventDump() { return { status: "queued", events: [] }; },
      };
      const first = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
      const second = new CommerceDomain(secondDb, new MockProvider(), email, () => timestamp);
      const firstSweep = first.reconcileUnisenderEventDumps();
      await new Promise((resolve) => setImmediate(resolve));
      await second.reconcileUnisenderEventDumps();
      expect(creates).toBe(1);
      release?.(); await firstSweep;
      expect(setup.db.prepare("SELECT COUNT(*) AS count FROM unisender_event_dump_create_attempts").get()).toEqual({ count: 1 });
    } finally {
      secondDb.close(); setup.db.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed after an ambiguous Event Dump create response without changing email or issuing another create", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let creates = 0;
    const outboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, `job-${outboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { creates += 1; throw new Error("response lost"); }, async getEventDump() { return { status: "queued", events: [] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    await domain.reconcileUnisenderEventDumps();
    expect(creates).toBe(1);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "SENT" });
    expect(setup.db.prepare("SELECT state, last_error_code FROM unisender_event_dump_runs").get()).toEqual({ state: "CREATE_UNKNOWN", last_error_code: "CREATE_RESPONSE_UNKNOWN" });
  });

  it("uses provider Event Dump inventory as the authoritative capacity guard", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let creates = 0; let lists = 0;
    const outboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, `job-${outboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { lists += 1; return { count: 9 }; },
      async createEventDump() { creates += 1; return { dumpId: "must-not-create" }; },
      async getEventDump() { return { status: "queued", events: [] }; },
    };
    await new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp).reconcileUnisenderEventDumps();
    expect(lists).toBe(1); expect(creates).toBe(0);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "SENT" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM unisender_event_dump_runs").get()).toEqual({ count: 0 });
  });

  it("durably backs off Event Dump inventory probes while provider capacity remains unavailable", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let lists = 0; let creates = 0; let capacity = 9;
    const backoffOutboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(backoffOutboxId);
    seedAttemptForMessage(setup.db, backoffOutboxId, `job-${backoffOutboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { lists += 1; return { count: capacity }; },
      async createEventDump() { creates += 1; return { dumpId: "after-capacity" }; },
      async getEventDump() { return { status: "queued", events: [] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    await domain.reconcileUnisenderEventDumps();
    expect(lists).toBe(1); expect(creates).toBe(0);
    expect(setup.db.prepare("SELECT create_probe_failures, last_create_probe_error FROM unisender_event_dump_control").get())
      .toEqual({ create_probe_failures: 1, last_create_probe_error: "PROVIDER_DUMP_CAPACITY" });
    timestamp += 5 * 60_000;
    capacity = 0;
    await domain.reconcileUnisenderEventDumps();
    expect(lists).toBe(2); expect(creates).toBe(1);
  });

  it("uses bounded durable backoff when Event Dump inventory is unavailable", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let lists = 0;
    const backoffOutboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(backoffOutboxId);
    seedAttemptForMessage(setup.db, backoffOutboxId, `job-${backoffOutboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { lists += 1; throw new Error("timeout"); },
      async createEventDump() { throw new Error("must not create"); },
      async getEventDump() { return { status: "queued", events: [] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    await domain.reconcileUnisenderEventDumps();
    expect(lists).toBe(1);
    timestamp += 5 * 60_000;
    await domain.reconcileUnisenderEventDumps();
    expect(lists).toBe(2);
    expect(setup.db.prepare("SELECT create_probe_failures, last_create_probe_error FROM unisender_event_dump_control").get())
      .toEqual({ create_probe_failures: 2, last_create_probe_error: "LIST_UNAVAILABLE" });
  });

  it("honors the local create fence before making another provider inventory request", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let lists = 0; let creates = 0;
    const backoffOutboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(backoffOutboxId);
    seedAttemptForMessage(setup.db, backoffOutboxId, `job-${backoffOutboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const insertAttempt = setup.db.prepare("INSERT INTO unisender_event_dump_create_attempts(id, started_at) VALUES (?, ?)");
    for (let index = 0; index < 9; index += 1) insertAttempt.run(randomUUID(), new Date(timestamp - 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { lists += 1; return { count: 0 }; },
      async createEventDump() { creates += 1; return { dumpId: "after-local-cap" }; },
      async getEventDump() { return { status: "queued", events: [] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    await domain.reconcileUnisenderEventDumps();
    expect(lists).toBe(0);
    timestamp += 8 * 60 * 60_000 + 1;
    await domain.reconcileUnisenderEventDumps();
    expect(lists).toBe(1); expect(creates).toBe(1);
  });

  it("defers targets after explicit Event Dump rejection without treating it as CREATE_UNKNOWN", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let creates = 0;
    const outboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, `job-${outboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { creates += 1; throw new EventDumpCreateRejectedError(400); },
      async getEventDump() { return { status: "queued", events: [] }; },
    };
    await new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp).reconcileUnisenderEventDumps();
    expect(creates).toBe(1);
    expect(setup.db.prepare("SELECT state, last_error_code FROM unisender_event_dump_runs").get())
      .toEqual({ state: "EXHAUSTED", last_error_code: "CREATE_REJECTED_HTTP_400" });
    expect(setup.db.prepare("SELECT state FROM unisender_event_dump_targets WHERE outbox_id = ?").get(outboxId)).toEqual({ state: "RETRY_WAIT" });
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "SENT" });
  });

  it("safely defers targets when the provider rejects create at its dump limit", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-24T10:00:00.000Z");
    const outboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, `job-${outboxId}`, new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 8 }; },
      async createEventDump() { throw new EventDumpCreateRejectedError(429); },
      async getEventDump() { return { status: "queued", events: [] }; },
    };
    await new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp).reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT state, last_error_code FROM unisender_event_dump_runs").get())
      .toEqual({ state: "EXHAUSTED", last_error_code: "CREATE_REJECTED_HTTP_429" });
    expect(setup.db.prepare("SELECT state, next_attempt_at FROM unisender_event_dump_targets WHERE outbox_id = ?").get(outboxId))
      .toEqual({ state: "RETRY_WAIT", next_attempt_at: expect.any(String) });
  });

  it("does not starve an eleventh candidate behind ten deferred historical targets", async () => {
    const setup = fixture(); databases.push(setup.db);
    const timestamp = Date.parse("2026-08-24T10:00:00.000Z");
    const insert = setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`);
    const oldRun = randomUUID();
    setup.db.prepare(`INSERT INTO unisender_event_dump_runs(id, state, start_time, end_time, create_started_at, next_attempt_at)
      VALUES (?, 'CONSUMED', '2026-08-24 09:00:00', '2026-08-24 10:00:00', ?, ?)`)
      .run(oldRun, new Date(timestamp - 20 * 60_000).toISOString(), new Date(timestamp).toISOString());
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const outboxId = randomUUID(); ids.push(outboxId);
      insert.run(outboxId);
      seedAttemptForMessage(setup.db, outboxId, `job-${index}`, new Date(timestamp - 10 * 60_000).toISOString());
      if (index < 10) setup.db.prepare(`INSERT INTO unisender_event_dump_targets(id, run_id, outbox_id, job_id, state, next_attempt_at)
        VALUES (?, ?, ?, ?, 'RETRY_WAIT', ?)`)
        .run(randomUUID(), oldRun, outboxId, `job-${index}`, new Date(timestamp + 60 * 60_000).toISOString());
    }
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { return { dumpId: "starvation-dump" }; }, async getEventDump() { return { status: "queued", events: [] }; },
    };
    await new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp).reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT outbox_id FROM unisender_event_dump_targets WHERE state = 'ACTIVE'").get()).toEqual({ outbox_id: ids[10] });
  });

  it("batches independent eligible outboxes and waits for grace from provider dispatch, not creation", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T10:00:00.000Z"); let creates = 0;
    const insert = setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, created_at)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT', ?)`);
    const fresh = randomUUID(); const first = randomUUID(); const second = randomUUID();
    insert.run(fresh, new Date(timestamp - 60 * 60_000).toISOString());
    insert.run(first, new Date(timestamp - 60 * 60_000).toISOString());
    insert.run(second, new Date(timestamp - 60 * 60_000).toISOString());
    seedAttemptForMessage(setup.db, first, "batch-one", new Date(timestamp - 10 * 60_000).toISOString());
    seedAttemptForMessage(setup.db, second, "batch-two", new Date(timestamp - 10 * 60_000).toISOString());
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { creates += 1; return { dumpId: "batch-dump" }; },
      async getEventDump() { return { status: "ready", events: [
        { eventTime: "2026-08-24 10:00:01", jobId: "batch-one", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: first } },
        { eventTime: "2026-08-24 10:00:02", jobId: "batch-two", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: second } },
      ] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    expect(creates).toBe(1);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM unisender_event_dump_targets WHERE state = 'ACTIVE'").get()).toEqual({ count: 2 });
    timestamp += 16_000;
    await domain.reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id IN (?, ?) ORDER BY id").all(first, second)).toEqual([{ status: "DELIVERED" }, { status: "DELIVERED" }]);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(fresh)).toEqual({ status: "SENT" });
  });

  it("uses raw Event Dump rows, not parsed evidence rows, to narrow a saturated batch", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T10:00:00.000Z");
    const outboxId = randomUUID();
    setup.db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
      VALUES (?, 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}', 'SENT')`)
      .run(outboxId);
    seedAttemptForMessage(setup.db, outboxId, "tail-target-job", new Date(timestamp - 10 * 60_000).toISOString());
    const unrelated = Array.from({ length: 2 }, (_, index) => ({
      eventTime: `2026-08-24 09:${String(index % 60).padStart(2, "0")}:00`, jobId: `other-${index}`, status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: randomUUID() },
    }));
    const createInputs: Array<{ jobId?: string }> = []; let polls = 0;
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { throw new Error("must not resend"); }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump(input) { createInputs.push({ jobId: input.jobId }); return { dumpId: `dump-${createInputs.length}` }; },
      async getEventDump() {
        polls += 1;
        return polls === 1
          // The provider returned its configured 100k rows, but only these two
          // survived strict local evidence parsing. The target was after cutoff.
          ? { status: "ready", returnedEventCount: 100_000, events: unrelated }
          : { status: "ready", returnedEventCount: 1, events: [{ eventTime: "2026-08-24 10:00:01", jobId: "tail-target-job", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: outboxId } }] };
      },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    await domain.reconcileUnisenderEventDumps();
    timestamp += 16_000;
    await domain.reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT state, recovery_mode FROM unisender_event_dump_targets WHERE outbox_id = ?").get(outboxId))
      .toEqual({ state: "RETRY_WAIT", recovery_mode: "TARGETED_JOB" });
    timestamp += 5 * 60_000;
    await domain.reconcileUnisenderEventDumps();
    timestamp += 16_000;
    await domain.reconcileUnisenderEventDumps();
    expect(createInputs).toEqual([{ jobId: undefined }, { jobId: "tail-target-job" }]);
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "DELIVERED" });
  });

  it("uses Event Dump delivery through the existing city-interest cleanup transition", async () => {
    const setup = fixture(); databases.push(setup.db);
    let timestamp = Date.parse("2026-08-24T08:45:00.000Z"); let outboxId = "";
    const email: EmailProvider & EmailDeliveryEvidenceProvider = {
      async send() { return { jobId: "city-dump-job" }; }, async lookup() { return { status: "UNKNOWN" }; },
      async listEventDumps() { return { count: 0 }; },
      async createEventDump() { return { dumpId: "city-dump" }; },
      async getEventDump() { return { status: "ready", events: [{ eventTime: "2026-08-24 08:35:20", jobId: "city-dump-job", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: outboxId } }] }; },
    };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email, () => timestamp);
    setup.db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    domain.registerCityInterest({ email: "dump-city@example.test", city: "novosibirsk" });
    domain.patchOccurrence(setup.occurrenceId, { visibility: "PUBLISHED", reason: "Publish", expected_revision: 1 }, "event-dump-city-interest", "admin");
    const row = setup.db.prepare("SELECT id, payload_ref FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string; payload_ref: string };
    outboxId = row.id;
    await domain.processEmailOutbox();
    domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId, status: "SENT", providerStatus: "sent", jobId: "city-dump-job", semanticKey: "city-dump-sent" });
    setup.db.prepare("UPDATE email_outbox SET created_at = ? WHERE id = ?").run(new Date(timestamp - 10 * 60_000).toISOString(), outboxId);
    // A settled attempt is immutable by design (0041), so "this was dispatched
    // ten minutes ago" is expressed by advancing the clock, not by rewriting
    // the attempt's own dispatch instant.
    timestamp += 10 * 60_000;
    await domain.reconcileUnisenderEventDumps();
    timestamp += 61_000;
    await domain.reconcileUnisenderEventDumps();
    expect(setup.db.prepare("SELECT id FROM city_interest_requests WHERE id = ?").get(row.payload_ref.replace("city-interest:", ""))).toBeUndefined();
    expect(setup.db.prepare("SELECT status, recipient_email, payload_snapshot FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "DELIVERED", recipient_email: "", payload_snapshot: "{}" });
  });

  it("retains city-interest PII for hard bounces and generic FAILED observations", async () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.registerCityInterest({ email: "hard-bounce@example.test", city: "novosibirsk" });
    setup.domain.patchOccurrence(setup.occurrenceId, { visibility: "PUBLISHED", reason: "Publish schedule", expected_revision: 1 }, "hard-bounce-publish", "admin");
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string };
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "BOUNCED", providerStatus: "hard_bounced", semanticKey: "city-interest-hard-bounced" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_normalized = 'hard-bounce@example.test'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT recipient_email FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ recipient_email: "hard-bounce@example.test" });

    // A SEND_UNKNOWN message is one whose current attempt is unsettled - the
    // first attempt above was settled by the bounce, so model the ambiguous
    // send as the next attempt rather than by flipping the message column alone.
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = ?").run(outbox.id);
    setup.db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, started_at, provider_request_started_at, send_try_count)
      SELECT lower(hex(randomblob(16))), message_id, 2, provider_idempotence_key || '-2', datetime('now'), datetime('now'), 1
      FROM outbox_attempt WHERE message_id = ? AND attempt_no = 1`).run(outbox.id);
    const failingLookup: EmailProvider = { async send() { throw new Error("must not send"); }, async lookup() { return { status: "FAILED" }; } };
    const domain = new CommerceDomain(setup.db, new MockProvider(), failingLookup);
    await domain.processEmailOutbox();
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "FAILED" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_normalized = 'hard-bounce@example.test'").get()).toEqual({ count: 1 });
  });

  it("creates a redacted replacement request epoch only after hard_bounced or local FAILED", async () => {
    const setup = fixture(); databases.push(setup.db);
    setup.domain.registerCityInterest({ email: "renew-hard@example.test", city: "novosibirsk" });
    const hard = setup.db.prepare(`SELECT request.id AS request_id, outbox.id AS outbox_id
      FROM city_interest_requests request
      JOIN city_interest_notification_intents intent ON intent.city_interest_request_id = request.id
      JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE request.email_normalized = 'renew-hard@example.test'`).get() as { request_id: string; outbox_id: string };
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: hard.outbox_id, status: "BOUNCED", providerStatus: "hard_bounced", semanticKey: "renew-hard-bounced" });
    // A later non-delivery event must not make established final hard-bounce
    // evidence disappear merely because it is the latest provider callback.
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: hard.outbox_id, status: "BOUNCED", providerStatus: "spam", semanticKey: "renew-hard-late-spam" });
    setup.domain.registerCityInterest({ email: "renew-hard@example.test", city: "novosibirsk" });
    const supersededHard = setup.db.prepare(`SELECT request.email_normalized, request.email_hash,
        request.superseded_at, request.superseded_by_request_id,
        intent.outbox_id, intent.superseded_at AS intent_superseded_at, outbox.status
      FROM city_interest_notification_intents intent
      JOIN city_interest_requests request ON request.id = intent.city_interest_request_id
      JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE intent.outbox_id = ?`).get(hard.outbox_id) as {
        email_normalized: string; email_hash: string; superseded_at: string;
        superseded_by_request_id: string; outbox_id: string; intent_superseded_at: string; status: string;
      };
    expect(supersededHard).toMatchObject({
      email_normalized: "", email_hash: "", superseded_at: expect.any(String),
      superseded_by_request_id: expect.any(String), outbox_id: hard.outbox_id,
      intent_superseded_at: expect.any(String), status: "BOUNCED",
    });
    const renewedHard = setup.db.prepare(`SELECT request.id AS request_id, outbox.id AS outbox_id
      FROM city_interest_requests request
      JOIN city_interest_notification_intents intent ON intent.city_interest_request_id = request.id
      JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE request.id = ? AND request.superseded_at IS NULL AND intent.superseded_at IS NULL`).get(supersededHard.superseded_by_request_id) as { request_id: string; outbox_id: string };
    expect(renewedHard.request_id).not.toBe(hard.request_id);
    const renewedHardOutbox = renewedHard.outbox_id;
    expect(setup.db.prepare(`SELECT COUNT(*) AS count FROM city_interest_requests
      WHERE city_slug = 'novosibirsk' AND superseded_at IS NULL
        AND email_hash = ?`).get(emailHash("renew-hard@example.test"))).toEqual({ count: 1 });
    expect(setup.db.prepare(`SELECT COUNT(*) AS count
      FROM city_interest_notification_intents intent
      JOIN city_interest_requests request ON request.id = intent.city_interest_request_id
      WHERE request.id = ? AND request.superseded_at IS NULL
        AND intent.superseded_at IS NULL`).get(renewedHard.request_id)).toEqual({ count: 1 });
    setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: hard.outbox_id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "renew-hard-late-delivered" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE id = ?").get(hard.request_id)).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT status, recipient_email FROM email_outbox WHERE id = ?").get(hard.outbox_id)).toEqual({ status: "DELIVERED", recipient_email: "" });
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(renewedHardOutbox)).toEqual({ status: "PENDING" });

    setup.domain.registerCityInterest({ email: "renew-failed@example.test", city: "novosibirsk" });
    const failed = setup.db.prepare(`SELECT request.id AS request_id, outbox.id AS outbox_id
      FROM city_interest_requests request
      JOIN city_interest_notification_intents intent ON intent.city_interest_request_id = request.id
      JOIN email_outbox outbox ON outbox.id = intent.outbox_id
      WHERE request.email_normalized = 'renew-failed@example.test'`).get() as { request_id: string; outbox_id: string };
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = ?").run(failed.outbox_id);
    await new CommerceDomain(setup.db, new MockProvider(), { async send() { throw new Error("must not send"); }, async lookup() { return { status: "FAILED" }; } }).processEmailOutbox();
    setup.domain.registerCityInterest({ email: "renew-failed@example.test", city: "novosibirsk" });
    const failedOld = setup.db.prepare("SELECT email_normalized, email_hash, superseded_at, superseded_by_request_id FROM city_interest_requests WHERE id = ?").get(failed.request_id);
    expect(failedOld).toEqual({ email_normalized: "", email_hash: "", superseded_at: expect.any(String), superseded_by_request_id: expect.any(String) });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_hash = ? AND city_slug = 'novosibirsk' AND superseded_at IS NULL").get(emailHash("renew-failed@example.test"))).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_notification_intents WHERE city_interest_request_id = ? AND superseded_at IS NOT NULL").get(failed.request_id)).toEqual({ count: 1 });
  });

  it("does not renew active or indeterminate city-interest notification intents", () => {
    const setup = fixture(); databases.push(setup.db);
    const states = ["PENDING", "SENDING", "SEND_UNKNOWN", "ACCEPTED", "SENT", "soft_bounced", "spam"] as const;
    for (const state of states) {
      const email = `retain-${state}@example.test`;
      setup.domain.registerCityInterest({ email, city: "novosibirsk" });
      const row = setup.db.prepare(`SELECT request.id AS request_id, outbox.id AS outbox_id
        FROM city_interest_requests request
        JOIN city_interest_notification_intents intent ON intent.city_interest_request_id = request.id
        JOIN email_outbox outbox ON outbox.id = intent.outbox_id
        WHERE request.email_normalized = ?`).get(email) as { request_id: string; outbox_id: string };
      if (state === "soft_bounced" || state === "spam") {
        setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: row.outbox_id, status: "BOUNCED", providerStatus: state, semanticKey: `retain-${state}` });
      } else {
        setup.db.prepare("UPDATE email_outbox SET status = ? WHERE id = ?").run(state, row.outbox_id);
      }
      setup.domain.registerCityInterest({ email, city: "novosibirsk" });
      expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_notification_intents WHERE city_interest_request_id = ?").get(row.request_id)).toEqual({ count: 1 });
      expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_notification_intents WHERE city_interest_request_id = ? AND superseded_at IS NULL").get(row.request_id)).toEqual({ count: 1 });
    }
  });

  it("treats a re-submit after withdrawal as a fresh request without reviving its suppressed outbox", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.domain.registerCityInterest({ email: "renew-withdrawn@example.test", city: "novosibirsk" });
    const oldOutbox = setup.db.prepare("SELECT id FROM email_outbox WHERE recipient_email = 'renew-withdrawn@example.test'").get() as { id: string };
    setup.domain.withdrawCityInterest("renew-withdrawn@example.test", "Consent withdrawal received", "admin");
    setup.domain.registerCityInterest({ email: "renew-withdrawn@example.test", city: "novosibirsk" });
    const freshOutbox = setup.db.prepare("SELECT id FROM email_outbox WHERE recipient_email = 'renew-withdrawn@example.test'").get() as { id: string };
    expect(freshOutbox.id).not.toBe(oldOutbox.id);
    expect(setup.db.prepare("SELECT status, recipient_email, suppressed_at FROM email_outbox WHERE id = ?").get(oldOutbox.id)).toEqual({ status: "SKIPPED", recipient_email: "", suppressed_at: expect.any(String) });
  });

  it("does not mark an already delivered city-interest row as suppressed", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.domain.registerCityInterest({ email: "already-delivered@example.test", city: "novosibirsk" });
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE recipient_email = 'already-delivered@example.test'").get() as { id: string };
    setup.db.prepare("UPDATE email_outbox SET status = 'DELIVERED' WHERE id = ?").run(outbox.id);
    setup.domain.withdrawCityInterest("already-delivered@example.test", "Consent withdrawal received", "admin");
    expect(setup.db.prepare("SELECT status, suppressed_at FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "DELIVERED", suppressed_at: null });
  });

  it("suppresses city-interest PENDING and SEND_UNKNOWN outboxes on withdrawal or expiry", async () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.registerCityInterest({ email: "withdraw-pending@example.test", city: "novosibirsk" });
    setup.domain.patchOccurrence(setup.occurrenceId, { visibility: "PUBLISHED", reason: "Publish schedule", expected_revision: 1 }, "withdraw-pending-publish", "admin");
    const pending = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string };
    setup.domain.withdrawCityInterest("withdraw-pending@example.test", "Consent withdrawal received", "admin");
    expect(setup.db.prepare("SELECT status, recipient_email, recipient_email_hash, payload_snapshot FROM email_outbox WHERE id = ?").get(pending.id)).toEqual({ status: "SKIPPED", recipient_email: "", recipient_email_hash: "", payload_snapshot: "{}" });
    expect(setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: pending.id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "withdrawn-late-delivered" })).toEqual({ duplicate: false });
    expect(setup.db.prepare("SELECT status, recipient_email, payload_snapshot FROM email_outbox WHERE id = ?").get(pending.id)).toEqual({ status: "DELIVERED", recipient_email: "", payload_snapshot: "{}" });

    const sends: string[] = [];
    const email: EmailProvider = { async send(input) { sends.push(input.recipientEmail); return { jobId: "must-not-send" }; }, async lookup() { return { status: "UNKNOWN" }; } };
    await new CommerceDomain(setup.db, new MockProvider(), email).processEmailOutbox();
    expect(sends).toEqual([]);

    setup.domain.registerCityInterest({ email: "expired-unknown@example.test", city: "novosibirsk" });
    const unknown = setup.db.prepare(`SELECT outbox.id FROM email_outbox outbox
      JOIN city_interest_notification_intents intent ON intent.outbox_id = outbox.id
      JOIN city_interest_requests request ON request.id = intent.city_interest_request_id
      WHERE request.email_normalized = 'expired-unknown@example.test'`).get() as { id: string };
    setup.db.prepare("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = ?").run(unknown.id);
    setup.db.prepare("UPDATE city_interest_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE email_normalized = 'expired-unknown@example.test'").run();
    expect(setup.domain.processCityInterestLifecycle()).toMatchObject({ expired_deleted: 1 });
    expect(setup.db.prepare("SELECT status, recipient_email, payload_snapshot FROM email_outbox WHERE id = ?").get(unknown.id)).toEqual({ status: "SKIPPED", recipient_email: "", payload_snapshot: "{}" });
    await new CommerceDomain(setup.db, new MockProvider(), email).processEmailOutbox();
    expect(sends).toEqual([]);
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_normalized = 'expired-unknown@example.test'").get()).toEqual({ count: 0 });
  });

  it("suppresses an in-flight city-interest send after withdrawal without reviving ACCEPTED", async () => {
    const setup = fixture(); databases.push(setup.db);
    let sendStarted!: () => void;
    let completeSend!: (value: { jobId: string }) => void;
    const started = new Promise<void>((resolve) => { sendStarted = resolve; });
    const providerResult = new Promise<{ jobId: string }>((resolve) => { completeSend = resolve; });
    const sends: string[] = [];
    const email: EmailProvider = {
      async send(input) {
        sends.push(input.recipientEmail);
        sendStarted();
        return providerResult;
      },
      async lookup() { return { status: "UNKNOWN" }; },
    };
    setup.domain.registerCityInterest({ email: "sending@example.test", city: "novosibirsk" });
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string };
    const domain = new CommerceDomain(setup.db, new MockProvider(), email);
    const dispatch = domain.processEmailOutbox();
    await started;
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SENDING" });
    setup.domain.withdrawCityInterest("sending@example.test", "Consent withdrawal received", "admin");
    expect(setup.db.prepare("SELECT status, recipient_email, recipient_email_hash, payload_snapshot, suppressed_at FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SKIPPED", recipient_email: "", recipient_email_hash: "", payload_snapshot: "{}", suppressed_at: expect.any(String) });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_normalized = 'sending@example.test'").get()).toEqual({ count: 0 });
    completeSend({ jobId: "withdrawn-in-flight-job" });
    await dispatch;
    expect(setup.db.prepare("SELECT status, recipient_email, recipient_email_hash, payload_snapshot, suppressed_at FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SKIPPED", recipient_email: "", recipient_email_hash: "", payload_snapshot: "{}", suppressed_at: expect.any(String) });
    expect(attemptJobId(setup.db, outbox.id)).toBe("withdrawn-in-flight-job");
    expect(domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: outbox.id, status: "ACCEPTED", providerStatus: "accepted", jobId: "withdrawn-in-flight-job", semanticKey: "withdrawn-in-flight-accepted" })).toEqual({ duplicate: false });
    expect(setup.db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outbox.id)).toEqual({ status: "SKIPPED" });
    expect(setup.db.prepare("SELECT provider_status FROM email_provider_events WHERE semantic_key = 'withdrawn-in-flight-accepted'").get()).toEqual({ provider_status: "accepted" });
    await domain.processEmailOutbox();
    expect(sends).toEqual(["sending@example.test"]);
  });

  it("keeps one notification intent across scans and a re-submission of the same active request", () => {
    const setup = fixture(); databases.push(setup.db);
    const first = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2026-01-01T00:00:00.000Z"));
    first.registerCityInterest({ email: "intent@example.test", city: "novosibirsk" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get()).toEqual({ count: 1 });
    first.processCityInterestLifecycle();
    first.processCityInterestLifecycle();
    const renewal = new CommerceDomain(setup.db, new MockProvider(), undefined, () => Date.parse("2026-02-01T00:00:00.000Z"));
    renewal.registerCityInterest({ email: "intent@example.test", city: "novosibirsk" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_notification_intents").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT expires_at FROM city_interest_requests WHERE email_normalized = 'intent@example.test'").get()).toEqual({ expires_at: "2027-02-01T00:00:00.000Z" });
  });

  it("rolls back provider evidence and city-interest cleanup together if delivered redaction fails", () => {
    const setup = fixture(); databases.push(setup.db);
    const outbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string } | undefined;
    if (!outbox) {
      setup.domain.registerCityInterest({ email: "atomic@example.test", city: "novosibirsk" });
    }
    const activeOutbox = setup.db.prepare("SELECT id FROM email_outbox WHERE type = 'CITY_INTEREST_AVAILABLE'").get() as { id: string };
    setup.db.exec(`CREATE TRIGGER fail_city_interest_redaction BEFORE UPDATE OF recipient_email ON email_outbox
      WHEN NEW.id = '${activeOutbox.id}' AND NEW.recipient_email = '' BEGIN SELECT RAISE(ABORT, 'redaction failed'); END;`);
    expect(() => setup.domain.applyUnisenderDelivery({ source: "WEBHOOK", outboxId: activeOutbox.id, status: "DELIVERED", providerStatus: "delivered", semanticKey: "atomic-delivered" })).toThrow("redaction failed");
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM city_interest_requests WHERE email_normalized = 'atomic@example.test'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_provider_events WHERE semantic_key = 'atomic-delivered'").get()).toEqual({ count: 0 });
  });

  it("withdraws all city-interest rows for an email without retaining a suppression identifier", () => {
    const setup = fixture(); databases.push(setup.db);
    setup.db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED' WHERE id = ?").run(setup.occurrenceId);
    setup.domain.registerCityInterest({ email: "withdraw@example.test", city: "novosibirsk" });
    setup.domain.registerCityInterest({ email: "withdraw@example.test", city: "tomsk" });
    setup.domain.registerCityInterest({ email: "other@example.test", city: "novosibirsk" });
    expect(setup.domain.withdrawCityInterest("withdraw@example.test", "Consent withdrawal received", "admin")).toEqual({ withdrawn: true, deleted_count: 2 });
    expect(setup.db.prepare("SELECT email_normalized FROM city_interest_requests ORDER BY email_normalized").all()).toEqual([{ email_normalized: "other@example.test" }]);
    expect(setup.domain.withdrawCityInterest("withdraw@example.test", "Consent withdrawal received", "admin")).toEqual({ withdrawn: true, deleted_count: 0 });
    const audit = setup.db.prepare("SELECT entity_id, details_json FROM admin_audit_log WHERE action = 'NOTIFICATION_CONSENT_WITHDRAWN' ORDER BY created_at LIMIT 1").get() as { entity_id: string; details_json: string };
    expect(audit.entity_id).toBe("all-matching-requests");
    expect(audit.details_json).not.toContain("withdraw@example.test");
  });

  it("applies one exact Tochka webhook replay under concurrent delivery without duplicate fulfilment", async () => {
    const setup = fixture(); databases.push(setup.db);
    const webhook = await tochkaWebhookCheckout(setup);
    const [first, replay] = await Promise.all([
      Promise.resolve().then(() => setup.domain.applyTochkaPaymentWebhook(webhook.input, webhook.expected)),
      Promise.resolve().then(() => setup.domain.applyTochkaPaymentWebhook(webhook.input, webhook.expected)),
    ]);

    expect([first, replay].filter((result) => result.applied)).toHaveLength(1);
    expect([first, replay].filter((result) => result.duplicate)).toHaveLength(1);
    expect(setup.domain.applyTochkaPaymentWebhook(webhook.input, webhook.expected)).toEqual({ duplicate: true, applied: false });
    expect(setup.db.prepare("SELECT status, captured_amount_kopecks FROM payments WHERE id = ?").get(webhook.paymentId))
      .toEqual({ status: "PAID", captured_amount_kopecks: 100_000 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM provider_webhook_events").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM provider_webhook_event_conflicts").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status = 'VALID'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'TICKET'").get()).toEqual({ count: 1 });
  });

  it("deduplicates an exact QUARANTINED Tochka webhook without changing fulfilment", async () => {
    const setup = fixture(); databases.push(setup.db);
    const webhook = await tochkaWebhookCheckout(setup);
    const invalid = { ...webhook.input, rawHash: "tochka-quarantined-payload", amountKopecks: 99_999 };

    expect(setup.domain.applyTochkaPaymentWebhook(invalid, webhook.expected)).toEqual({ duplicate: false, applied: false });
    expect(setup.domain.applyTochkaPaymentWebhook(invalid, webhook.expected)).toEqual({ duplicate: true, applied: false });
    expect(setup.db.prepare("SELECT status, payload_hash FROM provider_webhook_events").get())
      .toEqual({ status: "QUARANTINED", payload_hash: "tochka-quarantined-payload" });
    expect(setup.db.prepare("SELECT status, captured_amount_kopecks FROM payments WHERE id = ?").get(webhook.paymentId))
      .toEqual({ status: "PENDING", captured_amount_kopecks: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets").get()).toEqual({ count: 0 });
  });

  it("quarantines a conflicting Tochka amount after APPLIED without duplicating capture, ticket, or email", async () => {
    const setup = fixture(); databases.push(setup.db);
    const webhook = await tochkaWebhookCheckout(setup);
    expect(setup.domain.applyTochkaPaymentWebhook(webhook.input, webhook.expected)).toEqual({ duplicate: false, applied: true });
    const conflicting = { ...webhook.input, rawHash: "tochka-conflicting-amount", amountKopecks: 99_999 };

    expect(setup.domain.applyTochkaPaymentWebhook(conflicting, webhook.expected))
      .toEqual({ duplicate: false, applied: false, conflict: true });
    expect(setup.domain.applyTochkaPaymentWebhook(conflicting, webhook.expected))
      .toEqual({ duplicate: true, applied: false });
    expect(setup.db.prepare("SELECT payload_hash, status FROM provider_webhook_events").get())
      .toEqual({ payload_hash: webhook.input.rawHash, status: "APPLIED" });
    expect(setup.db.prepare("SELECT payload_hash, status FROM provider_webhook_event_conflicts").get())
      .toEqual({ payload_hash: "tochka-conflicting-amount", status: "CONFLICT_QUARANTINED" });
    expect(setup.db.prepare("SELECT status, captured_amount_kopecks FROM payments WHERE id = ?").get(webhook.paymentId))
      .toEqual({ status: "PAID", captured_amount_kopecks: 100_000 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status = 'VALID'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'TICKET'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM provider_drift_reviews WHERE entity_type = 'PAYMENT' AND entity_id = ?").get(webhook.paymentId))
      .toEqual({ count: 1 });
  });

  it.each([
    ["payment link", (input: Awaited<ReturnType<typeof tochkaWebhookCheckout>>["input"]) => ({ ...input, rawHash: "tochka-conflicting-link", paymentLinkId: randomUUID() })],
    ["customer", (input: Awaited<ReturnType<typeof tochkaWebhookCheckout>>["input"]) => ({ ...input, rawHash: "tochka-conflicting-customer", customerCode: "other-customer" })],
    ["merchant", (input: Awaited<ReturnType<typeof tochkaWebhookCheckout>>["input"]) => ({ ...input, rawHash: "tochka-conflicting-merchant", merchantId: "other-merchant" })],
  ])("quarantines conflicting Tochka %s evidence after APPLIED", async (_field, mutate) => {
    const setup = fixture(); databases.push(setup.db);
    const webhook = await tochkaWebhookCheckout(setup);
    expect(setup.domain.applyTochkaPaymentWebhook(webhook.input, webhook.expected)).toEqual({ duplicate: false, applied: true });

    expect(setup.domain.applyTochkaPaymentWebhook(mutate(webhook.input), webhook.expected))
      .toEqual({ duplicate: false, applied: false, conflict: true });
    expect(setup.db.prepare("SELECT status, captured_amount_kopecks FROM payments WHERE id = ?").get(webhook.paymentId))
      .toEqual({ status: "PAID", captured_amount_kopecks: 100_000 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM provider_webhook_event_conflicts WHERE status = 'CONFLICT_QUARANTINED'").get())
      .toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status = 'VALID'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'TICKET'").get()).toEqual({ count: 1 });
  });

  it("quarantines every distinct collision after a QUARANTINED Tochka event", async () => {
    const setup = fixture(); databases.push(setup.db);
    const webhook = await tochkaWebhookCheckout(setup);
    const quarantined = { ...webhook.input, rawHash: "tochka-first-quarantined", amountKopecks: 99_999 };
    expect(setup.domain.applyTochkaPaymentWebhook(quarantined, webhook.expected)).toEqual({ duplicate: false, applied: false });

    const validButConflicting = { ...webhook.input, rawHash: "tochka-corrected-valid" };
    expect(setup.domain.applyTochkaPaymentWebhook(validButConflicting, webhook.expected))
      .toEqual({ duplicate: false, applied: false, conflict: true });
    expect(setup.domain.applyTochkaPaymentWebhook(validButConflicting, webhook.expected))
      .toEqual({ duplicate: true, applied: false });
    expect(setup.domain.applyTochkaPaymentWebhook({ ...webhook.input, rawHash: "tochka-second-conflict", customerCode: "other-customer" }, webhook.expected))
      .toEqual({ duplicate: false, applied: false, conflict: true });
    expect(setup.db.prepare("SELECT payload_hash, status FROM provider_webhook_events").get())
      .toEqual({ payload_hash: "tochka-first-quarantined", status: "QUARANTINED" });
    expect(setup.db.prepare("SELECT payload_hash, status FROM provider_webhook_event_conflicts ORDER BY payload_hash").all())
      .toEqual([
        { payload_hash: "tochka-corrected-valid", status: "CONFLICT_QUARANTINED" },
        { payload_hash: "tochka-second-conflict", status: "CONFLICT_QUARANTINED" },
      ]);
    expect(setup.db.prepare("SELECT status, captured_amount_kopecks FROM payments WHERE id = ?").get(webhook.paymentId))
      .toEqual({ status: "PENDING", captured_amount_kopecks: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM tickets").get()).toEqual({ count: 0 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM email_outbox WHERE type = 'TICKET'").get()).toEqual({ count: 0 });
  });

  it("runs the financial worker sequence in order", async () => {
    const calls: string[] = [];
    const sweepDomain = {
      recoverStaleCommands: () => { calls.push("recover-stale"); },
      reconcileCreateUnknownPayments: async () => { calls.push("create-unknown"); },
      reconcilePendingPayments: async () => { calls.push("payments"); },
      createObligationRefunds: () => { calls.push("obligations"); },
      submitRequestedRefunds: async () => { calls.push("submit-refunds"); },
      reconcilePendingRefunds: async () => { calls.push("reconcile-refunds"); },
      processEmailOutbox: async () => { calls.push("email"); },
      reconcileUnisenderEventDumps: async () => { calls.push("event-dump"); },
      detectOverdueVenueAnnouncements: () => { calls.push("venue-overdue"); },
      processCityInterestLifecycle: () => { calls.push("city-interest"); return { expired_deleted: 0, intents_created: 0, intents_dispatched: 0, requests_completed: 0 }; },
      processOccurrenceNotificationLifecycle: () => { calls.push("occurrence-notifications"); return { deleted: 0, intents_created: 0, intents_dispatched: 0, requests_completed: 0 }; },
    };
    await runWorkerSweep(sweepDomain as never);
    expect(calls).toEqual(["recover-stale", "create-unknown", "payments", "obligations", "submit-refunds", "reconcile-refunds", "email", "event-dump", "venue-overdue", "city-interest", "occurrence-notifications"]);
  });
});

describe("anonymous age-band ticketing", () => {
  const databases: ReturnType<typeof fixture>["db"][] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });
  const checkoutFor = (quote_id: string, participant_age_band: "ADULT" | "MINOR_14_17" | "MINOR_UNDER_14", overrides: Record<string, unknown> = {}) => ({
    quote_id, customer_email: "customer@example.test", customer_adult_confirmed: true as const,
    participant_age_band, offer_accepted: true as const, pd_consent_accepted: true as const, ...overrides,
  });

  it("records an anonymous adult participant without an identity assertion", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync({
      quote_id: quote.quote_id, customer_email: "customer@example.test", customer_adult_confirmed: true,
      participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true,
    }, randomUUID(), "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT participant_name, participant_age_band, participant_date_of_birth, participant_age_at_occurrence, participant_is_customer, participant_is_minor FROM orders WHERE public_status_id = ?").get(result.status_id))
      .toEqual({ participant_name: null, participant_age_band: "ADULT", participant_date_of_birth: null, participant_age_at_occurrence: null, participant_is_customer: null, participant_is_minor: 0 });
  });

  it("applies the strict public checkout contract to direct domain callers", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await expect(setup.domain.checkoutAsync({
      quote_id: quote.quote_id, customer_email: "customer@example.test", customer_name: "Deprecated",
      customer_adult_confirmed: true, participant_age_band: "ADULT", participant: { self: true },
      offer_accepted: true, pd_consent_accepted: true,
    } as unknown as Parameters<typeof setup.domain.checkoutAsync>[0], randomUUID(), "https://flexperiment.ru"))
      .rejects.toMatchObject({ code: "CHECKOUT_REQUEST_INVALID" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
  });

  it("stores no name for an anonymous adult participant", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync(checkoutFor(quote.quote_id, "ADULT"), randomUUID(), "https://flexperiment.ru");
    const order = setup.db.prepare("SELECT customer_name, participant_name, participant_age_band, participant_is_customer, participant_is_minor, eligibility_confirmed_at FROM orders WHERE public_status_id = ?").get(result.status_id);
    expect(order).toEqual({ customer_name: "", participant_name: null, participant_age_band: "ADULT", participant_is_customer: null, participant_is_minor: 0, eligibility_confirmed_at: "DEPRECATED_NOT_EVIDENCE" });
  });

  it("requires an explicit age band and rejects incompatible declarations", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await expect(setup.domain.checkoutAsync({
      quote_id: quote.quote_id, customer_email: "customer@example.test", customer_adult_confirmed: false,
      participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true,
    }, randomUUID(), "https://flexperiment.ru")).rejects.toMatchObject({ code: "CUSTOMER_ADULT_CONFIRMATION_REQUIRED" });
    await expect(setup.domain.checkoutAsync({
      ...checkoutFor(quote.quote_id, "ADULT"), minor_legal_representative_confirmed: false,
    } as never, randomUUID(), "https://flexperiment.ru")).rejects.toMatchObject({ code: "UNEXPECTED_MINOR_LEGAL_REPRESENTATIVE_CONFIRMATION" });
  });

  it("requires legal-representative confirmation for declared minor bands and keeps the under-14 accompaniment rule", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    await expect(setup.domain.checkoutAsync(checkoutFor(quote.quote_id, "MINOR_14_17"), randomUUID(), "https://flexperiment.ru"))
      .rejects.toMatchObject({ code: "MINOR_LEGAL_REPRESENTATIVE_CONFIRMATION_REQUIRED" });
    const result = await setup.domain.checkoutAsync(checkoutFor(quote.quote_id, "MINOR_UNDER_14", { minor_legal_representative_confirmed: true }), randomUUID(), "https://flexperiment.ru");
    expect(setup.db.prepare("SELECT participant_age_band, participant_date_of_birth, participant_age_at_occurrence, participant_is_minor, participant_requires_adult_accompaniment, minor_legal_representative_confirmed_at, under_14_accompaniment_confirmed_at FROM orders WHERE public_status_id = ?").get(result.status_id))
      .toMatchObject({ participant_age_band: "MINOR_UNDER_14", participant_date_of_birth: null, participant_age_at_occurrence: null, participant_is_minor: 1, participant_requires_adult_accompaniment: 1, minor_legal_representative_confirmed_at: expect.any(String), under_14_accompaniment_confirmed_at: null });
    expect(setup.db.prepare("SELECT minor_legal_representative_confirmation_text FROM orders WHERE public_status_id = ?").get(result.status_id))
      .toEqual({ minor_legal_representative_confirmation_text: "Я являюсь совершеннолетним законным представителем несовершеннолетнего участника, для которого оформляю этот заказ." });
  });

  it("preserves booking-time age evidence and reschedule refund effects for later and earlier dates", async () => {
    const setup = fixture(); databases.push(setup.db);
    const quote = setup.domain.checkoutContext({ occurrenceId: setup.occurrenceId });
    const result = await setup.domain.checkoutAsync(checkoutFor(quote.quote_id, "MINOR_UNDER_14", { minor_legal_representative_confirmed: true }), randomUUID(), "https://flexperiment.ru");
    const payment = setup.db.prepare("SELECT p.id FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.public_status_id = ?").get(result.status_id) as { id: string };
    setup.domain.markPaymentPaid(payment.id, 100_000, "paid");
    setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-10-02T10:00:00.000Z", ends_at: "2026-10-02T13:00:00.000Z", reason: "Moved later", expected_revision: 1 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT participant_age_band, participant_is_minor, participant_requires_adult_accompaniment FROM orders WHERE public_status_id = ?").get(result.status_id))
      .toEqual({ participant_age_band: "MINOR_UNDER_14", participant_is_minor: 1, participant_requires_adult_accompaniment: 1 });
    expect(setup.db.prepare("SELECT status FROM bookings WHERE order_id = (SELECT id FROM orders WHERE public_status_id = ?)").get(result.status_id)).toEqual({ status: "CONFIRMED" });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements WHERE status = 'OPEN'").get()).toEqual({ count: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_revisions").get()).toEqual({ count: 1 });

    setup.domain.patchOccurrence(setup.occurrenceId, { starts_at: "2026-09-30T10:00:00.000Z", ends_at: "2026-09-30T13:00:00.000Z", reason: "Moved earlier", expected_revision: 2 }, randomUUID(), "admin");
    expect(setup.db.prepare("SELECT participant_age_band, participant_is_minor, participant_requires_adult_accompaniment FROM orders WHERE public_status_id = ?").get(result.status_id))
      .toEqual({ participant_age_band: "MINOR_UNDER_14", participant_is_minor: 1, participant_requires_adult_accompaniment: 1 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_change_refund_entitlements WHERE status = 'OPEN'").get()).toEqual({ count: 2 });
    expect(setup.db.prepare("SELECT COUNT(*) AS count FROM occurrence_revisions").get()).toEqual({ count: 2 });
  });
});
