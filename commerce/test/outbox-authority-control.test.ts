import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
const open: Database.Database[] = [];

const migrate = (file: string) => {
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    db.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run(name);
  }
  return db;
};

/** An on-disk database, so a genuinely separate connection can be opened. */
const fixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), "outbox-authority-")), "commerce.sqlite");
  const control = migrate(file);
  const worker = new Database(file);
  worker.pragma("foreign_keys = ON");
  open.push(control, worker);
  control.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'TEST', 'a@b.invalid', 'h', 'tpl', '{}', 'PENDING', 'k1', 0)`).run();
  return { control, worker };
};

/** Byte-for-byte the deployed worker's claim, executed by the other connection. */
const legacyClaim = (worker: Database.Database) =>
  worker.prepare(`UPDATE email_outbox SET status = 'SENDING', lease_owner = ?,
      lease_expires_at = datetime('now', '+120 seconds'),
      send_started_at = COALESCE(send_started_at, ?), provider_request_started_at = ?,
      next_attempt_at = NULL, attempts = attempts + 1
    WHERE id = ? AND status IN ('PENDING', 'SEND_UNKNOWN')`)
    .run("worker-legacy", "2026-08-30T00:00:00.000Z", "2026-08-30T00:00:00.000Z", "m1");

const claimFacts = (db: Database.Database) =>
  db.prepare("SELECT status, lease_owner, lease_expires_at, send_started_at, provider_request_started_at, attempts FROM email_outbox WHERE id = 'm1'").get();

afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe("outbox authority control", () => {
  describe("control row", () => {
    it("starts safe", () => {
      const { control } = fixture();
      expect(outboxAuthority(control)).toEqual({ attempt_authority: "LEGACY", email_dispatch_paused: false, revision: 1 });
    });

    it("fails closed when the control row is missing", () => {
      // A build that cannot read the control state must not dispatch.
      const { control } = fixture();
      control.exec("DELETE FROM outbox_authority");
      expect(emailDispatchFenced(control)).toBe(true);
    });

    it("ships no way to move attempt authority", () => {
      // The column admits ATTEMPT so the freeze guard can be inert on arrival.
      // Nothing in this release may set it, and the event vocabulary has no
      // action to record it with.
      const source = readFileSync("commerce/src/outbox-authority.ts", "utf8");
      expect(source).not.toMatch(/UPDATE outbox_authority[\s\S]*attempt_authority\s*=/);
      const migration = readFileSync(join(MIGRATIONS, "0040_outbox_authority_control.sql"), "utf8");
      expect(migration).toContain("CHECK (action IN ('DISPATCH_FENCED', 'DISPATCH_UNFENCED'))");
    });
  });

  describe("dispatch fence, proven across two connections", () => {
    it("blocks the deployed worker's own claim statement", () => {
      const { control, worker } = fixture();
      expect(legacyClaim(worker).changes).toBe(1);           // open: it works
      control.exec("UPDATE email_outbox SET status = 'PENDING', lease_owner = NULL, attempts = 0 WHERE id = 'm1'");

      fenceEmailDispatch(control, { expected_revision: 1, reason: "authority migration" }, "test");

      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);
    });

    it("leaves every claim fact untouched when it aborts", () => {
      const { control, worker } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "authority migration" }, "test");
      const before = claimFacts(control);
      expect(() => legacyClaim(worker)).toThrow();
      expect(claimFacts(control)).toEqual(before);
      expect(before).toMatchObject({ status: "PENDING", lease_owner: null, attempts: 0 });
    });

    it("lets the same statement through again once unfenced", () => {
      // Without this, a trigger that blocks unconditionally would pass.
      const { control, worker } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, "test");
      expect(() => legacyClaim(worker)).toThrow();
      unfenceEmailDispatch(control, { expected_revision: 2, reason: "done" }, "test");
      expect(legacyClaim(worker).changes).toBe(1);
    });

    it("fences a SEND_UNKNOWN retry as well as a first send", () => {
      const { control, worker } = fixture();
      control.exec("UPDATE email_outbox SET status = 'SEND_UNKNOWN' WHERE id = 'm1'");
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, "test");
      expect(() => legacyClaim(worker)).toThrow(/EMAIL_DISPATCH_PAUSED/);
    });

    it("does not fence anything except starting a send", () => {
      // Settling an in-flight send, recording delivery, suppression and
      // supersession must all continue while dispatch is fenced.
      const { control, worker } = fixture();
      expect(legacyClaim(worker).changes).toBe(1);
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, "test");
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
      expect(() => fenceEmailDispatch(control, { expected_revision: 99, reason: "stale" }, "test"))
        .toThrow(/OUTBOX_AUTHORITY_REVISION_CONFLICT/);
    });

    it("records actor and reason on every transition", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "authority migration" }, "operator-a");
      unfenceEmailDispatch(control, { expected_revision: 2, reason: "migration complete" }, "operator-b");
      expect(control.prepare("SELECT action, actor, reason, revision FROM outbox_authority_events ORDER BY revision").all()).toEqual([
        { action: "DISPATCH_FENCED", actor: "operator-a", reason: "authority migration", revision: 2 },
        { action: "DISPATCH_UNFENCED", actor: "operator-b", reason: "migration complete", revision: 3 },
      ]);
    });

    it("is idempotent for a retried command at the same revision", () => {
      const { control } = fixture();
      fenceEmailDispatch(control, { expected_revision: 1, reason: "fence" }, "test");
      const after = outboxAuthority(control);
      expect(fenceEmailDispatch(control, { expected_revision: after.revision, reason: "fence" }, "test")).toEqual(after);
      expect(control.prepare("SELECT COUNT(*) AS n FROM outbox_authority_events").get()).toEqual({ n: 1 });
    });
  });

  describe("legacy attempt freeze guard", () => {
    // Inert on arrival: nothing in this release moves authority, so ATTEMPT is
    // simulated directly to prove the guard is correct before it is relied on.
    const underAttemptAuthority = (db: Database.Database) =>
      db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");

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
      control.prepare("INSERT INTO schema_migrations(version) VALUES (?)").run("0041_outbox_attempt.sql");
      expect(unknownAppliedMigrations(control, MIGRATIONS)).toEqual(["0041_outbox_attempt.sql"]);
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
