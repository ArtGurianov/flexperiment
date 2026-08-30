import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { certificationDispatchEvidence } from "../src/certification-dispatch";
import { ACTIVATION_REFUSAL_CODES } from "../src/outbox-activation";

/**
 * The dispatch proof has to be about the certification order's OWN mail.
 *
 * The population version - "settled_accepted went up" - passes for the wrong
 * reason, and the failure mode is not hypothetical: a late provider callback
 * settling an unrelated older SEND_UNKNOWN increments that counter, so a broken
 * ATTEMPT dispatch path reads as green. Every test below therefore keeps a
 * decoy message in the store that must not be able to satisfy the proof.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const RELEASE = "outbox-attempt-authority-v1:abc";
const ORDER = "order-certified";

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "cert-dispatch-template-")), "template.sqlite");
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
afterEach(() => { while (open.length) open.pop()!.close(); });

const fixture = () => {
  const file = join(mkdtempSync(join(tmpdir(), "cert-dispatch-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  return db;
};

/** The CERTIFIED transition, which is where the order id actually lives. */
const certify = (db: Database.Database, orderId = ORDER) => {
  db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'PAUSED', ?)")
    .run(`event-${orderId}`, RELEASE, JSON.stringify({
      schema_version: 2, kind: "PHASE_CHANGED",
      certification_evidence: { order_id: orderId, payment_id: "pay", refund_id: "ref" },
    }));
};

const message = (db: Database.Database, id: string, columns: Record<string, unknown> = {}, attempt: Record<string, unknown> | null = {}) => {
  const base: Record<string, unknown> = {
    id, type: "TICKET", recipient_email: `${id}@b.invalid`, recipient_email_hash: "h",
    template: "tpl", payload_ref: ORDER, payload_snapshot: "{}", status: "PENDING",
    provider_idempotence_key: `key-${id}`, attempts: 0, ...columns,
  };
  const names = Object.keys(base);
  db.prepare(`INSERT INTO email_outbox(${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`).run(base);
  if (!attempt) return;
  const row: Record<string, unknown> = {
    id: `a-${id}`, message_id: id, attempt_no: 1, provider_idempotence_key: `key-${id}`,
    started_at: null, provider_request_started_at: null, completed_at: null, outcome: null, ...attempt,
  };
  const attemptNames = Object.keys(row);
  db.prepare(`INSERT INTO outbox_attempt(${attemptNames.join(", ")}) VALUES (${attemptNames.map((n) => `@${n}`).join(", ")})`).run(row);
};

/** An unrelated, already-dispatched message: the decoy the old proof accepted. */
const decoy = (db: Database.Database) =>
  message(db, "unrelated", { payload_ref: "some-other-thing", status: "ACCEPTED" },
    { outcome: "ACCEPTED", started_at: "2026-08-30T12:00:00.000Z", completed_at: "2026-08-30T12:00:01.000Z" });

const unfenced = (db: Database.Database, at = "2026-08-30 10:00:00") =>
  db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, reason, revision, created_at)
    VALUES ('u1', 'DISPATCH_UNFENCED', ?, 'resume', 5, ?)`).run(RELEASE, at);

describe("certification dispatch evidence", () => {
  it("resolves the order from the durable ledger, never from a caller", () => {
    // An operator able to name the order could prove dispatch with any order.
    const db = fixture();
    certify(db);
    expect(certificationDispatchEvidence(db, RELEASE).order_id).toBe(ORDER);
    expect(certificationDispatchEvidence(db, "some-other-release").order_id).toBeNull();
  });

  it("takes the order from the certification this epoch ended on", () => {
    // A recovered generation recertifies; the proof belongs to the last one.
    const db = fixture();
    certify(db, "order-first");
    certify(db, "order-second");
    expect(certificationDispatchEvidence(db, RELEASE).order_id).toBe("order-second");
  });

  it("reports a queued, unstarted backlog as a valid proof target", () => {
    const db = fixture();
    certify(db);
    message(db, "m1");
    message(db, "m2", { type: "CUSTOMER_REFUND_CONFIRMED" });
    decoy(db);
    const evidence = certificationDispatchEvidence(db, RELEASE);
    expect(evidence.messages.map((m) => m.outbox_id).sort()).toEqual(["m1", "m2"]);
    expect(evidence.queued_unstarted).toBe(true);
    expect(evidence.dispatched_after_unfence).toBe(false);
  });

  it("refuses a proof target with no mail at all", () => {
    const db = fixture();
    certify(db);
    decoy(db);
    expect(certificationDispatchEvidence(db, RELEASE).queued_unstarted).toBe(false);
  });

  it("refuses a proof target whose send already started", () => {
    // If it started before activation, the fence was not doing its job.
    const db = fixture();
    certify(db);
    message(db, "m1", { status: "SENDING" }, { started_at: "2026-08-30T09:00:00.000Z" });
    expect(certificationDispatchEvidence(db, RELEASE).queued_unstarted).toBe(false);
  });

  it("proves dispatch when THOSE attempts are accepted after the unfence", () => {
    const db = fixture();
    certify(db);
    unfenced(db, "2026-08-30 10:00:00");
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T10:00:05.000Z", completed_at: "2026-08-30T10:00:06.000Z" });
    const evidence = certificationDispatchEvidence(db, RELEASE);
    expect(evidence.dispatched_after_unfence).toBe(true);
    expect(evidence.unfenced_at).toBe("2026-08-30 10:00:00");
  });

  it("is not satisfied by an unrelated attempt settling", () => {
    // The decisive test, and the whole reason this module exists. Under the
    // population proof this store passes: settled_accepted is 1 and rising.
    const db = fixture();
    certify(db);
    unfenced(db);
    message(db, "m1");
    decoy(db);
    expect(certificationDispatchEvidence(db, RELEASE).dispatched_after_unfence).toBe(false);
  });

  it("is not satisfied by a send that started before the unfence", () => {
    // Same attempt, wrong side of the event: that send was not dispatched by
    // the resumed worker, so it proves nothing about ATTEMPT dispatch.
    const db = fixture();
    certify(db);
    unfenced(db, "2026-08-30 10:00:00");
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T09:59:00.000Z", completed_at: "2026-08-30T09:59:30.000Z" });
    expect(certificationDispatchEvidence(db, RELEASE).dispatched_after_unfence).toBe(false);
  });

  it("compares the two timestamp formats correctly", () => {
    // outbox_authority_events.created_at is SQLite CURRENT_TIMESTAMP with a
    // space and no zone; the runtime writes ISO-8601 with an offset. Lexically
    // "2026-08-30T10:00:05.000Z" < "2026-08-30 10:00:00" is FALSE for the wrong
    // reason - "T" > " " - so the naive comparison happens to pass here and
    // fails on the offset case below.
    const db = fixture();
    certify(db);
    unfenced(db, "2026-08-30 10:00:00");
    // +07:00 local, i.e. 03:00Z - genuinely BEFORE the unfence, though it sorts
    // after it as a string.
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T10:00:05.000+07:00", completed_at: "2026-08-30T10:00:06.000+07:00" });
    expect(certificationDispatchEvidence(db, RELEASE).dispatched_after_unfence).toBe(false);
  });

  it("refuses a partially dispatched backlog", () => {
    // One sent and one never started is not a proof that dispatch works.
    const db = fixture();
    certify(db);
    unfenced(db);
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T11:00:00.000Z", completed_at: "2026-08-30T11:00:01.000Z" });
    message(db, "m2");
    expect(certificationDispatchEvidence(db, RELEASE).dispatched_after_unfence).toBe(false);
  });

  it("ignores suppressed and superseded messages", () => {
    // A withdrawn or superseded message is never going to be sent, and holding
    // the proof hostage to it would strand the cutover.
    const db = fixture();
    certify(db);
    unfenced(db);
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T11:00:00.000Z", completed_at: "2026-08-30T11:00:01.000Z" });
    message(db, "gone", { status: "SKIPPED", suppressed_at: "2026-08-30T09:00:00.000Z" });
    expect(certificationDispatchEvidence(db, RELEASE).dispatched_after_unfence).toBe(true);
  });

  it("reports nothing rather than throwing on a runtime with no attempt store", () => {
    const db = fixture();
    certify(db);
    db.exec("DROP TABLE outbox_attempt");
    expect(certificationDispatchEvidence(db, RELEASE))
      .toMatchObject({ messages: [], queued_unstarted: false, dispatched_after_unfence: false });
  });

  it("keeps the activation refusal vocabulary in sync with the module that throws it", () => {
    // The recovery transition binds its defect code to this list, so a code the
    // list has never heard of cannot justify a recovery - and a code the module
    // throws but the list omits would strand a real one.
    const source = readFileSync(join(process.cwd(), "commerce", "src", "outbox-activation.ts"), "utf8");
    const listed = new Set<string>(ACTIVATION_REFUSAL_CODES);
    const thrown = new Set(
      [...source.matchAll(/"(OUTBOX_[A-Z0-9_]+)"/g)].map((match) => match[1])
        .filter((code) => !source.includes(`${code}" as`)),
    );
    expect([...thrown].filter((code) => !listed.has(code)).sort()).toEqual([]);
  });
});
