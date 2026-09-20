import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { claimForDispatch, providerLookupIdentity, recordProviderAcceptance, recordProviderRefusal } from "../src/outbox-attempt-store";

/**
 * Seam 2 of 5: provider acceptance, deterministic refusal, and the SEND_UNKNOWN
 * lookup identity.
 *
 * The lookup identity is a READER, and no trigger can protect it. After
 * activation the message's job_id and provider_idempotence_key are frozen
 * compatibility fields, so reconciling under them would ask the provider about
 * the wrong request - or about attempt #1 while attempt #2 is in flight - while
 * writing nothing and firing nothing.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "accept-seam-template-")), "template.sqlite");
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

const fixture = ({ legacy }: { legacy?: string } = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "accept-seam-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, status)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'PENDING')`).run();
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
    VALUES ('a1', 'm1', 1, 'shared-key')`).run();
  return db;
};

const message = (db: Database.Database) =>
  db.prepare("SELECT status, delivery_outcome FROM email_outbox WHERE id = 'm1'").get();
const attempt = (db: Database.Database) =>
  db.prepare("SELECT outcome, provider_job_id, failure_code, failure_detail, lease_owner, completed_at FROM outbox_attempt WHERE id = 'a1'").get();

const claimed = (db: Database.Database) =>
  db.transaction(() => claimForDispatch(db, { id: "m1" }, "worker-1", TS)).immediate()!;

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("acceptance seam", () => {
  describe("attempt authority", () => {
    it("settles the attempt ACCEPTED and touches no legacy column", () => {
      const db = fixture();
      const c = claimed(db);
      db.transaction(() => recordProviderAcceptance(db, { id: "m1" }, c, "job-1")).immediate();

      expect(message(db)).toEqual({ status: "ACCEPTED", delivery_outcome: null });
      expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED", provider_job_id: "job-1", lease_owner: null });
    });

    it("settles the attempt KNOWN_FAILED with canonical failure detail", () => {
      // Canonical JSON, not a concatenated string: this becomes historical
      // evidence and should have exactly one representation.
      const db = fixture();
      const c = claimed(db);
      db.transaction(() => recordProviderRefusal(db, { id: "m1" }, c, { providerCode: "550", providerMessage: "nope" })).immediate();

      expect(message(db)).toEqual({ status: "FAILED", delivery_outcome: "KNOWN_FAILED" });
      expect(attempt(db)).toMatchObject({ outcome: "KNOWN_FAILED", failure_code: "UNISENDER_HTTP_REJECTED" });
      expect(JSON.parse((attempt(db) as { failure_detail: string }).failure_detail))
        .toEqual({ provider_error_code: "550", provider_error_message: "nope" });
    });

    it("settles the attempt even when consent was withdrawn mid-flight", () => {
      // The provider call cannot be recalled, so acceptance of THIS SEND is a
      // fact about the attempt regardless of whether the message may still be
      // delivered. The message is not revived.
      const db = fixture();
      const c = claimed(db);
      db.exec("UPDATE email_outbox SET superseded_at = '2026-08-30T00:00:00Z', superseded_reason = 'withdrawn' WHERE id = 'm1'");

      const accepted = db.transaction(() => recordProviderAcceptance(db, { id: "m1" }, c, "job-1")).immediate();

      // The settlement won; only the message projection refused.
      expect(accepted).toEqual({ attempt_settled: true, message_updated: false });
      expect((message(db) as { status: string }).status).toBe("SENDING");
      expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED", provider_job_id: "job-1" });
    });

    describe("contradictory late settlement is a no-op everywhere", () => {
      // The attempt settlement is the authority CAS and runs FIRST. With the
      // message projected first, a late contradictory settlement moved the
      // message while the attempt refused - leaving message and history
      // disagreeing, which is the split this whole design exists to prevent.
      it("late refusal after acceptance changes neither attempt nor message", () => {
        const db = fixture();
        const c = claimed(db);
        db.transaction(() => recordProviderAcceptance(db, { id: "m1" }, c, "job-1")).immediate();
        db.exec("UPDATE email_outbox SET status = 'SENDING' WHERE id = 'm1'");
        const messageBefore = message(db);
        const attemptBefore = attempt(db);

        const result = db.transaction(() => recordProviderRefusal(db, { id: "m1" }, c, { providerCode: "550", providerMessage: "late" })).immediate();

        expect(result).toEqual({ attempt_settled: false, message_updated: false });
        expect(attempt(db)).toEqual(attemptBefore);
        expect(message(db)).toEqual(messageBefore);
      });

      it("late acceptance after refusal changes neither attempt nor message", () => {
        // The same ordering defect existed on the acceptance path, so the
        // symmetric direction is asserted rather than assumed.
        const db = fixture();
        const c = claimed(db);
        db.transaction(() => recordProviderRefusal(db, { id: "m1" }, c, { providerCode: "550", providerMessage: "nope" })).immediate();
        db.exec("UPDATE email_outbox SET status = 'SENDING', delivery_outcome = NULL WHERE id = 'm1'");
        const messageBefore = message(db);
        const attemptBefore = attempt(db);

        const result = db.transaction(() => recordProviderAcceptance(db, { id: "m1" }, c, "late-job")).immediate();

        expect(result).toEqual({ attempt_settled: false, message_updated: false });
        expect(attempt(db)).toEqual(attemptBefore);
        expect(message(db)).toEqual(messageBefore);
      });
    });
  });

  describe("SEND_UNKNOWN lookup identity", () => {

  });
});
