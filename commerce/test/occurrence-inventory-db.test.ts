import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain } from "../src/domain";
import { seatCommitments } from "../src/occurrence-inventory";
import { MockProvider } from "../src/provider";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });
const manifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };

function setup() {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const occurrenceId = randomUUID(); const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'tomsk', 'Томск')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'test', datetime('now'), ?, 1)").run(randomUUID(), JSON.stringify(manifest));
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'Inventory', '2030-10-01T10:00:00.000Z', '2030-10-01T12:00:00.000Z', 'Asia/Tomsk', 100000, 5, 'PUBLISHED', 'OPEN', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return { db, occurrenceId, domain: new CommerceDomain(db, new MockProvider()) };
}

const checkout = (domain: CommerceDomain, occurrenceId: string, key: string) => {
  const quote = domain.checkoutContext({ occurrenceId });
  return domain.checkout({ quote_id: quote.quote_id, customer_email: `${key}@example.test`, customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true }, key);
};

describe("occurrence inventory commitments", () => {
  it("partitions a reservation into held, reconciling, then sold without changing allocation", () => {
    const { db, occurrenceId, domain } = setup();
    const status = checkout(domain, occurrenceId, "inventory-partition");
    const payment = db.prepare("SELECT id FROM payments WHERE order_id = (SELECT id FROM orders WHERE public_status_id = ?)").get(status.status_id) as { id: string };
    expect(seatCommitments(db, occurrenceId)).toEqual({ sold: 0, held: 1, reconciling: 0 });
    db.prepare("UPDATE payments SET state = 'CREATE_UNKNOWN' WHERE id = ?").run(payment.id);
    expect(seatCommitments(db, occurrenceId)).toEqual({ sold: 0, held: 0, reconciling: 1 });
    domain.markPaymentPaid(payment.id, 100000, "provider-paid");
    expect(seatCommitments(db, occurrenceId)).toEqual({ sold: 1, held: 0, reconciling: 0 });
  });

  it("keeps inventory edits non-material and records their explicit audit diff", () => {
    const { db, occurrenceId, domain } = setup();
    domain.patchOccurrence(occurrenceId, { expected_revision: 1, inventory: { capacity: 7, admin_reserved_seats: 2 } }, "inventory-audit", "admin");
    expect(db.prepare("SELECT material_revision, admin_revision FROM occurrences WHERE id = ?").get(occurrenceId)).toEqual({ material_revision: 1, admin_revision: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrence_revisions WHERE occurrence_id = ?").get(occurrenceId)).toEqual({ count: 0 });
    expect(JSON.parse(String((db.prepare("SELECT details_json FROM admin_audit_log WHERE entity_id = ?").get(occurrenceId) as { details_json: string }).details_json))).toMatchObject({ inventory: { capacity: { from: 5, to: 7 }, admin_reserved_seats: { from: 0, to: 2 } } });
  });

  it("uses reserve for waitlist eligibility and rejects deprecated direct capacity patches", () => {
    const { db, occurrenceId, domain } = setup();
    (domain as unknown as { occurrenceNotificationsAvailable: () => boolean }).occurrenceNotificationsAvailable = () => true;
    domain.patchOccurrence(occurrenceId, { expected_revision: 1, inventory: { admin_reserved_seats: 5 } }, "inventory-waitlist-close", "admin");
    expect(() => domain.checkoutContext({ occurrenceId })).toThrow("SOLD_OUT");
    domain.registerOccurrenceNotification({ email: "waitlist@example.test", occurrence_id: occurrenceId });
    expect(db.prepare("SELECT COUNT(*) AS count FROM occurrence_notification_intents").get()).toEqual({ count: 0 });
    domain.patchOccurrence(occurrenceId, { expected_revision: 2, inventory: { admin_reserved_seats: 0 } }, "inventory-waitlist-open", "admin");
    expect(domain.processOccurrenceNotificationLifecycle()).toEqual({ deleted: 0, intents_created: 1 });
    expect(() => domain.patchOccurrence(occurrenceId, { expected_revision: 3, capacity: 4 }, "inventory-deprecated-capacity", "admin")).toThrow("VALIDATION_ERROR");
  });
});
