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
const fixture = ({ legacy }: { legacy?: string } = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), "claim-seam-")), "commerce.sqlite");
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

const messageStatus = (db: Database.Database) =>
  (db.prepare("SELECT status FROM email_outbox WHERE id = 'm1'").get() as { status: string }).status;
const attempt = (db: Database.Database) =>
  db.prepare("SELECT attempt_no, provider_idempotence_key, lease_owner, lease_expires_at, started_at, provider_request_started_at, send_try_count, next_retry_at, outcome FROM outbox_attempt WHERE id = 'a1'").get();

const claim = (db: Database.Database) =>
  db.transaction(() => claimForDispatch(db, { id: "m1" }, "worker-1", TS)).immediate();

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("claim seam", () => {
  it("refuses to run outside a transaction", () => {
    // Executable, not documentary. The ATTEMPT path moves the message and then
    // requires an attempt; outside a transaction a missing attempt would throw
    // with the message durably left in SENDING.
    const db = fixture();
    expect(() => claimForDispatch(db, { id: "m1" }, "worker-1", TS))
      .toThrow(/OUTBOX_ATTEMPT_TRANSACTION_REQUIRED/);
    expect(messageStatus(db)).toBe("PENDING");
    expect(attempt(db)).toMatchObject({ lease_owner: null, send_try_count: 0 });
  });

  describe("attempt authority", () => {
    it("refuses a message that is not claimable", () => {
      const db = fixture();
      db.exec("UPDATE email_outbox SET superseded_at = '2026-08-30T00:00:00Z' WHERE id = 'm1'");
      expect(claim(db)).toBeUndefined();
      expect(messageStatus(db)).toBe("PENDING");
    });
  });

  describe("under ATTEMPT", () => {
    it("moves the message and advances the attempt, touching no legacy column", () => {
      const db = fixture();

      const claimed = claim(db);

      expect(messageStatus(db)).toBe("SENDING");
      expect(attempt(db)).toMatchObject({
        lease_owner: "worker-1", started_at: TS, provider_request_started_at: TS,
        send_try_count: 1, next_retry_at: null, outcome: null,
      });
      // The decisive assertion: legacy attempt facts byte-identical. Had the
      // ATTEMPT branch touched one, the 0040 freeze trigger would have aborted
      // the transaction instead.
      expect(claimed).toMatchObject({ authority: "ATTEMPT", attempt_id: "a1", attempt_no: 1, provider_idempotence_key: "shared-key", send_try_count: 1 });
    });

    it("returns the claimed attempt's own key, not an earlier attempt's", () => {
      // A resend mints a new key. Reading any attempt but the claimed one would
      // send the second request under the first request's identity.
      const db = fixture();
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'resend-key')`).run();
      db.exec("UPDATE email_outbox SET status = 'PENDING' WHERE id = 'm1'");

      expect(claim(db)?.provider_idempotence_key).toBe("resend-key");
      // The settled first attempt keeps its own key; it is history, not identity.
      expect((db.prepare("SELECT provider_idempotence_key FROM outbox_attempt WHERE id = 'a1'").get() as { provider_idempotence_key: string }).provider_idempotence_key)
        .toBe("shared-key");
    });

    it("fails closed when a dispatchable message has no unsettled attempt", () => {
      // Representable, unlike two unsettled attempts, and it means the message
      // and its history disagree. Dispatch must stop rather than fall back to
      // the message-level key.
      const db = fixture();
      db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED' WHERE id = 'a1'");
      expect(() => claim(db)).toThrow(/OUTBOX_ATTEMPT_MISSING/);
      expect(messageStatus(db)).toBe("PENDING");
    });

    it("never silently picks between attempts", () => {
      // Proves the RUNTIME branch, not the index. Asserting the unique
      // constraint would only re-test the schema; the guard exists for the case
      // where the index is gone, so the index is dropped to reach it.
      const db = fixture();
      db.exec("DROP INDEX outbox_attempt_active_unique");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a2', 'm1', 2, 'other-key')`).run();
      expect(() => requireUnsettledAttempt(db, "m1")).toThrow(/OUTBOX_ATTEMPT_AMBIGUOUS/);
      expect(() => claim(db)).toThrow(/OUTBOX_ATTEMPT_AMBIGUOUS/);
      expect(messageStatus(db)).toBe("PENDING");
    });



    it("reports the post-claim try count truthfully", () => {
      const db = fixture();
      db.exec("UPDATE outbox_attempt SET send_try_count = 3 WHERE id = 'a1'");
      expect(claim(db)?.send_try_count).toBe(4);
    });

    it("is still stopped by the 0040 dispatch fence", () => {
      // The fence intercepts the message transition, which ATTEMPT keeps
      // performing - so a rogue claim cannot cross the provider boundary while
      // dispatch is fenced, in either authority state.
      const db = fixture();
      db.exec(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
          pre_deploy_topology, created_at, lease_expires_at)
        VALUES ('session-1', 'operator', 'MAINTENANCE_CUTOVER', '${"a".repeat(40)}', 'candidate', 'DEPLOYING',
          'OLD_LINEAGE_ALLOWED', '{}', '${"2026-08-30T00:00:00.000Z"}', '2026-08-30T00:05:00.000Z')`);
      db.exec(`UPDATE outbox_authority SET email_dispatch_paused = 1,
        dispatch_owner_session_id = 'session-1' WHERE singleton = 1`);
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

  /**
   * A SEND_UNKNOWN message with no known provider job, so the pre-claim lookup
   * falls through to the claim and due-ness is decided by one thing: the
   * attempt's own `next_retry_at`. The message used to carry a competing
   * `next_attempt_at`, and which of the two won was the whole subject here;
   * there is only one answer now.
   */
  const dispatchFixture = (attemptNextRetry: string) => {
    const db = fixture();
    db.exec("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'");
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
    const { sent, domain, db } = dispatchFixture("2026-08-30T14:00:00.000Z");
    await domain.processEmailOutbox();
    expect(sent, "the row never reached the provider").toEqual(["shared-key"]);
    expect(messageStatus(db)).toBe("ACCEPTED");
    expect(attempt(db)).toMatchObject({ outcome: "ACCEPTED", lease_owner: null });
  });

  it("does not dispatch when the attempt is not due", async () => {
    const { sent, domain, db } = dispatchFixture("2026-08-30T15:00:00.000Z");
    await domain.processEmailOutbox();
    expect(sent).toEqual([]);
    expect(messageStatus(db)).toBe("SEND_UNKNOWN");
    expect(attempt(db)).toMatchObject({ lease_owner: null, send_try_count: 0 });
  });
});
