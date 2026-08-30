import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { claimForDispatch, requireUnsettledAttempt } from "../src/outbox-attempt-store";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import type { EmailProvider } from "../src/email-provider";

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

/**
 * `legacy` is written BEFORE authority flips: under ATTEMPT the freeze trigger
 * refuses legacy attempt writes, including a test's own fixture setup. That is
 * the guard working, and it means staleness must be staged first.
 */
const fixture = ({ authority, legacy }: { authority: "LEGACY" | "ATTEMPT"; legacy?: string }) => {
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
  if (legacy) db.exec(legacy);
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
  it.each([["LEGACY"], ["ATTEMPT"]] as const)("refuses to run outside a transaction under %s", (authority) => {
    // Executable, not documentary. The ATTEMPT path moves the message and then
    // requires an attempt; outside a transaction a missing attempt would throw
    // with the message durably left in SENDING.
    const db = fixture({ authority });
    expect(() => claimForDispatch(db, { id: "m1", provider_idempotence_key: "shared-key" }, "worker-1", TS))
      .toThrow(/OUTBOX_ATTEMPT_TRANSACTION_REQUIRED/);
    expect(messageStatus(db)).toBe("PENDING");
    expect(attempt(db)).toMatchObject({ lease_owner: null, send_try_count: 0 });
  });

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
      expect(claimed).toMatchObject({ authority: "LEGACY", attempt_id: null, provider_idempotence_key: "shared-key" });
    });

    it("reports the post-claim try count truthfully", () => {
      // Nothing consumes this yet, which is exactly why a constant here would
      // survive until seam 3 trusted it and produced a silent exhaustion bug.
      const db = fixture({ authority: "LEGACY", legacy: "UPDATE email_outbox SET attempts = 3 WHERE id = 'm1'" });
      const claimed = claim(db);
      expect(claimed).toMatchObject({ authority: "LEGACY", attempt_id: null, send_try_count: 4 });
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
      expect(claimed).toMatchObject({ authority: "ATTEMPT", attempt_id: "a1", attempt_no: 1, provider_idempotence_key: "shared-key", send_try_count: 1 });
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
      // Proves the RUNTIME branch, not the index. Asserting the unique
      // constraint would only re-test the schema; the guard exists for the case
      // where the index is gone, so the index is dropped to reach it.
      const db = fixture({ authority: "ATTEMPT" });
      db.exec("DROP INDEX outbox_attempt_active_unique");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'other-key')`).run();
      expect(() => requireUnsettledAttempt(db, "m1")).toThrow(/OUTBOX_ATTEMPT_AMBIGUOUS/);
      expect(() => claim(db)).toThrow(/OUTBOX_ATTEMPT_AMBIGUOUS/);
      expect(messageStatus(db)).toBe("PENDING");
    });

    it("decides retry eligibility from the attempt, not frozen legacy state", () => {
      // The defect a freeze trigger cannot catch: reading a legacy column
      // writes nothing, so a stale read is silent. Legacy says wait, the
      // attempt says due - the attempt is authoritative.
      const db = fixture({
        authority: "ATTEMPT",
        legacy: `UPDATE email_outbox SET status = 'SEND_UNKNOWN', next_attempt_at = '2026-08-30T15:00:00.000Z' WHERE id = 'm1'`,
      });
      db.exec(`UPDATE outbox_attempt SET next_retry_at = '2026-08-30T14:00:00.000Z' WHERE id = 'a1'`);

      const claimed = db.transaction(() =>
        claimForDispatch(db, { id: "m1", provider_idempotence_key: "shared-key" }, "worker-1", "2026-08-30T14:30:00.000Z")).immediate();

      expect(claimed?.authority).toBe("ATTEMPT");
      expect(messageStatus(db)).toBe("SENDING");
    });

    it("refuses an early retry even when frozen legacy state says it is due", () => {
      const db = fixture({
        authority: "ATTEMPT",
        legacy: `UPDATE email_outbox SET status = 'SEND_UNKNOWN', next_attempt_at = '2026-08-30T14:00:00.000Z' WHERE id = 'm1'`,
      });
      db.exec(`UPDATE outbox_attempt SET next_retry_at = '2026-08-30T15:00:00.000Z' WHERE id = 'a1'`);

      const claimed = db.transaction(() =>
        claimForDispatch(db, { id: "m1", provider_idempotence_key: "shared-key" }, "worker-1", "2026-08-30T14:30:00.000Z")).immediate();

      expect(claimed).toBeUndefined();
      expect(messageStatus(db)).toBe("SEND_UNKNOWN");
    });

    it("reports the post-claim try count truthfully", () => {
      const db = fixture({ authority: "ATTEMPT" });
      db.exec("UPDATE outbox_attempt SET send_try_count = 3 WHERE id = 'a1'");
      expect(claim(db)?.send_try_count).toBe(4);
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

/**
 * Orchestration seam.
 *
 * The tests above prove claimForDispatch and dispatchCandidates. They do not
 * prove that processEmailOutbox actually consumes them: restoring the old
 * legacy-filtering scan in the loop would leave every one of them green while
 * production silently skipped due retries. Same shape as the release-controller
 * gaps - helper correct, orchestration not connected.
 */
describe("processEmailOutbox honours authoritative retry eligibility", () => {
  const NOW = Date.parse("2026-08-30T14:30:00.000Z");

  const dispatchFixture = (legacyNextAttempt: string, attemptNextRetry: string) => {
    const db = fixture({
      authority: "ATTEMPT",
      // Staged before the flip: a SEND_UNKNOWN row with no known provider job,
      // so the pre-claim lookup falls through to the claim rather than the
      // not-yet-converted reconciliation paths deciding the outcome.
      legacy: `UPDATE email_outbox SET status = 'SEND_UNKNOWN', job_id = NULL, attempts = 0,
        next_attempt_at = '${legacyNextAttempt}' WHERE id = 'm1'`,
    });
    db.exec(`UPDATE outbox_attempt SET next_retry_at = '${attemptNextRetry}' WHERE id = 'a1'`);

    const sent: string[] = [];
    const emailProvider: EmailProvider = {
      async send({ idempotencyKey }) { sent.push(idempotencyKey); return { jobId: "job-1" }; },
      async lookup() { return { status: "UNKNOWN" }; },
    };
    return { db, sent, domain: new CommerceDomain(db, new MockProvider(), emailProvider, () => NOW) };
  };

  it("dispatches when the attempt is due and frozen legacy state says wait", async () => {
    // The discriminating case: with the old legacy-filtering scan the row is
    // never a candidate, so send() is never reached and this fails.
    //
    // This asserted a freeze-trigger abort while seam 2 was unconverted, which
    // was the honest expectation then. Seam 2 has landed, so it is now the
    // clean acceptance it was always meant to become.
    const { sent, domain, db } = dispatchFixture("2026-08-30T15:00:00.000Z", "2026-08-30T14:00:00.000Z");
    const legacyBefore = legacyAttemptFacts(db);
    await domain.processEmailOutbox();
    expect(sent, "the row never reached the provider").toEqual(["shared-key"]);
    expect(messageStatus(db)).toBe("ACCEPTED");
    expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED", lease_owner: null });
    expect(legacyAttemptFacts(db)).toEqual(legacyBefore);
  });

  it("does not dispatch when the attempt is not due, whatever legacy state says", async () => {
    const { sent, domain, db } = dispatchFixture("2026-08-30T14:00:00.000Z", "2026-08-30T15:00:00.000Z");
    await domain.processEmailOutbox();
    expect(sent).toEqual([]);
    expect(messageStatus(db)).toBe("SEND_UNKNOWN");
    expect(attempt(db)).toMatchObject({ lease_owner: null, send_try_count: 0 });
  });
});
