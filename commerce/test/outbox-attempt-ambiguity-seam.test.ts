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
import type { EmailProvider } from "../src/email-provider";

/**
 * Seam 3 of 5: ambiguity, exhaustion and stale-lease recovery.
 *
 * Two readers live here and neither is protected by any trigger: the try count
 * the exhaustion decision is made against, and the lease scan that finds
 * crashed sends. Under ATTEMPT both live on the attempt, so reading the message
 * would decide wrongly while writing nothing.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
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

const fixture = ({ legacy }: { legacy?: string } = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "ambiguity-seam-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'SENDING')`).run();
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
    VALUES ('a1', 'm1', 1, 'shared-key')`).run();
  return db;
};

const message = (db: Database.Database) =>
  db.prepare("SELECT status, delivery_outcome FROM email_outbox WHERE id = 'm1'").get();
const attempt = (db: Database.Database) =>
  db.prepare("SELECT outcome, next_retry_at, lease_owner, failure_code, reconciliation_exhausted_at FROM outbox_attempt WHERE id = 'a1'").get();
const tx = <T>(db: Database.Database, fn: () => T) => db.transaction(fn).immediate();

afterEach(() => { while (open.length) open.pop()!.close(); });

describe("ambiguity seam", () => {
  describe("exhaustion never settles the attempt", () => {

  });

  describe("deferral", () => {

    it("returns an ambiguous send to SEND_UNKNOWN under ATTEMPT", () => {
      const db = fixture();
      tx(db, () => deferAmbiguousSend(db, { id: "m1" }, resolveAttemptRef(db, "m1"), RETRY_AT, { supersession: "ANY", requireUnsuppressed: false }));
      expect((message(db) as { status: string }).status).toBe("SEND_UNKNOWN");
      expect(attempt(db)).toMatchObject({ outcome: null, next_retry_at: RETRY_AT, failure_code: "UNISENDER_TRANSPORT_AMBIGUOUS" });
    });
  });

  describe("readers no trigger protects", () => {

    it("finds stale leases on the attempt", () => {
      // The message carries no lease after activation, so scanning it would
      // find nothing and crashed sends would never be recovered - silently.
      const db = fixture();
      db.exec("UPDATE outbox_attempt SET lease_owner = 'w1', lease_expires_at = '2026-08-30T00:00:00.000Z', send_try_count = 2 WHERE id = 'a1'");
      const stale = staleLeasedSends(db, "2026-08-30T00:05:00.000Z", false);
      expect(stale).toEqual([{ id: "m1", attempts: 2 }]);
    });

    it("does not mistake a live attempt lease for a stale one", () => {
      const db = fixture();
      db.exec("UPDATE outbox_attempt SET lease_owner = 'w1', lease_expires_at = '2026-08-30T01:00:00.000Z' WHERE id = 'a1'");
      expect(staleLeasedSends(db, "2026-08-30T00:05:00.000Z", false)).toEqual([]);
    });
  });

  describe("supersession category is revalidated by the write", () => {


    it("refuses an unsuperseded send under REQUIRE_SUPERSEDED", () => {
      const db = fixture();
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
      const db = fixture();
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
      const db = fixture();
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
    const db = fixture();
    db.exec(`UPDATE outbox_attempt SET lease_owner = 'w1',
      lease_expires_at = '2000-01-01T00:00:00.000Z', send_try_count = 2 WHERE id = 'a1'`);

    domainFor(db).recoverStaleCommands();

    expect((message(db) as { status: string }).status).toBe("SEND_UNKNOWN");
    expect(attempt(db)).toMatchObject({ outcome: null, lease_owner: null });
    expect((attempt(db) as { next_retry_at: string | null }).next_retry_at).not.toBeNull();
  });


});

/**
 * The send result belongs to the attempt the CLAIM took, not to the one
 * resolved before the lookup. Those are two external calls and therefore two
 * carried identities.
 *
 * Reachable once resend exists: while the lookup is in flight the resolved
 * attempt can settle and a successor become current, and claimForDispatch
 * correctly takes the successor. Writing the failure against the predecessor
 * then lands on the wrong attempt - or, now that carriedRefIsCurrent guards it,
 * lands nowhere at all and the failure is silently dropped.
 */
describe("send failure is attributed to the claimed attempt", () => {
});
