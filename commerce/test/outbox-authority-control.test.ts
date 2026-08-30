import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  emailDispatchDrained,
  emailDispatchFenced,
  fenceEmailDispatch,
  outboxAuthority,
  unfenceEmailDispatch,
  unknownAppliedMigrations,
} from "../src/outbox-authority";

/**
 * 0040 exists to fence a binary that cannot read its selector.
 *
 * So the proof cannot be about trigger SQL, and cannot run on one connection
 * holding both roles. Every dispatch test below opens a SECOND connection to an
 * on-disk database and executes the claim statement the deployed worker
 * actually runs (domain.ts:2384) - PENDING/SEND_UNKNOWN to SENDING, taking the
 * lease, incrementing attempts - because that is the transition an old worker
 * performs before it reaches the provider.
 *
 * Both directions are proven. A trigger that blocks unconditionally would pass
 * every negative test and be catastrophic, so each fence test is paired with
 * the same statement succeeding once the fence is lifted.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const EPOCH_A = { release_id: "cutover-a", generation: 1 };
const EPOCH_B = { release_id: "cutover-b", generation: 1 };
const open: Database.Database[] = [];

/**
 * Some assertions are about 0040's own state space, which 0041 deliberately
 * widens. Those apply migrations only through 0040; everything about fence
 * behaviour runs against the full current schema, which is the more realistic
 * subject.
 */
const migrateThrough = (file: string, last?: string) => {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql") && (!last || n <= last)).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  return db;
};

/**
 * Replaying every migration per test against an on-disk database took long
 * enough to trip vitest's 5s default on CI - intermittently, which is the worst
 * kind. Each schema is identical every time, so each is built once and the file
 * copied. The timeout stays at 5s: it is a real signal, and raising it to pay
 * for repeated migration replay would spend the signal on the cost.
 */
const templateAt = (last?: string) => {
  const file = join(mkdtempSync(join(tmpdir(), "outbox-authority-template-")), "template.sqlite");
  migrateThrough(file, last).close();
  return file;
};

const template = templateAt();
const template0040 = templateAt("0040_outbox_authority_control.sql");

const copyOf = (source: string, prefix: string) => {
  const file = join(mkdtempSync(join(tmpdir(), prefix)), "commerce.sqlite");
  copyFileSync(source, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  return { file, db };
};

const at0040Only = () => {
  const { db } = copyOf(template0040, "outbox-authority-0040-");
  open.push(db);
  return db;
};

/** An on-disk database, so a genuinely separate connection can be opened. */
const fixture = () => {
  const { file, db: control } = copyOf(template, "outbox-authority-");
  const worker = new Database(file);
  worker.pragma("foreign_keys = ON");
  open.push(control, worker);
  control.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'PENDING', 'k1', 0)`).run();
  return { control, worker };
};

/**
 * The deployed worker's claim (domain.ts:2419), executed by the other
 * connection. Every predicate is reproduced, including `superseded_at IS NULL`
 * and the next_attempt_at clause - a reduced version would match rows the real
 * worker never claims and would prove the trigger against a statement
 * production does not run.
 */
const legacyClaim = (worker: Database.Database) =>
  worker.prepare(`UPDATE email_outbox SET status = 'SENDING', lease_owner = ?, lease_expires_at = datetime('now', '+120 seconds'), send_started_at = COALESCE(send_started_at, ?), provider_request_started_at = ?, next_attempt_at = NULL, attempts = attempts + 1
    WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN')
      AND superseded_at IS NULL
      AND (status = 'PENDING' OR next_attempt_at IS NULL OR next_attempt_at <= ?)`)
    .run("worker-legacy", "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "m1", "2026-08-30T00:00:00.000Z");

const claimFacts = (db: Database.Database) =>
  db.prepare("SELECT status, lease_owner, lease_expires_at, send_started_at, provider_request_started_at, attempts FROM email_outbox WHERE id = 'm1'").get();

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("outbox authority control", () => {
  describe("control row", () => {
    it("starts safe", () => {
      const { control } = fixture();
      expect(outboxAuthority(control)).toEqual({
        attempt_authority: "LEGACY", email_dispatch_paused: false,
        dispatch_owner_release_id: null, dispatch_owner_generation: null, revision: 1,
      });
    });

    it("fails closed for the reader when the control row is missing", () => {
      const { control } = fixture();
      control.exec("DELETE FROM outbox_authority");
      expect(emailDispatchFenced(control)).toBe(true);
    });

    it("fails closed for the OLD BINARY when the control row is missing", () => {
      // The reader failing closed is not the property that matters. A missing
      // row yields NULL, and `NULL = 1` is not true, so a trigger written
      // without COALESCE would fail OPEN for exactly the binary the fence
      // exists to stop - the database and the application disagreeing about
      // corruption.
      const { control, worker } = fixture();
      control.exec("DELETE FROM outbox_authority");
      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);
      expect(claimFacts(control)).toMatchObject({ status: "PENDING", lease_owner: null, attempts: 0 });
    });

    it("cannot represent ATTEMPT authority at all", () => {
      // A property of 0040 specifically: 0041 widens this deliberately, so the
      // assertion is scoped to the release that made the promise.
      const control = at0040Only();
      expect(() => control.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1"))
        .toThrow(/CHECK constraint failed/);
      expect(outboxAuthority(control).attempt_authority).toBe("LEGACY");
    });

    it("has no event vocabulary for an activation", () => {
      const control = at0040Only();
      expect(() => control.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, reason, revision)
        VALUES ('e1', 'AUTHORITY_ACTIVATED', 'x', 'r', 2)`).run()).toThrow(/CHECK constraint failed/);
    });

    it("keeps fenced and owned as one fact", () => {
      const { control } = fixture();
      expect(() => control.exec("UPDATE outbox_authority SET email_dispatch_paused = 1 WHERE singleton = 1"))
        .toThrow(/CHECK constraint failed/);
    });
  });

  describe("dispatch fence, proven across two connections", () => {
    it("blocks the deployed worker's own claim statement", () => {
      const { control, worker } = fixture();
      expect(legacyClaim(worker).changes).toBe(1);           // open: it works
      control.exec("UPDATE email_outbox SET status = 'PENDING', lease_owner = NULL, attempts = 0 WHERE id = 'm1'");

      fenceEmailDispatch(control, { expected_revision: 1, reason: "authority migration" }, EPOCH_A);

      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);
    });

    it("leaves every claim fact untouched when it aborts", () => {
      const { control, worker } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "authority migration" }, EPOCH_A);
      const before = claimFacts(control);
      expect(() => legacyClaim(worker)).toThrow();
      expect(claimFacts(control)).toEqual(before);
      expect(before).toMatchObject({ status: "PENDING", lease_owner: null, attempts: 0 });
    });

    it("lets the same statement through again once unfenced", () => {
      // Without this, a trigger that blocks unconditionally would pass.
      const { control, worker } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, EPOCH_A);
      expect(() => legacyClaim(worker)).toThrow();
      unfenceEmailDispatch(control, { expected_revision: 2, reason: "done" }, EPOCH_A);
      expect(legacyClaim(worker).changes).toBe(1);
    });

    it("fences a SEND_UNKNOWN retry as well as a first send", () => {
      const { control, worker } = fixture();
      control.exec("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'");
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, EPOCH_A);
      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);
    });

    it("does not fence anything except starting a send", () => {
      // Settling an in-flight send, recording delivery, suppression and
      // supersession must all continue while dispatch is fenced.
      const { control, worker } = fixture();
      expect(legacyClaim(worker).changes).toBe(1);
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, EPOCH_A);
      expect(() => worker.exec("UPDATE email_outbox SET status = 'ACCEPTED', job_id = 'j1', lease_owner = NULL WHERE id = 'm1'")).not.toThrow();
      expect(() => worker.exec("UPDATE email_outbox SET status = 'DELIVERED', delivered_at = '2026-08-30T00:00:00Z' WHERE id = 'm1'")).not.toThrow();
      expect(() => worker.exec("UPDATE email_outbox SET suppressed_at = '2026-08-30T00:00:00Z' WHERE id = 'm1'")).not.toThrow();
    });

    it("reports drain separately from exclusion", () => {
      // Two different facts. Conflating them is the defect 0040 exists to fix:
      // drained says the last sweep finished, fenced says none can start.
      const { control, worker } = fixture();
      expect(emailDispatchDrained(control)).toMatchObject({ drained: true, sending: 0, leased: 0 });
      expect(legacyClaim(worker).changes).toBe(1);
      expect(emailDispatchDrained(control)).toMatchObject({ drained: false, sending: 1, leased: 1 });
      expect(emailDispatchFenced(control)).toBe(false);
    });
  });

  describe("fence commands", () => {
    it("refuses a stale revision", () => {
      const { control } = fixture();
      expect(() => fenceEmailDispatch(control, { expected_revision: 99, reason: "stale" }, EPOCH_A))
        .toThrow(/OUTBOX_AUTHORITY_REVISION_CONFLICT/);
    });

    it("records actor and reason on every transition", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "authority migration" }, EPOCH_A);
      unfenceEmailDispatch(control, { expected_revision: 2, reason: "migration complete" }, EPOCH_A);
      // The epoch, not the credential: "who held the token" does not answer
      // which migration stopped the mail.
      expect(control.prepare("SELECT action, owner_release_id, owner_generation, reason, revision FROM outbox_authority_events ORDER BY revision").all()).toEqual([
        { action: "DISPATCH_FENCED", owner_release_id: "cutover-a", owner_generation: 1, reason: "authority migration", revision: 2 },
        { action: "DISPATCH_UNFENCED", owner_release_id: "cutover-a", owner_generation: 1, reason: "migration complete", revision: 3 },
      ]);
    });

    it("refuses a fence held by another epoch", () => {
      // The case CAS cannot cover: epoch B reads the current revision and would
      // otherwise be able to act in the middle of epoch A's migration.
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "A fences" }, EPOCH_A);
      const revision = outboxAuthority(control).revision;
      expect(() => fenceEmailDispatch(control, { expected_revision: revision, reason: "B fences" }, EPOCH_B))
        .toThrow(/OUTBOX_DISPATCH_OWNER_CONFLICT/);
      expect(() => unfenceEmailDispatch(control, { expected_revision: revision, reason: "B unfences" }, EPOCH_B))
        .toThrow(/OUTBOX_DISPATCH_OWNER_CONFLICT/);
      expect(outboxAuthority(control).email_dispatch_paused).toBe(true);
    });

    it("lets a later epoch fence once the owner has released", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "A fences" }, EPOCH_A);
      unfenceEmailDispatch(control, { expected_revision: 2, reason: "A releases" }, EPOCH_A);
      expect(() => fenceEmailDispatch(control, { expected_revision: 3, reason: "B fences" }, EPOCH_B)).not.toThrow();
      expect(outboxAuthority(control).dispatch_owner_release_id).toBe("cutover-b");
    });

    it("clears ownership on release so the fence is never orphaned", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, EPOCH_A);
      unfenceEmailDispatch(control, { expected_revision: 2, reason: "unfence" }, EPOCH_A);
      expect(outboxAuthority(control)).toMatchObject({
        email_dispatch_paused: false, dispatch_owner_release_id: null, dispatch_owner_generation: null,
      });
    });

    it("distinguishes generations of the same release", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "gen 1" }, { release_id: "cutover-a", generation: 1 });
      const revision = outboxAuthority(control).revision;
      expect(() => unfenceEmailDispatch(control, { expected_revision: revision, reason: "gen 2" }, { release_id: "cutover-a", generation: 2 }))
        .toThrow(/OUTBOX_DISPATCH_OWNER_CONFLICT/);
    });

    it("is idempotent for a retried command at the same revision", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, EPOCH_A);
      const after = outboxAuthority(control);
      expect(fenceEmailDispatch(control, { expected_revision: after.revision, reason: "fence" }, EPOCH_A)).toEqual(after);
      expect(control.prepare("SELECT COUNT(*) AS n FROM outbox_authority_events").get()).toEqual({ n: 1 });
    });
  });

  describe("legacy attempt freeze guard", () => {
    // Inert on arrival: nothing in this release moves authority, so ATTEMPT is
    // simulated directly to prove the guard is correct before it is relied on.
    /**
     * ATTEMPT is unrepresentable in 0040, so it is reached the way 0041 must:
     * by widening the CHECK, which means rebuilding the table.
     *
     * And rebuilding it is NOT free, which this simulation exists to prove
     * before 0041 discovers it in production: RENAME rewrites the two triggers'
     * references to point at the temporary table, so dropping that table leaves
     * both guards dangling - the fence silently stops fencing. 0041 must
     * therefore drop and recreate both triggers in the same migration.
     *
     * The triggers are recreated here from the migration file itself, so this
     * test walks the exact upgrade path rather than an idealised one.
     */
    const underAttemptAuthority = (db: Database.Database) => {
      db.exec(`
        ALTER TABLE outbox_authority RENAME TO outbox_authority_pre_activation;
        CREATE TABLE outbox_authority (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          attempt_authority TEXT NOT NULL DEFAULT 'LEGACY' CHECK (attempt_authority IN ('LEGACY', 'ATTEMPT')),
          email_dispatch_paused INTEGER NOT NULL DEFAULT 0 CHECK (email_dispatch_paused IN (0, 1)),
          dispatch_owner_release_id TEXT,
          dispatch_owner_generation INTEGER,
          revision INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          CHECK ((email_dispatch_paused = 1) = (dispatch_owner_release_id IS NOT NULL))
        );
        INSERT INTO outbox_authority SELECT * FROM outbox_authority_pre_activation;
        DROP TABLE outbox_authority_pre_activation;
        DROP TRIGGER IF EXISTS email_outbox_dispatch_pause_guard;
        DROP TRIGGER IF EXISTS email_outbox_legacy_attempt_freeze_guard;
      `);
      // Recreated verbatim from the migration, so their references resolve to
      // the rebuilt table.
      const migration = readFileSync(join(MIGRATIONS, "0040_outbox_authority_control.sql"), "utf8");
      for (const statement of migration.split(/(?=CREATE TRIGGER)/).slice(1)) {
        db.exec(statement.slice(0, statement.indexOf("END;") + 4));
      }
      db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
    };

    it("is inert while authority is LEGACY", () => {
      const { control, worker } = fixture();
      expect(() => worker.exec("UPDATE email_outbox SET attempts = attempts + 1, last_error = 'X' WHERE id = 'm1'")).not.toThrow();
      expect(outboxAuthority(control).attempt_authority).toBe("LEGACY");
    });

    it.each([
      ["provider_idempotence_key", "provider_idempotence_key = 'k2'"],
      ["job_id", "job_id = 'j2'"],
      ["lease_owner", "lease_owner = 'w2'"],
      ["lease_expires_at", "lease_expires_at = '2026-08-30T00:00:00Z'"],
      ["send_started_at", "send_started_at = '2026-08-30T00:00:00Z'"],
      ["provider_request_started_at", "provider_request_started_at = '2026-08-30T00:00:00Z'"],
      ["attempts", "attempts = attempts + 1"],
      ["last_error", "last_error = 'X'"],
      ["provider_error_code", "provider_error_code = '550'"],
      ["provider_error_message", "provider_error_message = 'nope'"],
      ["next_attempt_at", "next_attempt_at = '2026-08-30T00:00:00Z'"],
    ])("rejects a write to %s under ATTEMPT authority", (_column, assignment) => {
      const { control, worker } = fixture();
      underAttemptAuthority(control);
      expect(() => worker.exec(`UPDATE email_outbox SET ${assignment} WHERE id = 'm1'`))
        .toThrow(/EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN/);
    });

    it.each([
      ["status", "status = 'SKIPPED'"],
      ["delivery_outcome via a failure", "status = 'FAILED', delivery_outcome = 'KNOWN_FAILED'"],
      ["sent_at", "sent_at = '2026-08-30T00:00:00Z'"],
      ["delivered_at", "delivered_at = '2026-08-30T00:00:00Z'"],
      ["bounced_at", "bounced_at = '2026-08-30T00:00:00Z'"],
      ["suppressed_at", "suppressed_at = '2026-08-30T00:00:00Z'"],
      ["superseded_at", "superseded_at = '2026-08-30T00:00:00Z', superseded_reason = 'r'"],
      ["ops_acknowledged_at", "ops_acknowledged_at = '2026-08-30T00:00:00Z', ops_acknowledged_reason = 'r'"],
      ["recipient redaction", "recipient_email = '', payload_snapshot = '{}'"],
    ])("still allows the message-level write %s under ATTEMPT authority", (_label, assignment) => {
      // The guard must freeze attempt facts without freezing the message. If it
      // caught these, delivery events, consent purges and ops acknowledgement
      // would all stop the moment authority moved.
      const { control, worker } = fixture();
      underAttemptAuthority(control);
      expect(() => worker.exec(`UPDATE email_outbox SET ${assignment} WHERE id = 'm1'`)).not.toThrow();
    });

    it("uses null-safe comparison, so setting a null column is still a write", () => {
      const { control, worker } = fixture();
      underAttemptAuthority(control);
      expect(control.prepare("SELECT job_id FROM email_outbox WHERE id = 'm1'").get()).toEqual({ job_id: null });
      expect(() => worker.exec("UPDATE email_outbox SET job_id = 'j1' WHERE id = 'm1'"))
        .toThrow(/EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN/);
    });

    it("permits a no-op write of an identical value", () => {
      // IS NOT compares values, not whether the column appeared in SET.
      const { control, worker } = fixture();
      underAttemptAuthority(control);
      expect(() => worker.exec("UPDATE email_outbox SET attempts = attempts, last_error = last_error WHERE id = 'm1'")).not.toThrow();
    });
  });

  describe("forward migration guard", () => {
    it("passes when the build knows every applied migration", () => {
      const { control } = fixture();
      expect(unknownAppliedMigrations(control, MIGRATIONS)).toEqual([]);
    });

    it("names an applied migration the build has never heard of", () => {
      const { control } = fixture();
      // A version no build will ever ship, so this cannot go stale the way
      // naming a real future migration did.
      control.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run("9999_from_a_later_release.sql");
      expect(unknownAppliedMigrations(control, MIGRATIONS)).toEqual(["9999_from_a_later_release.sql"]);
    });

    it("compares sets, not heads", () => {
      // A build could be missing a migration that is not the newest one. Head
      // comparison would call that compatible; it is not.
      const { control } = fixture();
      control.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run("0007a_hotfix.sql");
      expect(unknownAppliedMigrations(control, MIGRATIONS)).toEqual(["0007a_hotfix.sql"]);
    });

    it("fails closed when the build cannot read its own migrations", () => {
      const { control } = fixture();
      expect(unknownAppliedMigrations(control, join(tmpdir(), "definitely-not-here"))).toEqual(["MIGRATIONS_DIRECTORY_UNREADABLE"]);
    });
  });
});
