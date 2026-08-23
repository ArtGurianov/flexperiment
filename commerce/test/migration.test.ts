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
});
