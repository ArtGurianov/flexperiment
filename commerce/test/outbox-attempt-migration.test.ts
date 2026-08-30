import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 0041 changes what the authority state space can REPRESENT. It must not change
 * what is currently true.
 *
 * It is applied in STATE B - fence held, LEGACY still authoritative - so the
 * rebuild carries the live control row across untouched, and both 0040 guards
 * must still enforce afterwards. That last part is proven by executing the
 * deployed worker's claim against the rebuilt schema rather than by reading
 * sqlite_master, because the failure mode here is a trigger that exists and
 * points at a table that no longer does.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const BEFORE_0041 = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && n < "0041").sort();
const M0041 = readFileSync(join(MIGRATIONS, "0041_outbox_attempt.sql"), "utf8");
const EPOCH = { release_id: "cutover-0041", generation: 7 };
const open: Database.Database[] = [];

/**
 * Replaying every pre-0041 migration per test was slow enough to trip vitest's
 * 5s default on CI intermittently. The schema is identical each time, so it is
 * built once and the file copied.
 */
const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "outbox-attempt-template-")), "template.sqlite");
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of BEFORE_0041) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  db.close();
  return file;
})();

/** On-disk, so a genuinely separate connection can play the old worker. */
const at0040 = () => {
  const file = join(mkdtempSync(join(tmpdir(), "outbox-attempt-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  const worker = new Database(file);
  worker.pragma("foreign_keys = ON");
  open.push(db, worker);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'PENDING', 'k1', 0)`).run();
  return { db, worker };
};

const apply0041 = (db: Database.Database) => db.exec(M0041);

/** The deployed worker's claim, every predicate reproduced. */
const legacyClaim = (worker: Database.Database) =>
  worker.prepare(`UPDATE email_outbox SET status = 'SENDING', lease_owner = ?, lease_expires_at = datetime('now', '+120 seconds'), send_started_at = COALESCE(send_started_at, ?), provider_request_started_at = ?, next_attempt_at = NULL, attempts = attempts + 1
    WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN')
      AND superseded_at IS NULL
      AND (status = 'PENDING' OR next_attempt_at IS NULL OR next_attempt_at <= ?)`)
    .run("worker-legacy", "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "m1", "2026-08-30T00:00:00.000Z");

const fence = (db: Database.Database) => {
  db.prepare(`UPDATE outbox_authority SET email_dispatch_paused = 1,
    dispatch_owner_release_id = ?, dispatch_owner_generation = ?, revision = revision + 1
    WHERE singleton = 1`).run(EPOCH.release_id, EPOCH.generation);
  db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision)
    VALUES ('e-fence', 'DISPATCH_FENCED', ?, ?, 'cutover', 2)`).run(EPOCH.release_id, EPOCH.generation);
};

const control = (db: Database.Database) => db.prepare("SELECT * FROM outbox_authority WHERE singleton = 1").get();

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("0041 outbox attempt migration", () => {
  describe("the control row survives the rebuild", () => {
    it("preserves a HELD fence exactly", () => {
      // The case that matters: 0041 is applied mid-cutover with the fence held.
      // A rebuild that reset to defaults would silently unfence production mail.
      const { db } = at0040();
      fence(db);
      const before = control(db);
      apply0041(db);
      expect(control(db)).toEqual(before);
      expect(before).toMatchObject({
        attempt_authority: "LEGACY", email_dispatch_paused: 1,
        dispatch_owner_release_id: EPOCH.release_id, dispatch_owner_generation: EPOCH.generation, revision: 2,
      });
    });

    it("preserves an open, unowned control row exactly", () => {
      const { db } = at0040();
      const before = control(db);
      apply0041(db);
      expect(control(db)).toEqual(before);
    });

    it("does not activate attempt authority", () => {
      // `0041 applied` and `ATTEMPT authoritative` are independent facts. A
      // migration that activated on application would make rolling convergence
      // a race with old binaries still writing legacy attempt facts.
      const { db } = at0040();
      fence(db);
      apply0041(db);
      expect((control(db) as { attempt_authority: string }).attempt_authority).toBe("LEGACY");
    });

    it("carries the existing audit history across unchanged", () => {
      const { db } = at0040();
      fence(db);
      const before = db.prepare("SELECT * FROM outbox_authority_events ORDER BY revision").all();
      apply0041(db);
      expect(db.prepare("SELECT * FROM outbox_authority_events ORDER BY revision").all()).toEqual(before);
      expect(before).toHaveLength(1);
    });
  });

  describe("both 0040 guards still enforce after the rebuild", () => {
    it("keeps fencing the deployed worker's claim across the migration", () => {
      // The trap 0040 discovered: RENAME rewrites trigger bodies to follow the
      // renamed table, so a rebuild that does not drop and recreate them leaves
      // the fence pointing at a table that no longer exists.
      const { db, worker } = at0040();
      fence(db);
      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);

      apply0041(db);

      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);
      expect(db.prepare("SELECT status, lease_owner, attempts FROM email_outbox WHERE id = 'm1'").get())
        .toMatchObject({ status: "PENDING", lease_owner: null, attempts: 0 });
    });

    it("still lets the claim through when unfenced after the migration", () => {
      // Paired with the above so a permanently-broken trigger cannot pass.
      const { db, worker } = at0040();
      fence(db);
      apply0041(db);
      db.exec("UPDATE outbox_authority SET email_dispatch_paused = 0, dispatch_owner_release_id = NULL, dispatch_owner_generation = NULL WHERE singleton = 1");
      expect(legacyClaim(worker).changes).toBe(1);
    });

    it("freezes legacy attempt columns once authority is activated", () => {
      const { db, worker } = at0040();
      apply0041(db);
      db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
      expect(() => worker.exec("UPDATE email_outbox SET attempts = attempts + 1 WHERE id = 'm1'"))
        .toThrow(/EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN/);
    });

    it("still allows message-level writes once authority is activated", () => {
      const { db, worker } = at0040();
      apply0041(db);
      db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
      expect(() => worker.exec("UPDATE email_outbox SET status = 'FAILED', delivery_outcome = 'KNOWN_FAILED' WHERE id = 'm1'")).not.toThrow();
      expect(() => worker.exec("UPDATE email_outbox SET ops_acknowledged_at = '2026-08-30T00:00:00Z', ops_acknowledged_reason = 'r' WHERE id = 'm1'")).not.toThrow();
    });
  });

  describe("the widened state space", () => {
    it("now admits ATTEMPT, which 0040 forbade", () => {
      const { db } = at0040();
      expect(() => db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1"))
        .toThrow(/CHECK constraint failed/);
      apply0041(db);
      expect(() => db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1")).not.toThrow();
    });

    it("still refuses a value outside the widened domain", () => {
      const { db } = at0040();
      apply0041(db);
      expect(() => db.exec("UPDATE outbox_authority SET attempt_authority = 'SOMETHING_ELSE' WHERE singleton = 1"))
        .toThrow(/CHECK constraint failed/);
    });

    it("admits an activation audit action, which 0040 forbade", () => {
      const { db } = at0040();
      expect(() => db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, reason, revision)
        VALUES ('e0', 'AUTHORITY_ACTIVATED', 'x', 'r', 9)`).run()).toThrow(/CHECK constraint failed/);
      apply0041(db);
      expect(() => db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, reason, revision)
        VALUES ('e1', 'AUTHORITY_ACTIVATED', 'x', 'r', 9)`).run()).not.toThrow();
    });

    it("keeps fenced and owned one fact after the rebuild", () => {
      const { db } = at0040();
      apply0041(db);
      expect(() => db.exec("UPDATE outbox_authority SET email_dispatch_paused = 1 WHERE singleton = 1"))
        .toThrow(/CHECK constraint failed/);
    });
  });

  describe("attempt table invariants", () => {
    const withAttempt = () => {
      const { db, worker } = at0040();
      apply0041(db);
      return { db, worker };
    };
    const insertAttempt = (db: Database.Database, id: string, no: number, outcome: string | null) =>
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, outcome)
        VALUES (?, 'm1', ?, ?, ?)`).run(id, no, "key-" + id, outcome);

    it("requires a message that exists", () => {
      const { db } = withAttempt();
      expect(() => db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key)
        VALUES ('a1', 'nope', 1, 'k')`).run()).toThrow(/FOREIGN KEY/);
    });

    it("permits at most one unsettled attempt per message", () => {
      // The structural half of "no resend beside an unresolved send".
      const { db } = withAttempt();
      insertAttempt(db, "a1", 1, null);
      expect(() => insertAttempt(db, "a2", 2, null)).toThrow(/UNIQUE constraint failed/);
    });

    it("permits a new attempt once the previous one has settled", () => {
      const { db } = withAttempt();
      insertAttempt(db, "a1", 1, "KNOWN_FAILED");
      expect(() => insertAttempt(db, "a2", 2, null)).not.toThrow();
    });

    it("refuses a duplicate attempt number", () => {
      const { db } = withAttempt();
      insertAttempt(db, "a1", 1, "KNOWN_FAILED");
      expect(() => insertAttempt(db, "a2", 1, "ACCEPTED")).toThrow(/UNIQUE constraint failed/);
    });

    it("refuses a reused provider key across attempts", () => {
      const { db } = withAttempt();
      insertAttempt(db, "a1", 1, "KNOWN_FAILED");
      expect(() => db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, outcome)
        VALUES ('a2', 'm1', 2, 'key-a1', NULL)`).run()).toThrow(/UNIQUE constraint failed/);
    });

    it("refuses UNRESOLVED as an attempt outcome", () => {
      // Ambiguity is message-level. A terminal UNRESOLVED could never be
      // settled by later evidence.
      const { db } = withAttempt();
      expect(() => insertAttempt(db, "a1", 1, "UNRESOLVED")).toThrow(/CHECK constraint failed/);
    });

    describe("attempt identity is immutable from creation", () => {
      // The unique constraint proves a key is unused by another attempt; it
      // does not prove this attempt still carries the key its provider request
      // was made under. Rewriting it mid-ambiguity turns a retry into a
      // different logical request at the provider - a second email.
      it.each([
        ["provider_idempotence_key", "provider_idempotence_key = 'key-rewritten'"],
        ["attempt_no", "attempt_no = 2"],

        ["id", "id = 'a-renamed'"],
        ["requested_at", "requested_at = '2030-01-01T00:00:00Z'"],
      ])("refuses to change %s while the attempt is unsettled", (_field, assignment) => {
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, null);
        expect(() => db.exec(`UPDATE outbox_attempt SET ${assignment} WHERE id = 'a1'`))
          .toThrow(/OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE/);
      });

      it("refuses to reparent the attempt to another message", () => {
        // Separate from the table-driven cases because it needs a second real
        // message: `IS NOT` compares values, so "changing" message_id to its
        // own value is not a change at all.
        const { db } = withAttempt();
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
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, null);
        expect(() => db.exec(`UPDATE outbox_attempt SET send_try_count = send_try_count + 1,
          lease_owner = 'w1', lease_expires_at = '2026-08-30T00:02:00Z',
          next_retry_at = '2026-08-30T00:05:00Z', provider_job_id = 'j1',
          started_at = '2026-08-30T00:00:00Z', reconciliation_exhausted_at = NULL
          WHERE id = 'a1'`)).not.toThrow();
      });

      it("still allows the attempt to settle", () => {
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, null);
        expect(() => db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED', completed_at = '2026-08-30T00:01:00Z' WHERE id = 'a1'")).not.toThrow();
      });

      it("keeps the key immutable after settlement too", () => {
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, "ACCEPTED");
        // Either guard may fire first - SQLite does not order same-event
        // triggers - so this asserts the refusal, not which one refused.
        expect(() => db.exec("UPDATE outbox_attempt SET provider_idempotence_key = 'key-rewritten' WHERE id = 'a1'"))
          .toThrow(/OUTBOX_ATTEMPT_(IDENTITY|SETTLED)_IMMUTABLE/);
      });
    });

    it("lets an unsettled attempt be settled, once", () => {
      const { db } = withAttempt();
      insertAttempt(db, "a1", 1, null);
      expect(() => db.exec("UPDATE outbox_attempt SET outcome = 'ACCEPTED' WHERE id = 'a1'")).not.toThrow();
      expect(() => db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'"))
        .toThrow(/OUTBOX_ATTEMPT_SETTLED_IMMUTABLE/);
    });

    it("freezes every field of a settled attempt, not only its outcome", () => {
      const { db } = withAttempt();
      insertAttempt(db, "a1", 1, "ACCEPTED");
      expect(() => db.exec("UPDATE outbox_attempt SET failure_detail = 'rewriting history' WHERE id = 'a1'"))
        .toThrow(/OUTBOX_ATTEMPT_SETTLED_IMMUTABLE/);
    });

    describe("history cannot be discarded", () => {
      it("refuses a direct delete while the message exists", () => {
        // Without this the database proved only that two unsettled attempts
        // cannot coexist. Deleting an unresolved attempt frees the partial
        // unique slot, and a resend could then be inserted beside a send whose
        // outcome was never established.
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, null);
        expect(() => db.exec("UPDATE email_outbox SET status = 'PENDING' WHERE id = 'm1'")).not.toThrow();
        expect(() => db.exec("DELETE FROM outbox_attempt WHERE id = 'a1'"))
          .toThrow(/OUTBOX_ATTEMPT_DELETE_FORBIDDEN/);
        expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt WHERE id = 'a1'").get()).toEqual({ n: 1 });
      });

      it("refuses a direct delete of settled history too", () => {
        // "Immutable" must not mean "cannot be edited, may be erased".
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, "ACCEPTED");
        expect(() => db.exec("DELETE FROM outbox_attempt WHERE id = 'a1'"))
          .toThrow(/OUTBOX_ATTEMPT_DELETE_FORBIDDEN/);
      });

      it("still lets a purged message take its attempts with it", () => {
        // The WHEN clause is what permits this: the parent row is gone before
        // the cascade reaches its attempts, so the guard stands aside. Consent
        // purges must keep working.
        const { db } = withAttempt();
        insertAttempt(db, "a1", 1, "ACCEPTED");
        expect(() => db.exec("DELETE FROM email_outbox WHERE id = 'm1'")).not.toThrow();
        expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 0 });
        expect(db.pragma("foreign_key_check")).toEqual([]);
      });

      it("cascades regardless of the recursive_triggers setting", () => {
        // Verified for both values: a future pragma change must not turn a
        // consent purge into a blocked delete.
        for (const recursive of [0, 1]) {
          const { db } = withAttempt();
          db.pragma(`recursive_triggers = ${recursive}`);
          insertAttempt(db, "a1", 1, "ACCEPTED");
          expect(() => db.exec("DELETE FROM email_outbox WHERE id = 'm1'"), `recursive_triggers=${recursive}`).not.toThrow();
          expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 0 });
        }
      });
    });
  });
});
