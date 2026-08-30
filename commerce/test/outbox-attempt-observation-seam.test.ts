import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyProviderObservation } from "../src/outbox-attempt-store";

/**
 * Seam 5 of 5: provider observation, and the activation race.
 *
 * INVENTORY, before conversion:
 *
 *   READS     only external evidence plus message status and suppressed_at.
 *             No attempt-fact reader, so no reader defect here.
 *
 *   ORDERING  the message guard gates the attempt - the OPPOSITE of seams 2 and
 *             3. There, settlement was a fact about our own send and the
 *             message was its projection. Here the observation is evidence
 *             about the message's lifecycle, and the guard decides whether it
 *             applies at all; a spam callback after DELIVERED is rejected and
 *             must not settle anything on its way past.
 *
 * This is the writer that races the activation CAS: it runs in the API process
 * from a provider callback and continues while dispatch is fenced.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const LEGACY_ATTEMPT_COLUMNS = [
  "provider_idempotence_key", "job_id", "lease_owner", "lease_expires_at", "send_started_at",
  "provider_request_started_at", "attempts", "last_error", "provider_error_code",
  "provider_error_message", "next_attempt_at",
] as const;

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "observation-template-")), "t.sqlite");
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
const TS = "2026-08-30T00:00:00.000Z";

/** Two independent connections to one on-disk database. */
const fixture = ({ authority, status = "ACCEPTED", legacy }: { authority: "LEGACY" | "ATTEMPT"; status?: string; legacy?: string }) => {
  const file = join(mkdtempSync(join(tmpdir(), "observation-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  const callback = new Database(file);
  callback.pragma("foreign_keys = ON");
  open.push(db, callback);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts, job_id)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', ?, 'shared-key', 1, 'job-1')`).run(status);
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, provider_job_id, lease_owner)
    VALUES ('a1', 'm1', 1, 'shared-key', 'job-1', 'w1')`).run();
  if (legacy) db.exec(legacy);
  if (authority === "ATTEMPT") db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
  return { db, callback };
};

const legacyFacts = (db: Database.Database) =>
  db.prepare(`SELECT ${LEGACY_ATTEMPT_COLUMNS.join(", ")} FROM email_outbox WHERE id = 'm1'`).get();
const message = (db: Database.Database) =>
  db.prepare("SELECT status, delivery_outcome, delivered_at, bounced_at FROM email_outbox WHERE id = 'm1'").get();
const attempt = (db: Database.Database, id = "a1") =>
  db.prepare("SELECT outcome, provider_job_id, lease_owner FROM outbox_attempt WHERE id = ?").get(id);
const tx = <T>(d: Database.Database, fn: () => T) => d.transaction(fn).immediate();

afterEach(() => { while (open.length) open.pop()!.close(); });

describe("observation seam", () => {
  describe("under LEGACY", () => {
    it("applies delivery to the message and leaves the shadow attempt alone", () => {
      const { db } = fixture({ authority: "LEGACY" });
      const before = attempt(db);
      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED", jobId: "job-1" }, TS));
      expect(message(db)).toMatchObject({ status: "DELIVERED", delivered_at: TS });
      expect(attempt(db)).toEqual(before);
    });
  });

  describe("under ATTEMPT", () => {
    it("settles an unsettled attempt ACCEPTED on positive evidence, touching no legacy column", () => {
      // The lost-acceptance case: the first positive evidence is a later
      // provider event, and it may settle a still-unsettled attempt.
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      const legacyBefore = legacyFacts(db);
      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED", jobId: "job-1" }, TS));

      expect(message(db)).toMatchObject({ status: "DELIVERED", delivered_at: TS });
      expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED", lease_owner: null });
      expect(legacyFacts(db)).toEqual(legacyBefore);
    });

    it("never rewrites a settled attempt when a bounce arrives later", () => {
      const { db } = fixture({ authority: "ATTEMPT" });
      db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED', lease_owner = NULL WHERE id = 'a1'");
      tx(db, () => applyProviderObservation(db, "m1", { status: "BOUNCED", jobId: "job-1" }, TS));

      expect(message(db)).toMatchObject({ status: "BOUNCED", bounced_at: TS });
      expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED" });
    });

    it("settles KNOWN_FAILED on received refusal", () => {
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      tx(db, () => applyProviderObservation(db, "m1", { status: "FAILED", jobId: "job-1" }, TS));
      expect(message(db)).toMatchObject({ status: "FAILED", delivery_outcome: "KNOWN_FAILED" });
      expect(attempt(db)).toMatchObject({ outcome: "KNOWN_FAILED" });
    });

    it("rejects a spam callback after delivery without settling anything", () => {
      // The message guard decides whether the evidence applies. It must not
      // settle an attempt on its way past a rejection.
      const { db } = fixture({ authority: "ATTEMPT", status: "DELIVERED" });
      const before = attempt(db);
      expect(tx(db, () => applyProviderObservation(db, "m1", { status: "BOUNCED", jobId: "job-1" }, TS))).toBe(false);
      expect((message(db) as { status: string }).status).toBe("DELIVERED");
      expect(attempt(db)).toEqual(before);
    });

    it("settles nothing when a job id is supplied but matches no attempt", () => {
      // The dangerous branch, and the one the earlier test missed: it covered a
      // successful exact match only. Falling back to the current attempt would
      // settle whatever is in flight on the strength of someone else's job id.
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, provider_job_id)
        VALUES ('a2', 'm1', 2, 'resend-key', 'job-2')`).run();

      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED", jobId: "foreign-job" }, TS));

      expect(attempt(db, "a1")).toMatchObject({ outcome: "KNOWN_FAILED" });
      expect(attempt(db, "a2")).toMatchObject({ outcome: null });
    });

    it("settles nothing without a job id once the message has more than one attempt", () => {
      // The message is proven, the attempt is not. A settled predecessor is
      // exactly what such an event could belong to.
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'resend-key')`).run();

      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED" }, TS));

      expect(attempt(db, "a2")).toMatchObject({ outcome: null });
    });

    it("still recovers a lost acceptance without a job id on a first send", () => {
      // The fix must not kill this: one attempt in the whole history means the
      // identity is unambiguous even with no job id.
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      db.exec("UPDATE outbox_attempt SET provider_job_id = NULL WHERE id = 'a1'");

      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED" }, TS));

      expect(attempt(db, "a1")).toMatchObject({ outcome: "ACCEPTED" });
    });

    it("uses an identity carried across our own provider call", () => {
      // Our lookups know which attempt they asked about, so a terminal answer
      // without a job id still settles the right one.
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'resend-key')`).run();

      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED" }, TS,
        { authority: "ATTEMPT", attempt_id: "a2" }));

      expect(attempt(db, "a2")).toMatchObject({ outcome: "ACCEPTED" });
    });

    it("settles the attempt the evidence belongs to, not merely the current one", () => {
      // After a resend, a late event for attempt #1's job must not settle
      // attempt #2. "The current attempt" would be the wrong resolution.
      const { db } = fixture({ authority: "ATTEMPT", status: "SENDING" });
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, provider_job_id)
        VALUES ('a2', 'm1', 2, 'resend-key', 'job-2')`).run();

      tx(db, () => applyProviderObservation(db, "m1", { status: "DELIVERED", jobId: "job-1" }, TS));

      expect(attempt(db, "a1")).toMatchObject({ outcome: "KNOWN_FAILED" });
      expect(attempt(db, "a2")).toMatchObject({ outcome: null });
      expect((message(db) as { status: string }).status).toBe("DELIVERED");
    });
  });

  /**
   * The activation race, on two real connections against one on-disk database.
   *
   * This is the argument the whole authority-selector design rests on: a
   * callback either commits its LEGACY projection before activation and is seen
   * by the backfill, or it waits and then observes ATTEMPT. There is no
   * interleaving in which a legacy write lands after the snapshot meant to
   * capture it.
   */
  describe("activation race, both directions", () => {
    const activate = (db: Database.Database) =>
      db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");

    it("callback first: writes LEGACY, and activation sees it", () => {
      const { db, callback } = fixture({ authority: "LEGACY", status: "SENDING" });

      // The callback wins BEGIN IMMEDIATE and commits under LEGACY.
      tx(callback, () => applyProviderObservation(callback, "m1", { status: "SENT", jobId: "job-1" }, TS));

      // Activation then observes the committed legacy fact and can back-fill it.
      tx(db, () => activate(db));

      expect((message(db) as { status: string }).status).toBe("SENT");
      expect(legacyFacts(db)).toMatchObject({ job_id: "job-1", lease_owner: null });
      // The attempt was NOT advanced under LEGACY - activation refreshes it.
      expect(attempt(db)).toMatchObject({ outcome: null, lease_owner: "w1" });
    });

    it("activation first: callback then reads ATTEMPT and leaves legacy untouched", () => {
      const { db, callback } = fixture({ authority: "LEGACY", status: "SENDING" });
      const legacyBefore = legacyFacts(db);

      tx(db, () => activate(db));

      // The callback begins afterwards and must observe the new authority.
      tx(callback, () => applyProviderObservation(callback, "m1", { status: "SENT", jobId: "job-1" }, TS));

      expect((message(db) as { status: string }).status).toBe("SENT");
      expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED", lease_owner: null });
      // Byte-identical: had the callback cached the selector, this would have
      // aborted on the 0040 freeze trigger instead.
      expect(legacyFacts(db)).toEqual(legacyBefore);
    });

    it("does not cache the selector between transactions", () => {
      // The same connection observes both authorities in sequence.
      const { db, callback } = fixture({ authority: "LEGACY", status: "SENDING" });
      tx(callback, () => applyProviderObservation(callback, "m1", { status: "ACCEPTED", jobId: "job-1" }, TS));
      expect(attempt(db)).toMatchObject({ outcome: null });

      tx(db, () => activate(db));
      db.exec("UPDATE email_outbox SET status = 'SENDING' WHERE id = 'm1'");

      tx(callback, () => applyProviderObservation(callback, "m1", { status: "DELIVERED", jobId: "job-1" }, TS));
      expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED" });
    });
  });
});

/**
 * Writer inventory, executable.
 *
 * The runtime conversion is only finished if NO legacy attempt-fact writer
 * remains in the domain. A count kept in a review comment would drift; this
 * fails the moment one comes back.
 */
describe("no legacy attempt-fact writer remains in the domain", () => {
  it("has converted every one", () => {
    const source = readFileSync("commerce/src/domain.ts", "utf8");
    const columns = [
      "provider_idempotence_key", "job_id", "lease_owner", "lease_expires_at", "send_started_at",
      "provider_request_started_at", "attempts", "last_error", "provider_error_code",
      "provider_error_message", "next_attempt_at",
    ];
    const offenders: string[] = [];
    for (const match of source.matchAll(/UPDATE email_outbox\b/g)) {
      const end = source.indexOf("`)", match.index!);
      const statement = source.slice(match.index!, end > 0 ? end : match.index! + 400);
      const touched = columns.filter((column) => new RegExp(`\\b${column}\\s*=`).test(statement));
      if (touched.length) offenders.push(`line ${source.slice(0, match.index!).split("\n").length}: ${touched.join(", ")}`);
    }
    expect(offenders, `unconverted legacy attempt-fact writers:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
