import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { certificationDispatchEvidence, postActivationEmailProviderDefectEvidence } from "../src/certification-dispatch";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import { fenceEmailDispatch } from "../src/outbox-authority";
import { parseUtcTimestamp } from "../src/utc-timestamp";
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

const successorAttempt = (db: Database.Database, messageId: string, attemptNo: number, attempt: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: `a-${messageId}-${attemptNo}`, message_id: messageId, attempt_no: attemptNo,
    provider_idempotence_key: `key-${messageId}-${attemptNo}`, started_at: null,
    provider_request_started_at: null, completed_at: null, outcome: null, ...attempt,
  };
  const names = Object.keys(row);
  db.prepare(`INSERT INTO outbox_attempt(${names.join(", ")}) VALUES (${names.map((name) => `@${name}`).join(", ")})`).run(row);
};

/** An unrelated, already-dispatched message: the decoy the old proof accepted. */
const decoy = (db: Database.Database) =>
  message(db, "unrelated", { payload_ref: "some-other-thing", status: "ACCEPTED" },
    { outcome: "ACCEPTED", started_at: "2026-08-30T12:00:00.000Z", completed_at: "2026-08-30T12:00:01.000Z" });

const unfenced = (db: Database.Database, at = "2026-08-30 10:00:00") =>
  db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision, created_at)
    VALUES ('u1', 'DISPATCH_UNFENCED', ?, NULL, 'resume', 5, ?)`).run(RELEASE, at);

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

  it("derives only the exact terminal UniSender refusal for the bridge", () => {
    const db = fixture();
    certify(db);
    unfenced(db, "2026-08-30 10:00:00.500");
    message(db, "m1", { status: "FAILED", delivery_outcome: "KNOWN_FAILED" }, {
      outcome: "KNOWN_FAILED", started_at: "2026-08-30T10:00:00.501Z",
      completed_at: "2026-08-30T10:00:01.000Z", failure_code: "UNISENDER_HTTP_REJECTED",
      failure_detail: JSON.stringify({ provider_error_code: "1588" }),
    });
    expect(postActivationEmailProviderDefectEvidence(db, RELEASE)).toMatchObject({
      release_id: RELEASE, order_id: ORDER, exact: true,
      ticket_attempt: { outbox_id: "m1", message_status: "FAILED", message_delivery_outcome: "KNOWN_FAILED", attempt_count: 1, attempt_no: 1, outcome: "KNOWN_FAILED", failure_code: "UNISENDER_HTTP_REJECTED", provider_error_code: "1588" },
    });
  });

  it("fails closed for a successor attempt or a nonterminal message projection", () => {
    const variants: Array<{ columns?: Record<string, unknown>; successor?: Record<string, unknown> }> = [
      { successor: { started_at: "2026-08-30T10:00:02.000Z" } },
      { successor: { outcome: "ACCEPTED", started_at: "2026-08-30T10:00:02.000Z", completed_at: "2026-08-30T10:00:03.000Z" } },
      { columns: { status: "PENDING", delivery_outcome: null } },
      { columns: { status: "ACCEPTED", delivery_outcome: null } },
    ];
    for (const variant of variants) {
      const db = fixture();
      certify(db);
      unfenced(db);
      message(db, "m1", { status: "FAILED", delivery_outcome: "KNOWN_FAILED", ...variant.columns }, {
        outcome: "KNOWN_FAILED", started_at: "2026-08-30T10:00:01.000Z",
        failure_code: "UNISENDER_HTTP_REJECTED", failure_detail: JSON.stringify({ provider_error_code: "1588" }),
      });
      if (variant.successor) successorAttempt(db, "m1", 2, variant.successor);
      expect(postActivationEmailProviderDefectEvidence(db, RELEASE).exact).toBe(false);
    }
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

  it("reads this epoch's unfence, not the newest one in the table", () => {
    // Every other read here is bound to the certified order. A global maximum
    // would let another epoch's event define the boundary this proof is
    // measured against.
    const db = fixture();
    certify(db);
    unfenced(db, "2026-08-30 10:00:00");
    db.prepare(`INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision, created_at)
      VALUES ('u2', 'DISPATCH_UNFENCED', 'someone-else', NULL, 'resume', 99, '2026-08-30 23:00:00')`).run();
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T10:00:05.000Z", completed_at: "2026-08-30T10:00:06.000Z" });

    const evidence = certificationDispatchEvidence(db, RELEASE);
    expect(evidence.unfenced_at).toBe("2026-08-30 10:00:00");
    expect(evidence.dispatched_after_unfence).toBe(true);
  });

  it("reports nothing rather than throwing on a runtime with no attempt store", () => {
    const db = fixture();
    certify(db);
    db.exec("DROP TABLE outbox_attempt");
    expect(certificationDispatchEvidence(db, RELEASE))
      .toMatchObject({ messages: [], queued_unstarted: false, dispatched_after_unfence: false });
  });

  // Each cause is proven by the rows rather than inferred from the negation of
  // "queued and unstarted", which has several possible meanings and only one of
  // them is "already started". Naming the wrong one puts a stronger claim in an
  // append-only ledger than the evidence supports.
  const defects: Array<[string, (db: Database.Database) => void, string | null]> = [
    ["no mail at all", () => {}, "CERTIFICATION_DISPATCH_TARGET_MISSING"],
    ["every message suppressed", (db) => message(db, "m1", { status: "SKIPPED", suppressed_at: "2026-08-30T09:00:00.000Z" }), "CERTIFICATION_DISPATCH_TARGET_ALL_SUPPRESSED"],
    ["attempt #1 absent", (db) => message(db, "m1", {}, null), "CERTIFICATION_DISPATCH_TARGET_ATTEMPT_MISSING"],
    ["attempt already settled", (db) => message(db, "m1", {}, { outcome: "ACCEPTED", completed_at: "2026-08-30T09:00:00.000Z" }), "CERTIFICATION_DISPATCH_TARGET_ALREADY_SETTLED"],
    ["send already started", (db) => message(db, "m1", { status: "SENDING" }, { started_at: "2026-08-30T09:00:00.000Z" }), "CERTIFICATION_DISPATCH_TARGET_ALREADY_STARTED"],
    ["provider request already started", (db) => message(db, "m1", { status: "SENDING" }, { provider_request_started_at: "2026-08-30T09:00:00.000Z" }), "CERTIFICATION_DISPATCH_TARGET_ALREADY_STARTED"],
    ["a valid target", (db) => message(db, "m1"), null],
  ];
  for (const [name, seed, expected] of defects) {
    it(`names the target defect for ${name}`, () => {
      const db = fixture();
      certify(db);
      seed(db);
      decoy(db);
      const evidence = certificationDispatchEvidence(db, RELEASE);
      expect(evidence.target_defect).toBe(expected);
      // The two are exact complements, so neither can drift from the other.
      expect(evidence.queued_unstarted).toBe(expected === null);
    });
  }

  it("does not read a send in the same second as the unfence as being after it", () => {
    // The boundary this proof is measured against used to be written at
    // CURRENT_TIMESTAMP's one-second precision while attempts carry
    // milliseconds, so a send at 10:00:00.500 - genuinely BEFORE an unfence
    // that committed at 10:00:00.900 - compared against a stored 10:00:00 and
    // read as post-unfence. That is a false positive on the only data-plane
    // proof the cutover has.
    const db = fixture();
    certify(db);
    unfenced(db, "2026-08-30 10:00:00.900");
    message(db, "m1", { status: "ACCEPTED" },
      { outcome: "ACCEPTED", started_at: "2026-08-30T10:00:00.500Z", completed_at: "2026-08-30T10:00:01.000Z" });
    expect(certificationDispatchEvidence(db, RELEASE).dispatched_after_unfence).toBe(false);
  });

  it("writes authority events with sub-second precision", () => {
    // The runtime, not the fixture: the column default is second-precision, so
    // the insert has to supply the time itself.
    const db = fixture();
    fenceEmailDispatch(db, { expected_revision: 1, reason: "fence" }, { release_id: RELEASE, generation: null });
    const created = (db.prepare("SELECT created_at FROM outbox_authority_events ORDER BY revision DESC LIMIT 1").get() as { created_at: string }).created_at;
    expect(created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(Number.isFinite(parseUtcTimestamp(created))).toBe(true);
  });

  it("refuses an activation-refusal class carrying a code the module never throws", () => {
    const db = fixture();
    certify(db);
    const domain = new CommerceDomain(db, new MockProvider());
    expect(() => domain.markPreActivationDefect({
      release_id: RELEASE, candidate_generation: 1, expected_state_hash: "a".repeat(64),
      defect_class: "ACTIVATION_REFUSAL", defect_code: "OUTBOX_ACTIVATION_SOMETHING_INVENTED",
    })).toThrow(/PRE_ACTIVATION_DEFECT_CODE_UNKNOWN/);
  });

  it("keeps the activation refusal vocabulary in sync with the module that throws it", () => {
    // The recovery transition treats membership of this list as authority for a
    // CERTIFIED -> RECOVERY_REQUIRED ledger edge, so the list must be exactly
    // the set of codes the module can return - in BOTH directions.
    //
    // The earlier version of this test was tautological: it scanned the whole
    // file, and the allowlist literal lives in that file, so an invented entry
    // appeared on both sides and the subset check stayed green while the domain
    // happily accepted the invented code. The declaration is therefore cut out
    // of the scanned text before matching, and the assertion is set EQUALITY.
    const source = readFileSync(join(process.cwd(), "commerce", "src", "outbox-activation.ts"), "utf8");
    const start = source.indexOf("export const ACTIVATION_REFUSAL_CODES");
    expect(start, "the allowlist declaration must be findable to be excluded").toBeGreaterThan(-1);
    const end = source.indexOf("] as const;", start);
    expect(end).toBeGreaterThan(start);
    const withoutDeclaration = source.slice(0, start) + source.slice(end);

    const thrown = [...new Set([...withoutDeclaration.matchAll(/"(OUTBOX_[A-Z0-9_]+)"/g)].map((match) => match[1]))].sort();
    expect(thrown.length).toBeGreaterThan(10);
    expect([...ACTIVATION_REFUSAL_CODES].sort()).toEqual(thrown);
  });
});
