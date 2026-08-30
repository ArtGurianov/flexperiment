import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { skipObsoletePendingMessage, supersedeQueuedMessage, suppressMessageDispatch } from "../src/outbox-attempt-store";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";

/**
 * Seam 4 of 5: suppression and supersession.
 *
 * Inventoried before conversion, per the review order that the last three seams
 * earned:
 *
 *   READS     none of these decisions read an attempt fact. They read consent
 *             intents, refund tokens and message status. So unlike seams 2 and
 *             3, there is no reader defect to find here.
 *
 *   ORDERING  these are MESSAGE COMMANDS, not attempt-bound transitions. They
 *             carry no attempt ref deliberately: gating a consent withdrawal on
 *             a carried ref would let it be silently dropped because the attempt
 *             changed, which is the opposite of what suppression is for.
 *
 *   WRITES    the message command is the authority; the active attempt's
 *             scheduling is cleaned as a consequence, and never settled.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const LEGACY_ATTEMPT_COLUMNS = [
  "provider_idempotence_key", "job_id", "lease_owner", "lease_expires_at", "send_started_at",
  "provider_request_started_at", "attempts", "last_error", "provider_error_code",
  "provider_error_message", "next_attempt_at",
] as const;

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "suppression-template-")), "t.sqlite");
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

const fixture = ({ authority, status = "PENDING", legacy }: { authority: "LEGACY" | "ATTEMPT"; status?: string; legacy?: string }) => {
  const file = join(mkdtempSync(join(tmpdir(), "suppression-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template,
    payload_snapshot, status, provider_idempotence_key, attempts)
    VALUES ('m1', 'CITY_INTEREST_AVAILABLE', 'a@b.invalid', 'h', 'tpl', '{}', ?, 'shared-key', 0)`).run(status);
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, lease_owner, lease_expires_at, next_retry_at)
    VALUES ('a1', 'm1', 1, 'shared-key', 'w1', '2026-08-30T00:02:00Z', '2026-08-30T00:05:00Z')`).run();
  if (legacy) db.exec(legacy);
  if (authority === "ATTEMPT") db.exec("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT' WHERE singleton = 1");
  return db;
};

const legacyFacts = (db: Database.Database) =>
  db.prepare(`SELECT ${LEGACY_ATTEMPT_COLUMNS.join(", ")} FROM email_outbox WHERE id = 'm1'`).get();
const message = (db: Database.Database) =>
  db.prepare("SELECT status, suppressed_at, superseded_at, recipient_email FROM email_outbox WHERE id = 'm1'").get();
const attempt = (db: Database.Database) =>
  db.prepare("SELECT outcome, lease_owner, lease_expires_at, next_retry_at, failure_code FROM outbox_attempt WHERE id = 'a1'").get();
const tx = <T>(db: Database.Database, fn: () => T) => db.transaction(fn).immediate();

afterEach(() => { while (open.length) open.pop()!.close(); });

describe("suppression seam", () => {
  describe("suppression is a message command", () => {
    it.each([["LEGACY"], ["ATTEMPT"]] as const)("skips and redacts under %s", (authority) => {
      const db = fixture({ authority });
      tx(db, () => suppressMessageDispatch(db, "m1", "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", TS));
      expect(message(db)).toMatchObject({ status: "SKIPPED", suppressed_at: TS, recipient_email: "" });
    });

    it("clears the active attempt's scheduling without settling it, under ATTEMPT", () => {
      // Suppression establishes nothing about whether the provider accepted the
      // send, and an in-flight call cannot be recalled, so later evidence must
      // still be able to settle the attempt.
      const db = fixture({ authority: "ATTEMPT", status: "SENDING" });
      const legacyBefore = legacyFacts(db);
      tx(db, () => suppressMessageDispatch(db, "m1", "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", TS));

      expect(attempt(db)).toEqual({ outcome: null, lease_owner: null, lease_expires_at: null, next_retry_at: null, failure_code: null });
      expect(legacyFacts(db)).toEqual(legacyBefore);
    });

    it("does not record consent withdrawal as a send failure", () => {
      // Under LEGACY the reason is written into last_error because that column
      // is the only place available. It is not a provider failure, so under
      // ATTEMPT it stays on the message rather than becoming the attempt's
      // failure_code.
      const db = fixture({ authority: "ATTEMPT", status: "SENDING" });
      tx(db, () => suppressMessageDispatch(db, "m1", "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", TS));
      expect((attempt(db) as { failure_code: string | null }).failure_code).toBeNull();
      expect((message(db) as { suppressed_at: string }).suppressed_at).toBe(TS);
    });

    it("cleans nothing when the typed message command does not apply", () => {
      // The single-statement original guarded the message mutation and the
      // legacy cleanup together with `WHERE id = ? AND type = ?`. Splitting
      // them let the cleanup run against a message the command never matched.
      const db = fixture({ authority: "ATTEMPT", status: "SENDING" });
      const attemptBefore = attempt(db);
      const messageBefore = message(db);

      tx(db, () => suppressMessageDispatch(db, "m1", "OCCURRENCE_AVAILABLE", "WRONG_TYPE", TS));

      expect(attempt(db)).toEqual(attemptBefore);
      expect(message(db)).toEqual(messageBefore);
    });

    it("leaves a DELIVERED message's lifecycle and attempt alone, while still redacting", () => {
      const db = fixture({ authority: "ATTEMPT", status: "DELIVERED" });
      const attemptBefore = attempt(db);
      tx(db, () => suppressMessageDispatch(db, "m1", "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", TS));
      expect((message(db) as { status: string }).status).toBe("DELIVERED");
      expect(attempt(db)).toEqual(attemptBefore);
      // PII is still removed: the lifecycle status is preserved, not the data.
      expect((message(db) as { recipient_email: string }).recipient_email).toBe("");
    });

    it("is not dropped when the active attempt changed underneath it", () => {
      // The decision this seam turns on: a consent withdrawal must never be
      // skipped because a successor attempt became current.
      const db = fixture({ authority: "ATTEMPT", status: "SENDING" });
      db.exec("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED' WHERE id = 'a1'");
      db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, lease_owner)
        VALUES ('a2', 'm1', 2, 'resend-key', 'w2')`).run();

      tx(db, () => suppressMessageDispatch(db, "m1", "CITY_INTEREST_AVAILABLE", "CITY_INTEREST_NO_LONGER_ACTIVE", TS));

      expect(message(db)).toMatchObject({ status: "SKIPPED", recipient_email: "" });
      expect(db.prepare("SELECT lease_owner, outcome FROM outbox_attempt WHERE id = 'a2'").get())
        .toEqual({ lease_owner: null, outcome: null });
    });
  });

  describe("supersession retains provider evidence", () => {
    it.each([["LEGACY"], ["ATTEMPT"]] as const)("skips a PENDING notice under %s", (authority) => {
      const db = fixture({ authority });
      expect(tx(db, () => supersedeQueuedMessage(db, "m1", TS, "newer revision"))).toBe(1);
      expect(message(db)).toMatchObject({ status: "SKIPPED", superseded_at: TS });
    });

    it("retains the status of an in-flight send and does not clear its lease", () => {
      // Only PENDING had its scheduling cleared under LEGACY, because anything
      // further may already be a real delivery attempt. The ATTEMPT branch
      // mirrors that rather than clearing a live in-flight lease.
      const db = fixture({ authority: "ATTEMPT", status: "SENDING" });
      const attemptBefore = attempt(db);
      expect(tx(db, () => supersedeQueuedMessage(db, "m1", TS, "newer revision"))).toBe(1);
      expect(message(db)).toMatchObject({ status: "SENDING", superseded_at: TS });
      expect(attempt(db)).toEqual(attemptBefore);
    });

    it("clears scheduling for a PENDING notice under ATTEMPT", () => {
      const db = fixture({ authority: "ATTEMPT" });
      tx(db, () => supersedeQueuedMessage(db, "m1", TS, "newer revision"));
      expect(attempt(db)).toMatchObject({ lease_owner: null, next_retry_at: null, outcome: null });
    });

    it("refuses to supersede twice", () => {
      const db = fixture({ authority: "ATTEMPT" });
      tx(db, () => supersedeQueuedMessage(db, "m1", TS, "first"));
      expect(tx(db, () => supersedeQueuedMessage(db, "m1", "2026-08-31T00:00:00Z", "second"))).toBe(0);
      expect((message(db) as { superseded_at: string }).superseded_at).toBe(TS);
    });
  });

  describe("obsolete pending skip", () => {
    it.each([["LEGACY"], ["ATTEMPT"]] as const)("is a strict compare-and-set under %s", (authority) => {
      const db = fixture({ authority, status: "SEND_UNKNOWN" });
      // A stale PENDING snapshot must never relabel a newer provider outcome.
      expect(tx(db, () => skipObsoletePendingMessage(db, "m1"))).toBe(0);
      expect((message(db) as { status: string }).status).toBe("SEND_UNKNOWN");
    });

    it("clears the active attempt when it does apply, under ATTEMPT", () => {
      const db = fixture({ authority: "ATTEMPT" });
      expect(tx(db, () => skipObsoletePendingMessage(db, "m1"))).toBe(1);
      expect(attempt(db)).toMatchObject({ lease_owner: null, next_retry_at: null, outcome: null });
    });
  });
});

/**
 * Orchestration seam.
 *
 * This conversion was already inert once: the helpers were correct, the domain
 * still ran the old inline SQL, and every helper test above stayed green. The
 * only signal was an unused import. That is a human convention, so it is
 * replaced here by executable proof.
 */
describe("the domain consumes the suppression helpers", () => {
  it("suppresses an inactive notification through processEmailOutbox under ATTEMPT", async () => {
    // No intent rows exist, so isActiveCityInterestNotification is false and
    // the dispatch loop must suppress rather than send.
    const db = fixture({ authority: "ATTEMPT", status: "PENDING" });
    db.exec(`UPDATE outbox_attempt SET lease_owner = 'w1', next_retry_at = '2026-08-30T00:05:00Z' WHERE id = 'a1'`);

    await new CommerceDomain(db, new MockProvider()).processEmailOutbox();

    expect(message(db)).toMatchObject({ status: "SKIPPED", recipient_email: "" });
    // Attempt scheduling cleared, attempt NOT settled, and no legacy write -
    // which would have aborted on the 0040 freeze trigger.
    expect(attempt(db)).toMatchObject({ outcome: null, lease_owner: null, next_retry_at: null });
  });

  it("leaves no inline legacy suppression SQL behind in the domain", () => {
    // A structural backstop for the two conversions without a natural
    // end-to-end path. It is not a substitute for the test above; it exists
    // because the failure mode is a silent no-op replacement.
    const domain = readFileSync("commerce/src/domain.ts", "utf8");
    expect(domain).toContain("suppressMessageDispatch(this.db");
    expect(domain).toContain("supersedeQueuedMessage(this.db");
    expect(domain).toContain("skipObsoletePendingMessage(this.db");
    expect(domain, "an inline legacy suppression UPDATE survived the conversion")
      .not.toMatch(/last_error = CASE WHEN status = 'DELIVERED'/);
    expect(domain, "an inline legacy supersession UPDATE survived the conversion")
      .not.toMatch(/lease_owner = CASE WHEN status = 'PENDING'/);
  });
});
