import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  deferAmbiguousObservation, deferAmbiguousSend, failExhaustedAmbiguous,
  resolveAttemptRef, sendTryCount, staleLeasedSends,
} from "../src/outbox-attempt-store";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";

/**
 * Seam 3 of 5: ambiguity, exhaustion and stale-lease recovery.
 *
 * Two readers live here and neither is protected by any trigger: the try count
 * the exhaustion decision is made against, and the lease scan that finds
 * crashed sends. Under ATTEMPT both live on the attempt, so reading the message
 * would decide wrongly while writing nothing.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const LEGACY_ATTEMPT_COLUMNS = [
  "provider_idempotence_key", "job_id", "lease_owner", "lease_expires_at", "send_started_at",
  "provider_request_started_at", "attempts", "last_error", "provider_error_code",
  "provider_error_message", "next_attempt_at",
] as const;

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "ambiguity-seam-template-")), "t.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

const open: Database.Database[] = [];
const RETRY_AT = "2026-08-30T01:00:00.000Z";

const fixture = ({ authority, legacy }: { authority: "LEGACY" | "ATTEMPT"; legacy?: string }) => {
  const file = join(mkdtempSync(join(tmpdir(), "ambiguity-seam-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'SENDING', 'shared-key', 0)`).run();
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
    VALUES ('a1', 'm1', 1, 'shared-key')`).run();
  if (legacy) db.exec(legacy);
  if (authority === "ATTEMPT") db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
  return db;
};

const legacyFacts = (db: Database.Database) =>
  db.prepare(`SELECT ${LEGACY_ATTEMPT_COLUMNS.join(", ")} FROM email_outbox WHERE id = 'm1'`).get();
const message = (db: Database.Database) =>
  db.prepare("SELECT status, delivery_outcome FROM email_outbox WHERE id = 'm1'").get();
const attempt = (db: Database.Database) =>
  db.prepare("SELECT outcome, next_retry_at, lease_owner, failure_code, reconciliation_exhausted_at FROM outbox_attempt WHERE id = 'a1'").get();
const tx = <T>(db: Database.Database, fn: () => T) => db.transaction(fn).immediate();

afterEach(() => { while (open.length) open.pop()!.close(); });

describe("ambiguity seam", () => {
  describe("exhaustion never settles the attempt", () => {
    it.each([["LEGACY"], ["ATTEMPT"]] as const)("records UNRESOLVED on the message under %s", (authority) => {
      // The whole point of UNRESOLVED: nothing was established. Settling the
      // attempt would make later evidence unable to resolve it, which is the
      // contradiction 0039 was built to remove.
      const db = fixture({ authority, legacy: "UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'" });
      tx(db, () => failExhaustedAmbiguous(db, { id: "m1" }, resolveAttemptRef(db, "m1"), "SEND_UNKNOWN"));

      expect(message(db)).toEqual({ status: "FAILED", delivery_outcome: "UNRESOLVED" });
      expect((attempt(db) as { outcome: string | null }).outcome).toBeNull();
    });

    it("records only that automatic reconciliation stopped, under ATTEMPT", () => {
      const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'" });
      const legacyBefore = legacyFacts(db);
      tx(db, () => failExhaustedAmbiguous(db, { id: "m1" }, resolveAttemptRef(db, "m1"), "SEND_UNKNOWN"));

      expect(attempt(db)).toMatchObject({ outcome: null, lease_owner: null, next_retry_at: null });
      expect((attempt(db) as { reconciliation_exhausted_at: string | null }).reconciliation_exhausted_at).not.toBeNull();
      expect(legacyFacts(db)).toEqual(legacyBefore);
    });
  });

  describe("deferral", () => {
    it("reschedules on the message under LEGACY", () => {
      const db = fixture({ authority: "LEGACY", legacy: "UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'" });
      tx(db, () => deferAmbiguousObservation(db, { id: "m1" }, { authority: "LEGACY" }, RETRY_AT));
      expect(legacyFacts(db)).toMatchObject({ next_attempt_at: RETRY_AT });
      expect((attempt(db) as { next_retry_at: string | null }).next_retry_at).toBeNull();
    });

    it("reschedules on the attempt under ATTEMPT, touching no legacy column", () => {
      const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'" });
      const legacyBefore = legacyFacts(db);
      tx(db, () => deferAmbiguousObservation(db, { id: "m1" }, resolveAttemptRef(db, "m1"), RETRY_AT));
      expect(attempt(db)).toMatchObject({ next_retry_at: RETRY_AT });
      expect(legacyFacts(db)).toEqual(legacyBefore);
    });

    it("returns an ambiguous send to SEND_UNKNOWN under ATTEMPT", () => {
      const db = fixture({ authority: "ATTEMPT" });
      const legacyBefore = legacyFacts(db);
      tx(db, () => deferAmbiguousSend(db, { id: "m1" }, resolveAttemptRef(db, "m1"), RETRY_AT, { supersession: "ANY", requireUnsuppressed: false }));
      expect((message(db) as { status: string }).status).toBe("SEND_UNKNOWN");
      expect(attempt(db)).toMatchObject({ outcome: null, next_retry_at: RETRY_AT, failure_code: "UNISENDER_TRANSPORT_AMBIGUOUS" });
      expect(legacyFacts(db)).toEqual(legacyBefore);
    });
  });

  describe("readers no trigger protects", () => {
    it("counts tries from the attempt under ATTEMPT", () => {
      // Legacy says exhausted, the attempt says one try in. Reading the wrong
      // one abandons a send that has barely started.
      const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET attempts = 99 WHERE id = 'm1'" });
      db.exec("UPDATE outbox_attempt SET send_try_count = 1 WHERE id = 'a1'");
      expect(sendTryCount(db, { id: "m1", attempts: 99 })).toBe(1);
    });

    it("counts tries from the message under LEGACY", () => {
      const db = fixture({ authority: "LEGACY", legacy: "UPDATE email_outbox SET attempts = 4 WHERE id = 'm1'" });
      expect(sendTryCount(db, { id: "m1", attempts: 4 })).toBe(4);
    });

    it("finds stale leases on the attempt under ATTEMPT", () => {
      // The message carries no lease after activation, so scanning it would
      // find nothing and crashed sends would never be recovered - silently.
      const db = fixture({ authority: "ATTEMPT" });
      db.exec("UPDATE outbox_attempt SET lease_owner = 'w1', lease_expires_at = '2026-08-30T00:00:00.000Z', send_try_count = 2 WHERE id = 'a1'");
      const stale = staleLeasedSends(db, "2026-08-30T00:05:00.000Z", false);
      expect(stale).toEqual([{ id: "m1", attempts: 2 }]);
    });

    it("finds stale leases on the message under LEGACY", () => {
      const db = fixture({
        authority: "LEGACY",
        legacy: "UPDATE email_outbox SET lease_owner = 'w1', lease_expires_at = '2026-08-30T00:00:00.000Z', attempts = 2 WHERE id = 'm1'",
      });
      expect(staleLeasedSends(db, "2026-08-30T00:05:00.000Z", false)).toEqual([{ id: "m1", attempts: 2 }]);
    });

    it("does not mistake a live attempt lease for a stale one", () => {
      const db = fixture({ authority: "ATTEMPT" });
      db.exec("UPDATE outbox_attempt SET lease_owner = 'w1', lease_expires_at = '2026-08-30T01:00:00.000Z' WHERE id = 'a1'");
      expect(staleLeasedSends(db, "2026-08-30T00:05:00.000Z", false)).toEqual([]);
    });
  });

  describe("supersession category is revalidated by the write", () => {
    it("refuses to reschedule a superseded send under REQUIRE_UNSUPERSEDED", () => {
      // The scan runs before the per-row transaction, so the write must
      // revalidate its own category. A boolean that checked suppressed_at while
      // being named for superseded_at dropped this entirely.
      const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET superseded_at = '2026-08-30T00:00:00Z', superseded_reason = 'r' WHERE id = 'm1'" });
      tx(db, () => deferAmbiguousSend(db, { id: "m1" }, resolveAttemptRef(db, "m1"), RETRY_AT,
        { supersession: "REQUIRE_UNSUPERSEDED", requireUnsuppressed: true }));
      expect((message(db) as { status: string }).status).toBe("SENDING");
    });

    it("acts on a superseded send under REQUIRE_SUPERSEDED, without rescheduling it", () => {
      // Supersession is the permanent no-retry guard, so no retry time.
      const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET superseded_at = '2026-08-30T00:00:00Z', superseded_reason = 'r' WHERE id = 'm1'" });
      tx(db, () => deferAmbiguousSend(db, { id: "m1" }, resolveAttemptRef(db, "m1"), null,
        { supersession: "REQUIRE_SUPERSEDED", requireUnsuppressed: true }));
      expect((message(db) as { status: string }).status).toBe("SEND_UNKNOWN");
      expect(attempt(db)).toMatchObject({ next_retry_at: null, outcome: null });
    });

    it("refuses an unsuperseded send under REQUIRE_SUPERSEDED", () => {
      const db = fixture({ authority: "ATTEMPT" });
      tx(db, () => deferAmbiguousSend(db, { id: "m1" }, resolveAttemptRef(db, "m1"), null,
        { supersession: "REQUIRE_SUPERSEDED", requireUnsuppressed: true }));
      expect((message(db) as { status: string }).status).toBe("SENDING");
    });
  });

  describe("a stale carried ref moves nothing at all", () => {
    // Seam 2's ordering lesson, applied to the projecting helpers: validity is
    // established before ANY message mutation, so a settled predecessor cannot
    // move the message while its successor goes untouched.
    const withSuccessor = () => {
      const db = fixture({ authority: "ATTEMPT" });
      const stale = tx(db, () => resolveAttemptRef(db, "m1"));
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'resend-key')`).run();
      return { db, stale };
    };

    it("deferAmbiguousSend leaves message and successor untouched", () => {
      const { db, stale } = withSuccessor();
      const before = message(db);
      tx(db, () => deferAmbiguousSend(db, { id: "m1" }, stale, RETRY_AT, { supersession: "ANY", requireUnsuppressed: false }));
      expect(message(db)).toEqual(before);
      expect(db.prepare("SELECT next_retry_at, outcome FROM outbox_attempt WHERE id = 'a2'").get())
        .toEqual({ next_retry_at: null, outcome: null });
    });

    it("failExhaustedAmbiguous leaves message and successor untouched", () => {
      const { db, stale } = withSuccessor();
      const before = message(db);
      tx(db, () => failExhaustedAmbiguous(db, { id: "m1" }, stale, "SENDING"));
      expect(message(db)).toEqual(before);
      expect(db.prepare("SELECT reconciliation_exhausted_at FROM outbox_attempt WHERE id = 'a2'").get())
        .toEqual({ reconciliation_exhausted_at: null });
    });
  });

  describe("carried identity", () => {
    it("applies the resolved attempt, not whatever is current afterwards", () => {
      // Identity is resolved before the provider call. If the current attempt
      // changed in between, evidence for the old one must not land on the new.
      const db = fixture({ authority: "ATTEMPT" });
      const ref = tx(db, () => resolveAttemptRef(db, "m1"));

      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.exec("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'resend-key')`).run();

      tx(db, () => deferAmbiguousObservation(db, { id: "m1" }, ref, RETRY_AT));

      // a1 is settled, so the write finds nothing; a2 is untouched because the
      // carried identity names a1, not "the current attempt".
      expect(db.prepare("SELECT next_retry_at FROM outbox_attempt WHERE id = 'a2'").get()).toEqual({ next_retry_at: null });
    });
  });
});

/**
 * Orchestration seam.
 *
 * The helper tests prove staleLeasedSends and sendTryCount read the right
 * store. They do not prove the sweep and the exhaustion decision CONSUME them -
 * restoring either legacy read would leave every helper test green while
 * production silently stopped recovering crashed sends.
 */
describe("stale recovery consumes authoritative lease and try count", () => {
  const domainFor = (db: Database.Database) => new CommerceDomain(db, new MockProvider());

  it("recovers a crashed send whose lease lives only on the attempt", () => {
    // The message carries no lease under ATTEMPT, so the old scan of
    // email_outbox.lease_expires_at finds nothing at all and this fails.
    const db = fixture({ authority: "ATTEMPT" });
    db.exec(`UPDATE outbox_attempt SET lease_owner = 'w1',
      lease_expires_at = '2000-01-01T00:00:00.000Z', send_try_count = 2 WHERE id = 'a1'`);

    domainFor(db).recoverStaleCommands();

    expect((message(db) as { status: string }).status).toBe("SEND_UNKNOWN");
    expect(attempt(db)).toMatchObject({ outcome: null, lease_owner: null });
    expect((attempt(db) as { next_retry_at: string | null }).next_retry_at).not.toBeNull();
  });

  it("does not exhaust when only the frozen legacy counter is high", () => {
    // legacy 99, attempt 1: reading the message would abandon a send that has
    // barely started, and nothing would fire.
    const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET attempts = 99 WHERE id = 'm1'" });
    db.exec(`UPDATE outbox_attempt SET lease_owner = 'w1',
      lease_expires_at = '2000-01-01T00:00:00.000Z', send_try_count = 1 WHERE id = 'a1'`);

    domainFor(db).recoverStaleCommands();

    expect(message(db)).toEqual({ status: "SEND_UNKNOWN", delivery_outcome: null });
  });

  it("does exhaust when the attempt's own counter is spent", () => {
    const db = fixture({ authority: "ATTEMPT", legacy: "UPDATE email_outbox SET attempts = 1 WHERE id = 'm1'" });
    db.exec(`UPDATE outbox_attempt SET lease_owner = 'w1',
      lease_expires_at = '2000-01-01T00:00:00.000Z', send_try_count = 8 WHERE id = 'a1'`);

    domainFor(db).recoverStaleCommands();

    expect(message(db)).toEqual({ status: "FAILED", delivery_outcome: "UNRESOLVED" });
    expect((attempt(db) as { outcome: string | null }).outcome).toBeNull();
  });
});
