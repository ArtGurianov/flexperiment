import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";

/**
 * A message and its first attempt are created together or not at all.
 *
 * The property is deliberately not "two inserts are adjacent in the source".
 * It is that a newly created message without attempt #1 cannot exist, so the
 * tests below break the second insert on purpose and require the first to
 * disappear with it.
 *
 * enqueueEmail is reached from transactional business operations and from sweep
 * loops alike, so both entry shapes are covered: an outer transaction must be
 * joined rather than nested, and a bare call must open its own.
 */

const legalManifest = {
  documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [
    document,
    { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${document}`, archive_url: `https://example.test/archive/${document}`, checkout_relevant: true },
  ])),
};

const databases: ReturnType<typeof openDatabase>[] = [];

const fixture = () => {
  const db = openDatabase(":memory:");
  migrate(db);
  databases.push(db);
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)")
    .run(randomUUID(), JSON.stringify(legalManifest));
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2026-10-01T10:00:00.000Z', '2026-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`)
    .run(randomUUID(), cityId);
  return { db, domain: new CommerceDomain(db, new MockProvider()) };
};

/** Reaches the private enqueue through a real caller. */
const enqueueViaCityInterest = (domain: CommerceDomain, email: string) => {
  domain.registerCityInterest({ email, city: "novosibirsk" });
};

afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

describe("enqueueEmail creates a message and attempt #1 atomically", () => {
  it("creates exactly one attempt for a new message", () => {
    const { db, domain } = fixture();
    db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED'").run();
    enqueueViaCityInterest(domain, "atomic@example.test");
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
    domain.patchOccurrence(occurrenceId, { visibility: "PUBLISHED", reason: "publish" }, randomUUID(), "admin");

    const outbox = db.prepare("SELECT id, provider_idempotence_key FROM email_outbox").get() as { id: string; provider_idempotence_key: string };
    const attempts = db.prepare("SELECT message_id, attempt_no, provider_idempotence_key, outcome FROM outbox_attempt").all();
    expect(attempts).toEqual([{
      message_id: outbox.id, attempt_no: 1,
      provider_idempotence_key: outbox.provider_idempotence_key, outcome: null,
    }]);
  });

  it("copies one minted key into both stores, byte for byte", () => {
    // Two independently generated keys would be two logical requests at the
    // provider the moment authority moves.
    const { db, domain } = fixture();
    db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED'").run();
    enqueueViaCityInterest(domain, "keys@example.test");
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;
    domain.patchOccurrence(occurrenceId, { visibility: "PUBLISHED", reason: "publish" }, randomUUID(), "admin");

    const pair = db.prepare(`SELECT o.provider_idempotence_key AS message_key, a.provider_idempotence_key AS attempt_key
      FROM email_outbox o JOIN outbox_attempt a ON a.message_id = o.id`).get();
    expect(pair).toMatchObject({ message_key: expect.any(String) });
    expect((pair as { message_key: string; attempt_key: string }).attempt_key)
      .toBe((pair as { message_key: string }).message_key);
  });

  it("leaves no message behind when the attempt insert fails", () => {
    // The load-bearing test. A trigger breaks the attempt insert; if the
    // message insert were not in the same transaction, a message with no
    // attempt would survive - the exact state the design says cannot exist.
    const { db, domain } = fixture();
    const before = (db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get() as { n: number }).n;

    db.exec(`CREATE TRIGGER test_break_attempt_insert BEFORE INSERT ON outbox_attempt
      BEGIN SELECT RAISE(ABORT, 'INJECTED_ATTEMPT_FAILURE'); END`);

    expect(() => enqueueViaCityInterest(domain, "rollback@example.test")).toThrow(/INJECTED_ATTEMPT_FAILURE/);

    expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get()).toEqual({ n: before });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 0 });
    // The whole business operation is undone too, not merely the outbox rows.
    expect(db.prepare("SELECT COUNT(*) AS n FROM city_interest_requests WHERE email_normalized = ?").get("rollback@example.test"))
      .toEqual({ n: 0 });
  });

  it("joins a transactional caller instead of nesting a transaction", () => {
    // enqueueEmail is reached from callers that already hold a transaction -
    // patchOccurrence is one - and from bare sweep paths. Opening a nested
    // transaction would throw, so the join branch is what makes atomicity a
    // property rather than a caller convention.
    const { db, domain } = fixture();
    db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED'").run();
    enqueueViaCityInterest(domain, "joined@example.test");
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;

    expect(() => domain.patchOccurrence(occurrenceId, { visibility: "PUBLISHED", reason: "publish" }, randomUUID(), "admin")).not.toThrow();
    expect(db.inTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 1 });
  });

  it("rolls a transactional caller back entirely when the attempt fails", () => {
    // The same guarantee on the join branch: the message, the attempt and the
    // caller's own business write all disappear together.
    const { db, domain } = fixture();
    db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED'").run();
    enqueueViaCityInterest(domain, "joined-fail@example.test");
    const occurrenceId = (db.prepare("SELECT id FROM occurrences").get() as { id: string }).id;

    db.exec(`CREATE TRIGGER test_break_attempt_insert BEFORE INSERT ON outbox_attempt
      BEGIN SELECT RAISE(ABORT, 'INJECTED_ATTEMPT_FAILURE'); END`);

    expect(() => domain.patchOccurrence(occurrenceId, { visibility: "PUBLISHED", reason: "publish" }, randomUUID(), "admin"))
      .toThrow(/INJECTED_ATTEMPT_FAILURE/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 0 });
    // The occurrence stayed hidden: the caller's write rolled back too.
    expect(db.prepare("SELECT visibility FROM occurrences WHERE id = ?").get(occurrenceId)).toEqual({ visibility: "HIDDEN" });
  });

  it("does not activate attempt authority by creating attempts", () => {
    // Attempt #1 exists in both authority states; it is a shadow until the
    // activation CAS adopts it. Creating one must not imply anything about
    // which store is authoritative.
    const { db, domain } = fixture();
    db.prepare("UPDATE occurrences SET visibility = 'HIDDEN', sales_status = 'CLOSED'").run();
    enqueueViaCityInterest(domain, "dormant@example.test");
    expect(db.prepare("SELECT attempt_authority FROM outbox_authority WHERE singleton = 1").get())
      .toEqual({ attempt_authority: "LEGACY" });
  });
});
