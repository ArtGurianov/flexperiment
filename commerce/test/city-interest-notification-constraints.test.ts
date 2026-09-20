import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";

/**
 * Constraints of the live schema that keep a city-interest notification from
 * being sent twice.
 *
 * They carry no `RAISE` name, so a census of named guards cannot see them, and
 * they were asserted only inside the migration test that introduced the table.
 * The partial uniqueness is the whole mechanism: one active intent per request
 * and one intent per outbox message, with supersession as the only way to make
 * room for another.
 */
const open: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (open.length) open.pop()?.close(); });

const seeded = () => {
  const db = openDatabase(":memory:");
  open.push(db);
  migrate(db);
  const cityId = randomUUID();
  db.prepare("INSERT OR IGNORE INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'Notification constraints', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Europe/Moscow', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`)
    .run(occurrenceId, cityId);

  const request = (email: string, id = randomUUID()) => {
    db.prepare(`INSERT INTO occurrence_notification_requests(id, email_normalized, email_hash, occurrence_id,
      privacy_policy_version, privacy_policy_sha256, pd_consent_version, pd_consent_sha256, consent_accepted_at)
      VALUES (?, ?, ?, ?, 'privacy-v1', ?, 'pd-v1', ?, '2030-01-01T00:00:00.000Z')`)
      .run(id, email, `${email}-hash`, occurrenceId, "a".repeat(64), "b".repeat(64));
    return id;
  };
  const outbox = (email: string, id = randomUUID()) => {
    db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, provider_idempotence_key)
      VALUES (?, 'OCCURRENCE_AVAILABLE', ?, ?, 'occurrence-available', '{}', ?)`)
      .run(id, email, `${email}-hash`, `key-${id}`);
    return id;
  };
  const intent = (requestId: string, outboxId: string, id = randomUUID()) =>
    db.prepare("INSERT INTO occurrence_notification_intents(id, notification_request_id, outbox_id) VALUES (?, ?, ?)").run(id, requestId, outboxId);

  return { db, occurrenceId, request, outbox, intent };
};

describe("one notification per interested person, per occurrence", () => {
  it("refuses a second active request for the same person and occurrence", () => {
    const { db, request } = seeded();
    request("person@example.test");
    expect(() => request("person@example.test")).toThrow(/UNIQUE constraint failed/);
    void db;
  });

  it("refuses a second active intent for one request", () => {
    // Two intents means two messages for one person's one interest.
    const { request, outbox, intent } = seeded();
    const requestId = request("person@example.test");
    intent(requestId, outbox("person@example.test"));

    expect(() => intent(requestId, outbox("person@example.test", randomUUID())))
      .toThrow(/UNIQUE constraint failed: occurrence_notification_intents.notification_request_id/);
  });

  it("refuses two intents pointing at one outbox message", () => {
    // The other direction: one message cannot discharge two people's interest.
    const { request, outbox, intent } = seeded();
    const outboxId = outbox("person@example.test");
    intent(request("person@example.test"), outboxId);

    expect(() => intent(request("second@example.test"), outboxId))
      .toThrow(/UNIQUE constraint failed: occurrence_notification_intents.outbox_id/);
  });

  it("lets a superseded intent make room for its successor", () => {
    // Supersession is the only way a second intent becomes legal, which is
    // what makes the uniqueness a rule rather than a dead end.
    const { db, request, outbox, intent } = seeded();
    const requestId = request("person@example.test");
    const first = randomUUID();
    intent(requestId, outbox("person@example.test"), first);
    db.prepare("UPDATE occurrence_notification_intents SET superseded_at = '2030-01-01T00:01:00.000Z' WHERE id = ?").run(first);

    expect(() => intent(requestId, outbox("person@example.test", randomUUID()))).not.toThrow();
  });
});
