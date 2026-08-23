import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db";

const migrationsDirectory = join(process.cwd(), "commerce", "migrations");
const applyThrough = (db: ReturnType<typeof openDatabase>, last: string) => {
  for (const migration of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql") && name <= last).sort()) {
    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, migration), "utf8")))();
  }
};

describe("0012 refund hardening and 0013 promoter migrations", () => {
  it("upgrades an empty database and enforces public order numbers", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0012_refund_hardening.sql");
    expect(() => db.prepare("INSERT INTO orders(id, public_order_number) VALUES (?, NULL)").run(randomUUID())).toThrow("PUBLIC_ORDER_NUMBER_REQUIRED");
    db.close();
  });

  it("upgrades populated 0011 orders and email provider evidence through 0012", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0011_occurrence_cancellation_and_refund_capabilities.sql");
    const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID(); const orderId = randomUUID(); const outboxId = randomUUID();
    const manifest = { documents: {} };
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'migration-city-0012', 'Migration city')").run(cityId);
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'migration-test-0012', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(manifest));
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Migration fixture', '2030-01-01T10:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Asia/Novosibirsk', 100, 1, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
    db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at)
      VALUES (?, 'migration-status-0012', 'FX-MIGRATION001200001', ?, 'Migration', 'migration@example.test', 'hash', 100, 1, 'Studio: Lenina 1', ?, '{"documents":{}}', '2026-01-01T00:00:00.000Z')`).run(orderId, occurrenceId, releaseId);
    db.prepare("INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key) VALUES (?, 'TEST', 'migration@example.test', 'hash', 'test', '{}', ?)").run(outboxId, randomUUID());
    db.prepare("INSERT INTO email_provider_events(id, outbox_id, semantic_key, status) VALUES (?, ?, ?, 'ACCEPTED')").run(randomUUID(), outboxId, randomUUID());
    const before = db.prepare("SELECT public_order_number FROM orders WHERE id = ?").get(orderId);

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0012_refund_hardening.sql"), "utf8")))();

    expect(db.prepare("SELECT public_order_number FROM orders WHERE id = ?").get(orderId)).toEqual(before);
    expect(db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "PENDING" });
    expect(db.prepare("SELECT outbox_id FROM email_provider_events WHERE outbox_id = ?").get(outboxId)).toEqual({ outbox_id: outboxId });
    expect((db.prepare("PRAGMA foreign_key_list(email_provider_events)").all() as { table: string; from: string; to: string }[]).map(({ table, from, to }) => ({ table, from, to }))).toEqual([{ table: "email_outbox", from: "outbox_id", to: "id" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("UPDATE orders SET public_order_number = NULL WHERE id = ?").run(orderId)).toThrow("PUBLIC_ORDER_NUMBER_IMMUTABLE");
    expect(() => db.prepare("UPDATE orders SET public_order_number = 'FX-CHANGED' WHERE id = ?").run(orderId)).toThrow("PUBLIC_ORDER_NUMBER_IMMUTABLE");
    db.close();
  });

  it("upgrades populated 0012 quote and reward evidence through 0013 without rewriting it", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0012_refund_hardening.sql");
    const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID(); const agentId = randomUUID(); const promoId = randomUUID(); const quoteId = randomUUID(); const orderId = randomUUID();
    const manifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test", sha256: "0".repeat(64), current_url: `https://example.test/current/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'migration-city', 'Migration city')").run(cityId);
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'migration-test', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(manifest));
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Migration fixture', '2030-01-01T10:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Asia/Novosibirsk', 100, 1, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
    db.prepare("INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value) VALUES (?, 'migration-promoter', 'Promoter', 'Promoter Legal', 'promoter@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)").run(agentId);
    db.prepare("INSERT INTO promo_codes(id, agent_id, code, normalized_code, discount_type, discount_value) VALUES (?, ?, 'MIGRATION', 'MIGRATION', 'FIXED', 10)").run(promoId, agentId);
    db.prepare("INSERT INTO quotes(id, occurrence_id, material_revision, legal_release_id, promo_id, attributed_agent_id, price_kopecks, discount_kopecks, final_amount_kopecks, venue_disclosure, expires_at) VALUES (?, ?, 1, ?, ?, ?, 100, 10, 90, 'Studio: Lenina 1', '2030-01-01T00:00:00.000Z')").run(quoteId, occurrenceId, releaseId, promoId, agentId);
    db.prepare("INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, attributed_agent_id, reward_type_snapshot, reward_value_snapshot, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot) VALUES (?, 'migration-status', 'FX-MIGRATION0000000001', ?, 'Migration', 'migration@example.test', 'hash', 90, 1, 'Studio: Lenina 1', ?, '{\"documents\":{}}', '2026-01-01T00:00:00.000Z', ?, 'PERCENT', 1000, 'MIGRATION', 'FIXED', 10)").run(orderId, occurrenceId, releaseId, agentId);
    db.prepare("INSERT INTO referral_rewards(id, order_id, agent_id, occurrence_id, amount_kopecks) VALUES (?, ?, ?, ?, 9)").run(randomUUID(), orderId, agentId, occurrenceId);
    db.prepare("INSERT INTO reward_adjustments(id, order_id, agent_id, amount_kopecks, reason) VALUES (?, ?, ?, -2, 'LEGACY_ADJUSTMENT')").run(randomUUID(), orderId, agentId);
    const before = db.prepare("SELECT promo_code_snapshot, discount_type_snapshot, discount_value_snapshot FROM orders WHERE id = ?").get(orderId);
    const promoBefore = db.prepare("SELECT agent_id, code, normalized_code, discount_type, discount_value FROM promo_codes WHERE id = ?").get(promoId);

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0013_promoter_attribution_rewards.sql"), "utf8")))();

    expect(db.prepare("SELECT promo_code_snapshot, discount_type_snapshot, discount_value_snapshot FROM orders WHERE id = ?").get(orderId)).toEqual(before);
    expect(db.prepare("SELECT agent_id, code, normalized_code, discount_type, discount_value FROM promo_codes WHERE id = ?").get(promoId)).toEqual(promoBefore);
    expect(db.prepare("SELECT referral_slug, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot FROM quotes WHERE id = ?").get(quoteId)).toEqual({ referral_slug: null, promo_code_snapshot: null, discount_type_snapshot: null, discount_value_snapshot: null });
    expect(db.prepare("SELECT amount_kopecks, reason, semantic_key FROM reward_adjustments WHERE order_id = ?").get(orderId)).toEqual({ amount_kopecks: -2, reason: "LEGACY_ADJUSTMENT", semantic_key: null });
    expect((db.prepare("PRAGMA table_info(quotes)").all() as { name: string }[]).map(({ name }) => name)).toEqual(expect.arrayContaining(["referral_slug", "promo_code_snapshot", "discount_type_snapshot", "discount_value_snapshot"]));
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'reward_adjustments_semantic_key_unique'").get()).toEqual({ name: "reward_adjustments_semantic_key_unique", sql: expect.stringContaining("WHERE semantic_key IS NOT NULL") });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("UPDATE orders SET public_order_number = NULL WHERE id = ?").run(orderId)).toThrow("PUBLIC_ORDER_NUMBER_IMMUTABLE");
    db.close();
  });

  it("upgrades populated 0013 settlement evidence through 0014 without rewriting allocations", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0013_promoter_attribution_rewards.sql");
    const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID(); const agentId = randomUUID(); const preparedId = randomUUID(); const pendingId = randomUUID(); const settledId = randomUUID(); const recoveryId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'migration-settlement-city', 'Migration city')").run(cityId);
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'migration-settlement', datetime('now'), ?, 1)").run(releaseId, JSON.stringify({ documents: {} }));
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Migration settlement fixture', '2030-01-01T10:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Asia/Novosibirsk', 100, 1, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
    db.prepare("INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value) VALUES (?, 'migration-settlement-agent', 'Agent', 'Agent Legal', 'agent@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'FIXED', 100)").run(agentId);
    const insertSettlement = db.prepare("INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, payment_made_at, settled_at, document_confirmed, document_reference, document_confirmed_at, created_by_admin_id) VALUES (?, ?, ?, ?, 'TRANSFER', ?, 'SELF_EMPLOYED', '2026-01-01T00:00:00.000Z', ?, ?, ?, ?, ?, 'admin')");
    insertSettlement.run(preparedId, agentId, occurrenceId, 100, "PREPARED", null, null, 0, null, null);
    insertSettlement.run(pendingId, agentId, occurrenceId, 200, "PENDING_DOCUMENT", "2026-01-02T00:00:00.000Z", null, 0, null, null);
    insertSettlement.run(settledId, agentId, occurrenceId, 300, "SETTLED", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", 1, "receipt-001", "2026-01-03T00:00:00.000Z");
    db.prepare("INSERT INTO settlement_recoveries(id, settlement_id, amount_recovered_kopecks, recovered_at, method, evidence_reference) VALUES (?, ?, 25, '2026-01-04T00:00:00.000Z', 'TRANSFER', 'bank-return')").run(recoveryId, settledId);
    const before = db.prepare("SELECT id, amount_kopecks, status, prepared_at, document_reference FROM reward_settlements ORDER BY id").all();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0014_prepared_settlement_hardening.sql"), "utf8")))();

    expect(db.prepare("SELECT id, amount_kopecks, status, prepared_at, document_reference FROM reward_settlements ORDER BY id").all()).toEqual(before);
    expect(db.prepare("SELECT amount_recovered_kopecks, evidence_reference FROM settlement_recoveries WHERE id = ?").get(recoveryId)).toEqual({ amount_recovered_kopecks: 25, evidence_reference: "bank-return" });
    expect((db.prepare("PRAGMA table_info(reward_settlement_command_idempotency)").all() as { name: string }[]).map(({ name }) => name)).toEqual(expect.arrayContaining(["command", "idempotency_key_hash", "settlement_id", "recovery_id"]));
    expect(() => db.prepare("INSERT INTO settlement_prepared_reviews(settlement_id) VALUES (?)").run(randomUUID())).toThrow(/FOREIGN KEY constraint failed/);
    db.prepare("INSERT INTO settlement_prepared_reviews(settlement_id) VALUES (?)").run(preparedId);
    expect(() => db.prepare("INSERT INTO settlement_prepared_reviews(settlement_id) VALUES (?)").run(preparedId)).toThrow(/UNIQUE constraint failed/);
    db.prepare("INSERT INTO reward_settlement_command_idempotency(command, idempotency_key_hash, canonical_request_hash, settlement_id, recovery_id) VALUES ('RECOVERY', 'migration-command-key', 'migration-request-hash', ?, ?)").run(settledId, recoveryId);
    expect(() => db.prepare("INSERT INTO reward_settlement_command_idempotency(command, idempotency_key_hash, canonical_request_hash, settlement_id) VALUES ('RECOVERY', 'migration-command-key', 'different-hash', ?)").run(settledId)).toThrow(/UNIQUE constraint failed/);
    expect((db.prepare("PRAGMA foreign_key_list(reward_settlement_command_idempotency)").all() as { table: string; from: string; to: string }[]).map(({ table, from, to }) => ({ table, from, to }))).toEqual(expect.arrayContaining([
      { table: "reward_settlements", from: "settlement_id", to: "id" },
      { table: "settlement_recoveries", from: "recovery_id", to: "id" },
    ]));
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'reward_settlements_prepared_stale_idx'").get()).toEqual({ name: "reward_settlements_prepared_stale_idx", sql: expect.stringContaining("WHERE status = 'PREPARED'") });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds unique city-interest storage on top of the 0014 schema", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0014_prepared_settlement_hardening.sql");
    db.exec(readFileSync(join(migrationsDirectory, "0015_city_interest_requests.sql"), "utf8"));
    expect((db.prepare("PRAGMA table_info(city_interest_requests)").all() as { name: string }[]).map(({ name }) => name)).toEqual(expect.arrayContaining([
      "email_normalized", "email_hash", "city_slug", "privacy_policy_version", "pd_consent_version", "consent_accepted_at",
    ]));
    db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug, privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at)
      VALUES ('interest-1', 'person@example.test', 'hash', 'tomsk', 'legal-1', 'a', 'consent-1', 'b', '2026-08-23T00:00:00.000Z')`).run();
    expect(() => db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug, privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at)
      VALUES ('interest-2', 'person@example.test', 'hash', 'tomsk', 'legal-1', 'a', 'consent-1', 'b', '2026-08-23T00:00:00.000Z')`).run()).toThrow(/UNIQUE constraint failed/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds deterministic expiry to populated city-interest evidence without rewriting it", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0015_city_interest_requests.sql");
    db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug, privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at, created_at)
      VALUES ('interest-expiry', 'person@example.test', 'hash', 'tomsk', 'legal-1', 'a', 'consent-1', 'b', '2024-02-29T12:34:56.000Z', '2024-02-29T12:34:56.000Z')`).run();
    const before = db.prepare("SELECT id, email_normalized, email_hash, city_slug, privacy_policy_version, pd_consent_version, consent_accepted_at, created_at FROM city_interest_requests WHERE id = 'interest-expiry'").get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0016_city_interest_lifecycle.sql"), "utf8")))();

    expect(db.prepare("SELECT id, email_normalized, email_hash, city_slug, privacy_policy_version, pd_consent_version, consent_accepted_at, created_at FROM city_interest_requests WHERE id = 'interest-expiry'").get()).toEqual(before);
    expect(db.prepare("SELECT expires_at FROM city_interest_requests WHERE id = 'interest-expiry'").get()).toEqual({ expires_at: "2025-03-01T12:34:56.000Z" });
    expect((db.prepare("PRAGMA table_info(city_interest_requests)").all() as { name: string }[]).map(({ name }) => name)).toContain("expires_at");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'city_interest_requests_expiry_idx'").get()).toEqual({ name: "city_interest_requests_expiry_idx" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds delivery-intent relations and exact provider outcomes without rewriting populated 0016 data", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0016_city_interest_lifecycle.sql");
    db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug, privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at, expires_at)
      VALUES ('interest-delivery', 'person@example.test', 'hash', 'tomsk', 'legal-1', 'a', 'consent-1', 'b', '2026-08-23T00:00:00.000Z', '2027-08-23T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES ('outbox-delivery', 'CITY_INTEREST_AVAILABLE', 'person@example.test', 'hash', 'city-interest-available', '{"city_title":"Томск"}', 'delivery-key')`).run();
    db.prepare(`INSERT INTO email_provider_events(id, outbox_id, semantic_key, status, job_id)
      VALUES ('event-delivery', 'outbox-delivery', 'old-delivery-event', 'SENT', 'job-1')`).run();
    const before = db.prepare("SELECT id, recipient_email, recipient_email_hash, payload_snapshot, status FROM email_outbox WHERE id = 'outbox-delivery'").get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0017_city_interest_delivery_lifecycle.sql"), "utf8")))();
    db.prepare("INSERT INTO city_interest_notification_intents(city_interest_request_id, outbox_id) VALUES ('interest-delivery', 'outbox-delivery')").run();

    expect(db.prepare("SELECT id, recipient_email, recipient_email_hash, payload_snapshot, status FROM email_outbox WHERE id = 'outbox-delivery'").get()).toEqual(before);
    expect(db.prepare("SELECT provider_status FROM email_provider_events WHERE id = 'event-delivery'").get()).toEqual({ provider_status: null });
    expect(() => db.prepare("INSERT INTO city_interest_notification_intents(city_interest_request_id, outbox_id) VALUES ('interest-delivery', 'outbox-delivery')").run()).toThrow(/UNIQUE constraint failed/);
    expect((db.prepare("PRAGMA foreign_key_list(city_interest_notification_intents)").all() as { table: string; from: string; to: string }[]).map(({ table, from, to }) => ({ table, from, to }))).toEqual(expect.arrayContaining([
      { table: "city_interest_requests", from: "city_interest_request_id", to: "id" },
      { table: "email_outbox", from: "outbox_id", to: "id" },
    ]));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds the city-interest suppression marker without rewriting delivery evidence", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0017_city_interest_delivery_lifecycle.sql");
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status, provider_idempotence_key)
      VALUES ('outbox-suppression', 'CITY_INTEREST_AVAILABLE', 'person@example.test', 'hash', 'city-interest-available', '{"city_title":"Томск"}', 'SENDING', 'suppression-key')`).run();
    const before = db.prepare("SELECT id, recipient_email, recipient_email_hash, payload_snapshot, status FROM email_outbox WHERE id = 'outbox-suppression'").get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0018_city_interest_suppression.sql"), "utf8")))();

    expect(db.prepare("SELECT id, recipient_email, recipient_email_hash, payload_snapshot, status, suppressed_at FROM email_outbox WHERE id = 'outbox-suppression'").get()).toEqual({ ...(before as object), suppressed_at: null });
    expect((db.prepare("PRAGMA table_info(email_outbox)").all() as { name: string }[]).map(({ name }) => name)).toContain("suppressed_at");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("preserves a populated notification intent while adding renewable notification epochs", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0018_city_interest_suppression.sql");
    db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug, privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at, expires_at)
      VALUES ('interest-epoch', 'person@example.test', 'hash', 'tomsk', 'legal-1', 'a', 'consent-1', 'b', '2026-08-23T00:00:00.000Z', '2027-08-23T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES ('outbox-epoch', 'CITY_INTEREST_AVAILABLE', 'person@example.test', 'hash', 'city-interest-available', '{"city_title":"Томск"}', 'epoch-key')`).run();
    db.prepare("INSERT INTO city_interest_notification_intents(city_interest_request_id, outbox_id) VALUES ('interest-epoch', 'outbox-epoch')").run();
    const before = db.prepare("SELECT city_interest_request_id, outbox_id, created_at FROM city_interest_notification_intents").get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0019_city_interest_notification_epochs.sql"), "utf8")))();

    expect(db.prepare("SELECT city_interest_request_id, outbox_id, created_at, superseded_at FROM city_interest_notification_intents").get()).toEqual({ ...(before as object), superseded_at: null });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'city_interest_notification_intents_active_request_unique'").get()).toEqual({ sql: expect.stringContaining("WHERE superseded_at IS NULL") });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds durable email recovery scheduling without rewriting populated outbox evidence", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0019_city_interest_notification_epochs.sql");
    db.prepare(`INSERT INTO email_outbox(
      id, type, recipient_email, recipient_email_hash, template, payload_snapshot,
      status, provider_idempotence_key, attempts, last_error
    ) VALUES ('outbox-recovery', 'CITY_INTEREST_AVAILABLE', 'person@example.test', 'hash',
      'city-interest-available', '{"city_title":"Томск"}', 'SEND_UNKNOWN', 'recovery-key', 4,
      'UNISENDER_TRANSPORT_AMBIGUOUS')`).run();
    const before = db.prepare(`SELECT id, recipient_email, recipient_email_hash, payload_snapshot,
      status, provider_idempotence_key, attempts, last_error FROM email_outbox WHERE id = 'outbox-recovery'`).get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0020_email_outbox_recovery_hardening.sql"), "utf8")))();

    expect(db.prepare(`SELECT id, recipient_email, recipient_email_hash, payload_snapshot,
      status, provider_idempotence_key, attempts, last_error, provider_error_code,
      provider_error_message, next_attempt_at FROM email_outbox WHERE id = 'outbox-recovery'`).get())
      .toEqual({ ...(before as object), provider_error_code: null, provider_error_message: null, next_attempt_at: null });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'email_outbox_send_unknown_due_idx'").get())
      .toEqual({ sql: expect.stringContaining("WHERE status = 'SEND_UNKNOWN'") });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("upgrades populated city-interest evidence to request epochs without rewriting it", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0020_email_outbox_recovery_hardening.sql");
    db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug,
      privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256,
      consent_accepted_at, expires_at)
      VALUES ('interest-epoch-upgrade', 'person@example.test', 'hash', 'tomsk', 'legal-1',
      'a', 'consent-1', 'b', '2026-08-23T00:00:00.000Z', '2027-08-23T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
      payload_ref, payload_snapshot, provider_idempotence_key)
      VALUES ('outbox-epoch-upgrade', 'CITY_INTEREST_AVAILABLE', 'person@example.test', 'hash',
      'city-interest-available', 'city-interest:interest-epoch-upgrade', '{}', 'epoch-upgrade-key')`).run();
    db.prepare(`INSERT INTO city_interest_notification_intents(id, city_interest_request_id, outbox_id)
      VALUES ('intent-epoch-upgrade', 'interest-epoch-upgrade', 'outbox-epoch-upgrade')`).run();
    const before = db.prepare(`SELECT id, email_normalized, email_hash, city_slug,
      privacy_policy_version, pd_consent_version, consent_accepted_at, expires_at
      FROM city_interest_requests WHERE id = 'interest-epoch-upgrade'`).get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0021_city_interest_request_epochs.sql"), "utf8")))();

    expect(db.prepare(`SELECT id, email_normalized, email_hash, city_slug,
      privacy_policy_version, pd_consent_version, consent_accepted_at, expires_at,
      superseded_at, superseded_by_request_id
      FROM city_interest_requests WHERE id = 'interest-epoch-upgrade'`).get())
      .toEqual({ ...(before as object), superseded_at: null, superseded_by_request_id: null });
    expect(db.prepare("SELECT city_interest_request_id, outbox_id, superseded_at FROM city_interest_notification_intents WHERE id = 'intent-epoch-upgrade'").get())
      .toEqual({ city_interest_request_id: "interest-epoch-upgrade", outbox_id: "outbox-epoch-upgrade", superseded_at: null });
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'city_interest_requests_active_identity_unique'").get())
      .toEqual({ sql: expect.stringContaining("WHERE superseded_at IS NULL") });
    expect((db.prepare("PRAGMA table_info(city_interest_requests)").all() as { name: string }[]).map(({ name }) => name))
      .toEqual(expect.arrayContaining(["superseded_at", "superseded_by_request_id"]));
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("preserves the delivered city-interest cleanup FK cascade through the current schema", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0021_city_interest_request_epochs.sql");
    db.prepare(`INSERT INTO city_interest_requests(id, email_normalized, email_hash, city_slug,
      privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256,
      consent_accepted_at, expires_at)
      VALUES ('interest-delivered-cascade', 'person@example.test', 'hash', 'tomsk', 'legal-1',
      'a', 'consent-1', 'b', '2026-08-23T00:00:00.000Z', '2027-08-23T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
      payload_ref, payload_snapshot, provider_idempotence_key)
      VALUES ('outbox-delivered-cascade', 'CITY_INTEREST_AVAILABLE', 'person@example.test', 'hash',
      'city-interest-available', 'city-interest:interest-delivered-cascade', '{}', 'cascade-key')`).run();
    db.prepare(`INSERT INTO city_interest_notification_intents(id, city_interest_request_id, outbox_id)
      VALUES ('intent-delivered-cascade', 'interest-delivered-cascade', 'outbox-delivered-cascade')`).run();

    db.prepare("DELETE FROM city_interest_requests WHERE id = 'interest-delivered-cascade'").run();

    expect(db.prepare("SELECT id FROM city_interest_notification_intents WHERE id = 'intent-delivered-cascade'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM email_outbox WHERE id = 'outbox-delivered-cascade'").get()).toEqual({ id: "outbox-delivered-cascade" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds restart-safe CREATE_UNKNOWN lookup fields without rewriting the payment", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0021_city_interest_request_epochs.sql");
    const paymentId = randomUUID(); const orderId = randomUUID();
    const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'create-unknown-upgrade', 'Migration city')").run(cityId);
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'migration-create-unknown', datetime('now'), ?, 1)").run(releaseId, JSON.stringify({ documents: {} }));
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Migration fixture', '2030-01-01T10:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Asia/Novosibirsk', 100, 1, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
    db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at)
      VALUES (?, 'create-unknown-upgrade', 'FX-CREATEUNKNOWNUPGRADE', ?, 'Migration', 'migration@example.test', 'hash', 100, 1, 'Studio', ?, '{"documents":{}}', '2026-01-01T00:00:00.000Z')`).run(orderId, occurrenceId, releaseId);
    db.prepare("INSERT INTO payments(id, order_id, state, status, provider_idempotency_key, creation_started_at) VALUES (?, ?, 'CREATE_UNKNOWN', 'PENDING', ?, '2026-08-23T00:00:00.000Z')").run(paymentId, orderId, randomUUID());
    const before = db.prepare("SELECT id, order_id, state, status, creation_started_at FROM payments WHERE id = ?").get(paymentId);

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0022_create_unknown_recovery.sql"), "utf8")))();

    expect(db.prepare("SELECT id, order_id, state, status, creation_started_at, create_unknown_lookup_attempts, create_unknown_next_lookup_at FROM payments WHERE id = ?").get(paymentId))
      .toEqual({ ...(before as object), create_unknown_lookup_attempts: 0, create_unknown_next_lookup_at: null });
    expect((db.prepare("PRAGMA index_list(payments)").all() as { name: string }[]).map(({ name }) => name)).toContain("payments_create_unknown_lookup_due_idx");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds operational email acknowledgement fields without rewriting delivery evidence", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0022_create_unknown_recovery.sql");
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
      payload_snapshot, status, provider_idempotence_key, attempts, sent_at, bounced_at,
      provider_error_code, provider_error_message)
      VALUES ('attention-upgrade', 'TICKET', 'buyer@example.test', 'hash', 'ticket', '{}',
      'BOUNCED', 'attention-upgrade-key', 3, '2026-08-23T00:00:00.000Z',
      '2026-08-23T00:02:00.000Z', 'hard_bounced', 'Mailbox unavailable')`).run();
    const before = db.prepare(`SELECT status, attempts, sent_at, bounced_at,
      provider_error_code, provider_error_message FROM email_outbox WHERE id = 'attention-upgrade'`).get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0023_email_operational_attention.sql"), "utf8")))();

    expect(db.prepare(`SELECT status, attempts, sent_at, bounced_at, provider_error_code,
      provider_error_message, ops_acknowledged_at, ops_acknowledged_reason
      FROM email_outbox WHERE id = 'attention-upgrade'`).get())
      .toEqual({ ...(before as object), ops_acknowledged_at: null, ops_acknowledged_reason: null });
    expect((db.prepare("PRAGMA index_list(email_outbox)").all() as { name: string }[]).map(({ name }) => name))
      .toContain("email_outbox_operational_attention_idx");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("adds Tochka webhook collision evidence without rewriting the first semantic event", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0023_email_operational_attention.sql");
    db.prepare(`INSERT INTO provider_webhook_events(
      id, provider, semantic_key, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-original', 'TOCHKA', 'operation-1:APPROVED', 'first-hash',
      'QUARANTINED', NULL, '{"amount_kopecks":999}')`).run();
    const before = db.prepare(`SELECT id, provider, semantic_key, payload_hash, status,
      entity_id, observed_json FROM provider_webhook_events WHERE id = 'tochka-original'`).get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0024_tochka_webhook_collision_evidence.sql"), "utf8")))();

    expect(db.prepare(`SELECT id, provider, semantic_key, payload_hash, status,
      entity_id, observed_json FROM provider_webhook_events WHERE id = 'tochka-original'`).get()).toEqual(before);
    db.prepare(`INSERT INTO provider_webhook_event_conflicts(
      id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-correction', 'TOCHKA', 'operation-1:APPROVED', 'tochka-original',
      'corrected-hash', 'CONFLICT_QUARANTINED', NULL, '{"amount_kopecks":1000}')`).run();
    expect(() => db.prepare(`INSERT INTO provider_webhook_event_conflicts(
      id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-duplicate-variant', 'TOCHKA', 'operation-1:APPROVED', 'tochka-original',
      'corrected-hash', 'CONFLICT_QUARANTINED', NULL, '{}')`).run()).toThrow(/UNIQUE constraint failed/);
    expect((db.prepare("PRAGMA index_list(provider_webhook_event_conflicts)").all() as { name: string }[])
      .map(({ name }) => name)).toContain("provider_webhook_event_conflicts_original_idx");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("upgrades populated 0024 Tochka conflict evidence to the fail-closed schema", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0024_tochka_webhook_collision_evidence.sql");
    db.prepare(`INSERT INTO provider_webhook_events(
      id, provider, semantic_key, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-0025-original', 'TOCHKA', 'operation-2:APPROVED', 'original-hash',
      'QUARANTINED', NULL, '{"amount_kopecks":999}')`).run();
    db.prepare(`INSERT INTO provider_webhook_event_conflicts(
      id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-0025-conflict', 'TOCHKA', 'operation-2:APPROVED',
      'tochka-0025-original', 'conflict-hash', 'CONFLICT_QUARANTINED', NULL,
      '{"amount_kopecks":1000}')`).run();
    const originalBefore = db.prepare(`SELECT id, provider, semantic_key, payload_hash, status,
      entity_id, observed_json FROM provider_webhook_events WHERE id = 'tochka-0025-original'`).get();

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0025_tochka_webhook_conflicts_fail_closed.sql"), "utf8")))();

    expect(db.prepare(`SELECT id, provider, semantic_key, payload_hash, status,
      entity_id, observed_json FROM provider_webhook_events WHERE id = 'tochka-0025-original'`).get()).toEqual(originalBefore);
    expect(db.prepare(`SELECT id, payload_hash, status FROM provider_webhook_event_conflicts
      WHERE id = 'tochka-0025-conflict'`).get())
      .toEqual({ id: "tochka-0025-conflict", payload_hash: "conflict-hash", status: "CONFLICT_QUARANTINED" });
    expect(() => db.prepare(`INSERT INTO provider_webhook_event_conflicts(
      id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-0025-corrected', 'TOCHKA', 'operation-2:APPROVED',
      'tochka-0025-original', 'corrected-hash', 'CORRECTED_APPLIED', NULL, '{}')`).run())
      .toThrow(/CHECK constraint failed/);
    db.prepare(`INSERT INTO provider_webhook_event_conflicts(
      id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-0025-second-conflict', 'TOCHKA', 'operation-2:APPROVED',
      'tochka-0025-original', 'second-conflict-hash', 'CONFLICT_QUARANTINED', NULL, '{}')`).run();
    expect((db.prepare("PRAGMA index_list(provider_webhook_event_conflicts)").all() as { name: string }[])
      .map(({ name }) => name)).toContain("provider_webhook_event_conflicts_original_idx");
    expect((db.prepare("PRAGMA foreign_key_list(provider_webhook_event_conflicts)").all() as { table: string; from: string; to: string }[])
      .map(({ table, from, to }) => ({ table, from, to })))
      .toEqual([{ table: "provider_webhook_events", from: "original_event_id", to: "id" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("fails closed instead of coercing historical CORRECTED_APPLIED conflict evidence", () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0024_tochka_webhook_collision_evidence.sql");
    db.prepare(`INSERT INTO provider_webhook_events(
      id, provider, semantic_key, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-legacy-original', 'TOCHKA', 'operation-legacy:APPROVED', 'legacy-hash',
      'QUARANTINED', NULL, '{}')`).run();
    db.prepare(`INSERT INTO provider_webhook_event_conflicts(
      id, provider, semantic_key, original_event_id, payload_hash, status, entity_id, observed_json
    ) VALUES ('tochka-legacy-corrected', 'TOCHKA', 'operation-legacy:APPROVED',
      'tochka-legacy-original', 'legacy-correction-hash', 'CORRECTED_APPLIED', NULL, '{}')`).run();

    expect(() => db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0025_tochka_webhook_conflicts_fail_closed.sql"), "utf8")))())
      .toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT status FROM provider_webhook_event_conflicts WHERE id = 'tochka-legacy-corrected'").get())
      .toEqual({ status: "CORRECTED_APPLIED" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_webhook_event_conflicts_rebuilt'").get())
      .toBeUndefined();
    db.close();
  });
});
