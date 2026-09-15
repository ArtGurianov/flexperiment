import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import { concurrencyFixture, type ConcurrencyFixture } from "./support/concurrency-fixture";

const fixtures: ConcurrencyFixture[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()?.close(); });

const manifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true }])) };
const payload = (quoteId: string) => ({ quote_id: quoteId, customer_email: "inventory@example.test", customer_adult_confirmed: true as const, participant_age_band: "ADULT" as const, offer_accepted: true as const, pd_consent_accepted: true as const });

function setup() {
  const fixture = concurrencyFixture(); fixtures.push(fixture);
  const cityId = randomUUID(); const occurrenceId = randomUUID();
  fixture.primary.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'tomsk', 'Томск')").run(cityId);
  fixture.primary.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'test', datetime('now'), ?, 1)").run(randomUUID(), JSON.stringify(manifest));
  fixture.primary.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'Inventory', '2030-10-01T10:00:00.000Z', '2030-10-01T12:00:00.000Z', 'Asia/Tomsk', 100000, 1, 'PUBLISHED', 'OPEN', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return { fixture, occurrenceId, first: new CommerceDomain(fixture.primary, new MockProvider()), second: new CommerceDomain(fixture.connect(), new MockProvider()) };
}

describe("occurrence inventory writer serialization", () => {
  it("never commits capacity below a checkout that won the last seat", () => {
    const { fixture, occurrenceId, first, second } = setup();
    const quote = first.checkoutContext({ occurrenceId });
    first.checkout(payload(quote.quote_id), "inventory-checkout-1");

    expect(() => second.patchOccurrence(occurrenceId, { expected_revision: 1, inventory: { capacity: 0 } }, "inventory-shrink-1", "admin"))
      .toThrow("CAPACITY_BELOW_COMMITTED_SEATS");
    expect(fixture.primary.prepare("SELECT capacity FROM occurrences WHERE id = ?").get(occurrenceId)).toEqual({ capacity: 1 });
  });

  it("makes a checkout lose when an admin shrink won first", () => {
    const { occurrenceId, first, second } = setup();
    first.patchOccurrence(occurrenceId, { expected_revision: 1, inventory: { capacity: 0 } }, "inventory-shrink-2", "admin");
    expect(() => second.checkoutContext({ occurrenceId })).toThrow("SOLD_OUT");
  });

  it("refuses the second admin tab's stale CAS token", () => {
    const { occurrenceId, first, second } = setup();
    first.patchOccurrence(occurrenceId, { expected_revision: 1, inventory: { admin_reserved_seats: 1 } }, "inventory-reserve-a", "admin-a");
    expect(() => second.patchOccurrence(occurrenceId, { expected_revision: 1, inventory: { capacity: 2 } }, "inventory-reserve-b", "admin-b"))
      .toThrow("OCCURRENCE_REVISION_CONFLICT");
  });
});
