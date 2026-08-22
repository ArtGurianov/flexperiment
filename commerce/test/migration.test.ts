import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";

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

  it("supports populated upgraded orders and provider-email evidence", async () => {
    const db = openDatabase(":memory:");
    applyThrough(db, "0011_occurrence_cancellation_and_refund_capabilities.sql");
    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0012_refund_hardening.sql"), "utf8")))();
    db.transaction(() => db.exec(readFileSync(join(migrationsDirectory, "0013_promoter_attribution_rewards.sql"), "utf8")))();
    const cityId = randomUUID(); const occurrenceId = randomUUID(); const releaseId = randomUUID();
    const manifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test", sha256: "0".repeat(64), current_url: `https://example.test/current/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'migration-city', 'Migration city')").run(cityId);
    db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'migration-test', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(manifest));
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'Migration fixture', '2030-01-01T10:00:00.000Z', '2030-01-01T12:00:00.000Z', 'Asia/Novosibirsk', 100, 1, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
    const domain = new CommerceDomain(db, new MockProvider());
    const quote = domain.checkoutContext({ occurrenceId });
    const checkout = await domain.checkoutAsync({ quote_id: quote.quote_id, customer_name: "Migration", customer_email: "migration@example.test", eligibility_confirmed: true, offer_accepted: true, pd_consent_accepted: true }, "a8927abc-77c6-47b1-b6d0-000000000001", "https://flexperiment.ru");
    const order = db.prepare("SELECT id, public_order_number FROM orders WHERE public_status_id = ?").get(checkout.status_id) as { id: string; public_order_number: string };
    const outboxId = randomUUID();
    db.prepare("INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key) VALUES (?, 'TEST', 'migration@example.test', 'hash', 'test', '{}', ?)").run(outboxId, randomUUID());
    db.prepare("INSERT INTO email_provider_events(id, outbox_id, semantic_key, status) VALUES (?, ?, ?, 'ACCEPTED')").run(randomUUID(), outboxId, randomUUID());

    expect(db.prepare("SELECT public_order_number FROM orders WHERE id = ?").get(order.id)).toEqual({ public_order_number: order.public_order_number });
    expect(db.prepare("SELECT status FROM email_outbox WHERE id = ?").get(outboxId)).toEqual({ status: "PENDING" });
    expect(db.prepare("SELECT outbox_id FROM email_provider_events WHERE outbox_id = ?").get(outboxId)).toEqual({ outbox_id: outboxId });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("PRAGMA foreign_key_list(email_provider_events)").all() as { table: string; from: string; to: string }[]).map(({ table, from, to }) => ({ table, from, to }))).toEqual([{ table: "email_outbox", from: "outbox_id", to: "id" }]);
    expect(db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE tbl_name IN ('email_outbox', 'email_provider_events') AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name").all()).toEqual([]);
    expect(() => db.prepare("UPDATE orders SET public_order_number = NULL WHERE id = ?").run(order.id)).toThrow("PUBLIC_ORDER_NUMBER_IMMUTABLE");
    expect(() => db.prepare("UPDATE orders SET public_order_number = 'FX-CHANGED' WHERE id = ?").run(order.id)).toThrow("PUBLIC_ORDER_NUMBER_IMMUTABLE");
    db.close();
  });
});
