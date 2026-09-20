import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openUnmigratedTestDatabase } from "./support/test-database";

/**
 * The structural half of "never send a customer the same email twice".
 *
 * These are constraints of the live schema, not facts about the migration that
 * introduced them. They were only asserted through that migration's own test,
 * which meant the strongest protection against a duplicate ticket was guarded
 * by a file whose whole purpose is to stop existing once the ledger collapses.
 * They live here instead, phrased against the schema as it is, so the ledger can
 * go without taking them with it.
 */
const migrations = join(process.cwd(), "commerce", "migrations");
const databases: ReturnType<typeof openUnmigratedTestDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const seeded = () => {
  const db = openUnmigratedTestDatabase();
  databases.push(db);
  for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
    db.transaction(() => db.exec(readFileSync(join(migrations, name), "utf8")))();
  }
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h1', 'tpl', '{}', 'PENDING', 'k1', 0)`).run();
  return db;
};

const insertAttempt = (db: ReturnType<typeof seeded>, id: string, no: number, outcome: string | null) =>
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, outcome)
    VALUES (?, 'm1', ?, ?, ?)`).run(id, no, `key-${id}`, outcome);

describe("outbox attempt constraints", () => {
  it("requires a message that exists", () => {
    const db = seeded();
    expect(() => db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
      VALUES ('a1', 'nope', 1, 'k')`).run()).toThrow(/FOREIGN KEY/);
  });

  it("permits at most one unsettled attempt per message", () => {
    // The structural half of "no resend beside an unresolved send".
    const db = seeded();
    insertAttempt(db, "a1", 1, null);
    expect(() => insertAttempt(db, "a2", 2, null)).toThrow(/UNIQUE constraint failed/);
  });

  it("permits a new attempt once the previous one has settled", () => {
    const db = seeded();
    insertAttempt(db, "a1", 1, "KNOWN_FAILED");
    expect(() => insertAttempt(db, "a2", 2, null)).not.toThrow();
  });

  it("refuses a duplicate attempt number", () => {
    const db = seeded();
    insertAttempt(db, "a1", 1, "KNOWN_FAILED");
    expect(() => insertAttempt(db, "a2", 1, "ACCEPTED")).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a reused provider key across attempts", () => {
    const db = seeded();
    insertAttempt(db, "a1", 1, "KNOWN_FAILED");
    expect(() => db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, outcome)
      VALUES ('a2', 'm1', 2, 'key-a1', NULL)`).run()).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses UNRESOLVED as an attempt outcome", () => {
    // Ambiguity is message-level. A terminal UNRESOLVED could never be settled
    // by later evidence.
    const db = seeded();
    expect(() => insertAttempt(db, "a1", 1, "UNRESOLVED")).toThrow(/CHECK constraint failed/);
  });

  describe("attempt identity is immutable from creation", () => {
    // The unique constraint proves a key is unused by another attempt; it does
    // not prove this attempt still carries the key its provider request was
    // made under. Rewriting it mid-ambiguity turns a retry into a different
    // logical request at the provider - a second email.
    it.each([
      ["provider_idempotence_key", "provider_idempotence_key = 'key-rewritten'"],
      ["attempt_no", "attempt_no = 2"],
      ["id", "id = 'a-renamed'"],
      ["requested_at", "requested_at = '2030-01-01T00:00:00Z'"],
    ])("refuses to change %s while the attempt is unsettled", (_field, assignment) => {
      const db = seeded();
      insertAttempt(db, "a1", 1, null);
      expect(() => db.exec(`UPDATE outbox_attempt SET ${assignment} WHERE id = 'a1'`))
        .toThrow(/OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE/);
    });

    it("refuses to reparent the attempt to another message", () => {
      // Separate from the table-driven cases because it needs a second real
      // message: `IS NOT` compares values, so "changing" message_id to its own
      // value is not a change at all.
      const db = seeded();
      db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
        payload_snapshot, status, provider_idempotence_key, attempts)
        VALUES ('m2', 'TEST', 'b@c.invalid', 'h2', 'tpl', '{}', 'PENDING', 'k2', 0)`).run();
      insertAttempt(db, "a1", 1, null);
      expect(() => db.exec("UPDATE outbox_attempt SET message_id = 'm2' WHERE id = 'a1'"))
        .toThrow(/OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE/);
    });

    it("still allows progress on an unsettled attempt", () => {
      // The guard must not freeze the row it is protecting: retry state and
      // lease movement are exactly what happens while a send is ambiguous.
      const db = seeded();
      insertAttempt(db, "a1", 1, null);
      expect(() => db.exec(`UPDATE outbox_attempt SET send_try_count = send_try_count + 1,
        lease_owner = 'w1', lease_expires_at = '2026-08-30T00:02:00Z',
        next_retry_at = '2026-08-30T00:05:00Z', provider_job_id = 'j1',
        started_at = '2026-08-30T00:00:00Z', reconciliation_exhausted_at = NULL
        WHERE id = 'a1'`)).not.toThrow();
    });

    it("still allows the attempt to settle", () => {
      const db = seeded();
      insertAttempt(db, "a1", 1, null);
      expect(() => db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED', completed_at = '2026-08-30T00:01:00Z' WHERE id = 'a1'")).not.toThrow();
    });

    it("keeps the key immutable after settlement too", () => {
      const db = seeded();
      insertAttempt(db, "a1", 1, "ACCEPTED");
      // Either guard may fire first - SQLite does not order same-event
      // triggers - so this asserts the refusal, not which one refused.
      expect(() => db.exec("UPDATE outbox_attempt SET provider_idempotence_key = 'key-rewritten' WHERE id = 'a1'"))
        .toThrow(/OUTBOX_ATTEMPT_(IDENTITY|SETTLED)_IMMUTABLE/);
    });
  });

  it("lets an unsettled attempt be settled, once", () => {
    const db = seeded();
    insertAttempt(db, "a1", 1, null);
    expect(() => db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED' WHERE id = 'a1'")).not.toThrow();
    expect(() => db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'"))
      .toThrow(/OUTBOX_ATTEMPT_SETTLED_IMMUTABLE/);
  });

  it("freezes every field of a settled attempt, not only its outcome", () => {
    const db = seeded();
    insertAttempt(db, "a1", 1, "ACCEPTED");
    expect(() => db.exec("UPDATE outbox_attempt SET failure_detail = 'rewriting history' WHERE id = 'a1'"))
      .toThrow(/OUTBOX_ATTEMPT_SETTLED_IMMUTABLE/);
  });

  describe("history cannot be discarded", () => {
    it("refuses a direct delete while the message exists", () => {
      // Without this the database proved only that two unsettled attempts
      // cannot coexist. Deleting an unresolved attempt frees the partial unique
      // slot, and a resend could then be inserted beside a send whose outcome
      // was never established.
      const db = seeded();
      insertAttempt(db, "a1", 1, null);
      expect(() => db.exec("DELETE FROM outbox_attempt WHERE id = 'a1'"))
        .toThrow(/OUTBOX_ATTEMPT_DELETE_FORBIDDEN/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt WHERE id = 'a1'").get()).toEqual({ n: 1 });
    });

    it("refuses a direct delete of settled history too", () => {
      // "Immutable" must not mean "cannot be edited, may be erased".
      const db = seeded();
      insertAttempt(db, "a1", 1, "ACCEPTED");
      expect(() => db.exec("DELETE FROM outbox_attempt WHERE id = 'a1'"))
        .toThrow(/OUTBOX_ATTEMPT_DELETE_FORBIDDEN/);
    });

    it("still lets a purged message take its attempts with it", () => {
      // The WHEN clause is what permits this: the parent row is gone before the
      // cascade reaches its attempts, so the guard stands aside. Consent purges
      // must keep working.
      const db = seeded();
      insertAttempt(db, "a1", 1, "ACCEPTED");
      expect(() => db.exec("DELETE FROM email_outbox WHERE id = 'm1'")).not.toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 0 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
