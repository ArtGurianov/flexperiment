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

  it("upgrades representative populated 0012 quote and reward evidence without rewriting it", () => {
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

    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0013_promoter_attribution_rewards.sql"), "utf8")))();

    expect(db.prepare("SELECT promo_code_snapshot, discount_type_snapshot, discount_value_snapshot FROM orders WHERE id = ?").get(orderId)).toEqual(before);
    expect(db.prepare("SELECT referral_slug, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot FROM quotes WHERE id = ?").get(quoteId)).toEqual({ referral_slug: null, promo_code_snapshot: null, discount_type_snapshot: null, discount_value_snapshot: null });
    expect(db.prepare("SELECT amount_kopecks, reason, semantic_key FROM reward_adjustments WHERE order_id = ?").get(orderId)).toEqual({ amount_kopecks: -2, reason: "LEGACY_ADJUSTMENT", semantic_key: null });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'reward_adjustments_semantic_key_unique'").get()).toEqual({ name: "reward_adjustments_semantic_key_unique" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare("UPDATE orders SET public_order_number = NULL WHERE id = ?").run(orderId)).toThrow("PUBLIC_ORDER_NUMBER_IMMUTABLE");
    db.close();
  });
});
