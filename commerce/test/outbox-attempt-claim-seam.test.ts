import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { claimForDispatch, requireUnsettledAttempt } from "../src/outbox-attempt-store";

/**
 * Seam 1 of 5: claim / lease / start.
 *
 * Every logical transition is run twice from the same starting fixture:
 *
 *   LEGACY    legacy columns change, the shadow attempt does NOT
 *   ATTEMPT   the attempt changes, legacy attempt columns are byte-identical,
 *             and message-level facts change where appropriate
 *
 * The second assertion is the one that matters. "The attempt row looks right"
 * is insufficient if the code also quietly updates legacy columns - and the
 * 0040 freeze trigger is the oracle for that: a forgotten ATTEMPT branch aborts
 * with EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN rather than passing.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const LEGACY_ATTEMPT_COLUMNS = [
  "provider_idempotence_key", "job_id", "lease_owner", "lease_expires_at", "send_started_at",
  "provider_request_started_at", "attempts", "last_error", "provider_error_code",
  "provider_error_message", "next_attempt_at",
] as const;

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "claim-seam-template-")), "template.sqlite");
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

const fixture = ({ authority }: { authority: "LEGACY" | "ATTEMPT" }) => {
  const file = join(mkdtempSync(join(tmpdir(), "claim-seam-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'PENDING', 'shared-key', 0)`).run();
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
    VALUES ('a1', 'm1', 1, 'shared-key')`).run();
  if (authority === "ATTEMPT") db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
  return db;
};

const legacyAttemptFacts = (db: Database.Database) =>
  db.prepare(`SELECT ${LEGACY_ATTEMPT_COLUMNS.join(", ")} FROM email_outbox WHERE id = 'm1'`).get();
const messageStatus = (db: Database.Database) =>
  (db.prepare("SELECT status FROM email_outbox WHERE id = 'm1'").get() as { status: string }).status;
const attempt = (db: Database.Database) =>
  db.prepare("SELECT attempt_no, provider_idempotence_key, lease_owner, lease_expires_at, started_at, provider_request_started_at, send_try_count, next_retry_at, outcome FROM outbox_attempt WHERE id = 'a1'").get();

const claim = (db: Database.Database) =>
  db.transaction(() => claimForDispatch(db, { id: "m1", provider_idempotence_key: "shared-key" }, "worker-1", TS)).immediate();

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("claim seam", () => {
  describe("under LEGACY", () => {
    it("takes the lease on the message and leaves the shadow attempt alone", () => {
      const db = fixture({ authority: "LEGACY" });
      const before = attempt(db);

      const claimed = claim(db);

      expect(messageStatus(db)).toBe("SENDING");
      expect(legacyAttemptFacts(db)).toMatchObject({ lease_owner: "worker-1", attempts: 1, send_started_at: TS });
      // The shadow is not advanced under LEGACY: activation refreshes it from
      // authoritative legacy state. Advancing it here would be dual-write.
      expect(attempt(db)).toEqual(before);
      expect(claimed?.provider_idempotence_key).toBe("shared-key");
    });

    it("refuses a message that is not claimable", () => {
      const db = fixture({ authority: "LEGACY" });
      db.exec("UPDATE email_outbox SET superseded_at = '2026-08-30T00:00:00Z' WHERE id = 'm1'");
      expect(claim(db)).toBeUndefined();
      expect(messageStatus(db)).toBe("PENDING");
    });
  });

  describe("under ATTEMPT", () => {
    it("moves the message and advances the attempt, touching no legacy column", () => {
      const db = fixture({ authority: "ATTEMPT" });
      const legacyBefore = legacyAttemptFacts(db);

      const claimed = claim(db);

      expect(messageStatus(db)).toBe("SENDING");
      expect(attempt(db)).toMatchObject({
        lease_owner: "worker-1", started_at: TS, provider_request_started_at: TS,
        send_try_count: 1, next_retry_at: null, outcome: null,
      });
      // The decisive assertion: legacy attempt facts byte-identical. Had the
      // ATTEMPT branch touched one, the 0040 freeze trigger would have aborted
      // the transaction instead.
      expect(legacyAttemptFacts(db)).toEqual(legacyBefore);
      expect(claimed).toMatchObject({ attempt_id: "a1", attempt_no: 1, provider_idempotence_key: "shared-key", send_try_count: 1 });
    });

    it("returns the attempt's own key, not the message snapshot", () => {
      // Under LEGACY these coincide, so using the snapshot is accidentally
      // correct for attempt #1 and wrong the moment a resend mints attempt #2.
      const db = fixture({ authority: "ATTEMPT" });
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'resend-key')`).run();
      db.exec("UPDATE email_outbox SET status = 'PENDING' WHERE id = 'm1'");

      expect(claim(db)?.provider_idempotence_key).toBe("resend-key");
      expect((db.prepare("SELECT provider_idempotence_key FROM email_outbox WHERE id = 'm1'").get() as { provider_idempotence_key: string }).provider_idempotence_key)
        .toBe("shared-key");
    });

    it("fails closed when a dispatchable message has no unsettled attempt", () => {
      // Representable, unlike two unsettled attempts, and it means the message
      // and its history disagree. Dispatch must stop rather than fall back to
      // the message-level key.
      const db = fixture({ authority: "ATTEMPT" });
      db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED' WHERE id = 'a1'");
      expect(() => claim(db)).toThrow(/OUTBOX_ATTEMPT_MISSING/);
      expect(messageStatus(db)).toBe("PENDING");
    });

    it("never silently picks between attempts", () => {
      const db = fixture({ authority: "ATTEMPT" });
      expect(() => requireUnsettledAttempt(db, "m1")).not.toThrow();
      // Two unsettled attempts are unrepresentable; the guard exists so that if
      // the index were ever dropped, the runtime refuses rather than chooses.
      expect(() => db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'other-key')`).run()).toThrow(/UNIQUE constraint failed/);
    });

    it("is still stopped by the 0040 dispatch fence", () => {
      // The fence intercepts the message transition, which ATTEMPT keeps
      // performing - so a rogue claim cannot cross the provider boundary while
      // dispatch is fenced, in either authority state.
      const db = fixture({ authority: "ATTEMPT" });
      db.exec(`UPDATE outbox_authority SET email_dispatch_paused = 1,
        dispatch_owner_release_id = 'epoch', dispatch_owner_generation = 1 WHERE singleton = 1`);
      expect(() => claim(db)).toThrow(/EMAIL_DISPATCH_PAUSED/);
      expect(attempt(db)).toMatchObject({ lease_owner: null, send_try_count: 0 });
    });
  });
});
