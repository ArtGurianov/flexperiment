import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import { STORE_DEFECTS, activateAttemptAuthority, activationEvidence } from "../src/outbox-activation";
import { LEGACY_EXHAUSTION_ERROR, claimForDispatch } from "../src/outbox-attempt-store";

/**
 * The activation seam: the one-way LEGACY -> ATTEMPT transfer.
 *
 * Every test here drives the ORCHESTRATION - domain.activateAttemptAuthority,
 * which owns the transaction - rather than the helper, because the properties
 * being proven are about what a caller of the release-control surface can
 * cause, and because a helper called inside a test's own transaction proves
 * nothing about the transaction the cutover will actually run in.
 *
 * The two properties worth stating up front:
 *
 *   - the assertions, the sync and the CAS are ONE transaction, so a failure
 *     anywhere leaves LEGACY authority and no attempt rows behind;
 *   - replay branches BEFORE the sync, so a second call can never copy a stale
 *     legacy snapshot over live attempt history.
 */

const MIGRATIONS = join(process.cwd(), "commerce", "migrations");
const EPOCH = { release_id: "rel-cutover", generation: 7 };
const OTHER_EPOCH = { release_id: "rel-someone-else", generation: 1 };

const template = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "activation-template-")), "template.sqlite");
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
  const file = join(mkdtempSync(join(tmpdir(), "activation-")), "commerce.sqlite");
  copyFileSync(template, file);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  open.push(db);
  return { db, domain: new CommerceDomain(db, new MockProvider()) };
};

/** A message with no attempt row: history from before attempt-aware enqueue. */
const historical = (db: Database.Database, id: string, columns: Record<string, unknown>) => {
  const base: Record<string, unknown> = {
    id, type: "TEST", recipient_email: `${id}@b.invalid`, recipient_email_hash: "h",
    template: "tpl", payload_snapshot: "{}", status: "PENDING",
    provider_idempotence_key: `key-${id}`, attempts: 0, ...columns,
  };
  const names = Object.keys(base);
  db.prepare(`INSERT INTO email_outbox(${names.join(", ")}) VALUES (${names.map((n) => `@${n}`).join(", ")})`).run(base);
};

/** A message enqueued by the attempt-aware binary: message plus shadow attempt. */
const shadowed = (db: Database.Database, id: string, columns: Record<string, unknown> = {}) => {
  historical(db, id, columns);
  db.prepare("INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, requested_at) VALUES (?, ?, 1, ?, ?)")
    .run(`a-${id}`, id, `key-${id}`, "2026-08-01T00:00:00.000Z");
};

const fence = (domain: CommerceDomain, epoch = EPOCH) =>
  domain.fenceEmailDispatch({ expected_revision: 1, reason: "cutover 0041" }, epoch);

const activate = (domain: CommerceDomain, overrides: Partial<{ expected_revision: number }> = {}, epoch = EPOCH) =>
  domain.activateAttemptAuthority({ expected_revision: 2, reason: "activate attempt authority", ...overrides }, epoch);

const authority = (db: Database.Database) =>
  db.prepare("SELECT attempt_authority, email_dispatch_paused, dispatch_owner_release_id, dispatch_owner_generation, revision FROM outbox_authority WHERE singleton = 1").get();
const attemptOf = (db: Database.Database, messageId: string) =>
  db.prepare("SELECT * FROM outbox_attempt WHERE message_id = ?").get(messageId) as Record<string, unknown>;
const events = (db: Database.Database) =>
  db.prepare("SELECT action, owner_release_id, owner_generation, revision FROM outbox_authority_events ORDER BY revision").all();

describe("activation preconditions fail closed", () => {
  it("refuses when 0041 was never applied", () => {
    // The old binary's control surface must never be able to claim a transfer
    // into a store that does not exist.
    const { db, domain } = fixture();
    fence(domain);
    db.prepare("DELETE FROM schema_migrations WHERE version = '0041_outbox_attempt.sql'").run();
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_SCHEMA_MISSING/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  // "0041 is present" is a property about ENFORCEMENT, and a table-name lookup
  // is only a proxy for it. Each object below is dropped on its own, from an
  // otherwise complete and perfectly fenced store, and activation must refuse.
  //
  // The freeze guard is the sharpest of them: without this assertion the flip
  // succeeds and leaves the store ATTEMPT-authoritative with legacy attempt
  // writes UNFROZEN, which is the single thing the cutover exists to prevent.
  for (const object of [
    ["trigger", "email_outbox_legacy_attempt_freeze_guard"],
    ["trigger", "email_outbox_dispatch_pause_guard"],
    ["trigger", "outbox_attempt_identity_immutable_guard"],
    ["trigger", "outbox_attempt_settled_immutable_guard"],
    ["trigger", "outbox_attempt_delete_guard"],
    ["index", "outbox_attempt_active_unique"],
    ["table", "outbox_attempt"],
  ] as const) {
    it(`refuses when ${object[1]} is missing`, () => {
      const { db, domain } = fixture();
      historical(db, "m1", { status: "PENDING" });
      fence(domain);
      db.exec(`DROP ${object[0].toUpperCase()} ${object[1]}`);

      expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_SCHEMA_INCOMPLETE/);
      // Named, so an operator is not left diffing the schema by hand.
      expect(() => activate(domain)).toThrow(new RegExp(object[1]));
      expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
      // No backfill survived either - the refusal happens before any write.
      if (object[1] !== "outbox_attempt") {
        expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 0 });
      }
    });
  }

  // Under LEGACY the only attempt writer is enqueue, which writes identity and
  // nothing else. These are the two mutable columns the sync does not write -
  // and reconciliation_exhausted_at has no legacy source at all - so a value
  // here would ride through the flip and become authoritative history.
  //
  // One case per column rather than a loop inside one case: the gap being
  // closed WAS a single unhandled column, so a test that stops at the first
  // failure would leave the second one unpinned.
  for (const column of ["lease_expires_at", "reconciliation_exhausted_at"]) {
    it(`refuses a shadow attempt carrying ${column}`, () => {
      const { db, domain } = fixture();
      shadowed(db, "m1");
      db.prepare(`UPDATE outbox_attempt SET ${column} = '2026-08-20T00:00:00.000Z'`).run();
      fence(domain);
      expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_UNEXPECTED_SHADOW_STATE/);
      expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
    });
  }

  it("treats every attempt column as identity, refreshed, or asserted absent", () => {
    // The gap this closes was a column the sync neither wrote nor checked. That
    // is a per-column omission, so the guard has to be per-column too: a future
    // migration adding one must land in exactly one of the three sets, or fail
    // here rather than silently in production.
    const { db } = fixture();
    const columns = (db.prepare("SELECT name FROM pragma_table_info('outbox_attempt')").all() as Array<{ name: string }>)
      .map((row) => row.name).sort();
    const identity = ["id", "message_id", "attempt_no", "provider_idempotence_key", "requested_at"];
    const refreshed = ["started_at", "provider_request_started_at", "completed_at", "provider_job_id",
      "send_try_count", "next_retry_at", "outcome", "failure_code", "failure_detail"];
    const assertedAbsent = ["lease_owner", "lease_expires_at", "reconciliation_exhausted_at"];
    expect(columns).toEqual([...identity, ...refreshed, ...assertedAbsent].sort());
  });

  it("refuses while dispatch is open", () => {
    // Activating with mail flowing would flip the authority under a send that
    // is already in the provider call.
    const { db, domain } = fixture();
    expect(() => activate(domain, { expected_revision: 1 })).toThrow(/OUTBOX_ACTIVATION_DISPATCH_NOT_FENCED/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses when the fence is held by another epoch", () => {
    // Holding a fence is not the same as owning it. This is the case CAS on
    // revision cannot cover.
    const { db, domain } = fixture();
    fence(domain, OTHER_EPOCH);
    expect(() => activate(domain, {}, EPOCH)).toThrow(/OUTBOX_DISPATCH_OWNER_CONFLICT/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses when the generation differs from the owning epoch", () => {
    // Same release, different generation is a different cutover.
    const { db, domain } = fixture();
    fence(domain);
    expect(() => activate(domain, {}, { release_id: EPOCH.release_id, generation: 8 }))
      .toThrow(/OUTBOX_DISPATCH_OWNER_CONFLICT/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses a stale expected revision", () => {
    const { db, domain } = fixture();
    fence(domain);
    expect(() => activate(domain, { expected_revision: 1 })).toThrow(/OUTBOX_AUTHORITY_REVISION_CONFLICT/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses while a send is still SENDING", () => {
    // Exclusion is not quiescence: the fence stops the NEXT send from starting
    // and says nothing about the one already at the provider.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "SENDING", send_started_at: "2026-08-29T00:00:00.000Z" });
    fence(domain);
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_NOT_DRAINED/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses while a legacy lease is held", () => {
    const { db, domain } = fixture();
    historical(db, "m1", { lease_owner: "worker-1", lease_expires_at: "2026-09-01T00:00:00.000Z" });
    fence(domain);
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_NOT_DRAINED/);
  });

  it("refuses while an attempt lease is held", () => {
    // The drain check reads the legacy columns only. A lease in the attempt
    // store would otherwise survive the flip as a claim by a worker that no
    // longer exists.
    const { db, domain } = fixture();
    shadowed(db, "m1");
    db.prepare("UPDATE outbox_attempt SET lease_owner = 'worker-1', lease_expires_at = '2026-09-01T00:00:00.000Z'").run();
    fence(domain);
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_ATTEMPT_STILL_LEASED/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses when an attempt was already settled under LEGACY", () => {
    // Under LEGACY the only attempt writer is enqueue, which creates one
    // unsettled attempt #1. A settled row means some binary wrote attempt facts
    // while they were not authoritative - and the sync SKIPS settled rows, so
    // the bogus outcome would be adopted silently.
    const { db, domain } = fixture();
    shadowed(db, "m1", { status: "FAILED", delivery_outcome: "KNOWN_FAILED" });
    db.prepare("UPDATE outbox_attempt SET outcome = 'ACCEPTED', completed_at = '2026-08-02T00:00:00.000Z'").run();
    fence(domain);
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_UNEXPECTED_SETTLED_ATTEMPT/);
    expect(attemptOf(db, "m1")).toMatchObject({ outcome: "ACCEPTED" });
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses when a successor attempt exists under LEGACY", () => {
    // Successors are created only behind ATTEMPT authority, so one here means
    // the same disagreement.
    const { db, domain } = fixture();
    shadowed(db, "m1");
    db.prepare("UPDATE outbox_attempt SET outcome = 'KNOWN_FAILED', completed_at = 'x' WHERE id = 'a-m1'").run();
    db.prepare("INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key) VALUES ('a2', 'm1', 2, 'key-successor')").run();
    fence(domain);
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_UNEXPECTED_SUCCESSOR_ATTEMPT/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("refuses when attempt #1 and its message disagree about the provider key", () => {
    // After the flip the attempt key is the one a retry would be made under.
    // Two stores disagreeing about what was sent is not something a refresh may
    // paper over.
    const { db, domain } = fixture();
    shadowed(db, "m1");
    db.prepare("UPDATE email_outbox SET provider_idempotence_key = 'key-rotated' WHERE id = 'm1'").run();
    fence(domain);
    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH/);
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY" });
  });

  it("requires a transaction", () => {
    // Every assertion above is only meaningful if nothing can commit between it
    // and the CAS.
    const { db, domain } = fixture();
    fence(domain);
    expect(() => activateAttemptAuthority(db, EPOCH, { expected_revision: 2, reason: "bare" }))
      .toThrow(/OUTBOX_ACTIVATION_TRANSACTION_REQUIRED/);
  });
});

describe("a failed activation leaves nothing behind", () => {
  it("rolls the backfill back with the transaction", () => {
    // The decisive atomicity proof: one message backfills cleanly, a second one
    // fails validation, and the FIRST one's attempt row must not survive.
    const { db, domain } = fixture();
    historical(db, "clean", { status: "PENDING" });
    shadowed(db, "broken");
    db.prepare("UPDATE email_outbox SET provider_idempotence_key = 'key-rotated' WHERE id = 'broken'").run();
    fence(domain);

    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH/);

    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt WHERE message_id = 'clean'").get()).toEqual({ n: 0 });
    expect(authority(db)).toMatchObject({ attempt_authority: "LEGACY", revision: 2 });
    expect(events(db).map((e) => (e as { action: string }).action)).toEqual(["DISPATCH_FENCED"]);
  });
});

describe("backfill maps legacy state onto attempt #1", () => {
  const cases: Array<[string, Record<string, unknown>, { outcome: string | null; completed: boolean }]> = [
    ["ACCEPTED", { status: "ACCEPTED", sent_at: "2026-08-10T00:00:00.000Z" }, { outcome: "ACCEPTED", completed: true }],
    ["SENT", { status: "SENT", sent_at: "2026-08-10T00:00:00.000Z" }, { outcome: "ACCEPTED", completed: true }],
    ["DELIVERED", { status: "DELIVERED", sent_at: "2026-08-10T00:00:00.000Z" }, { outcome: "ACCEPTED", completed: true }],
    // A bounce is a message fact decided after acceptance; the SEND was still
    // accepted, and its completion instant is sent_at, never bounced_at.
    ["BOUNCED", { status: "BOUNCED", sent_at: "2026-08-10T00:00:00.000Z", bounced_at: "2026-08-11T00:00:00.000Z" }, { outcome: "ACCEPTED", completed: true }],
    ["FAILED + KNOWN_FAILED", { status: "FAILED", delivery_outcome: "KNOWN_FAILED" }, { outcome: "KNOWN_FAILED", completed: false }],
    // The whole reason 0039 exists: an unresolved failure is message-level
    // ambiguity and must stay settleable by later evidence.
    ["FAILED + UNRESOLVED", { status: "FAILED", delivery_outcome: "UNRESOLVED" }, { outcome: null, completed: false }],
    ["SEND_UNKNOWN", { status: "SEND_UNKNOWN" }, { outcome: null, completed: false }],
    ["PENDING", { status: "PENDING" }, { outcome: null, completed: false }],
    ["SKIPPED", { status: "SKIPPED", suppressed_at: "2026-08-10T00:00:00.000Z" }, { outcome: null, completed: false }],
  ];

  for (const [name, columns, expected] of cases) {
    it(`maps ${name}`, () => {
      const { db, domain } = fixture();
      historical(db, "m1", columns);
      fence(domain);
      expect(activate(domain)).toMatchObject({ activated: true, backfilled: 1, refreshed: 0 });
      const row = attemptOf(db, "m1");
      expect(row.outcome).toBe(expected.outcome);
      // Exactly sent_at when settled as accepted, and exactly null otherwise -
      // never bounced_at, and never the cutover clock.
      expect(row.completed_at).toBe(expected.completed ? columns.sent_at : null);
    });
  }

  it("carries identity, counters and failure evidence across", () => {
    const { db, domain } = fixture();
    historical(db, "m1", {
      status: "FAILED", delivery_outcome: "KNOWN_FAILED", attempts: 4,
      created_at: "2026-07-01T00:00:00.000Z", send_started_at: "2026-07-01T00:01:00.000Z",
      provider_request_started_at: "2026-07-01T00:01:01.000Z", job_id: "job-9",
      next_attempt_at: "2026-07-02T00:00:00.000Z", last_error: "PROVIDER_REFUSED",
      provider_error_code: "403", provider_error_message: "forbidden",
    });
    fence(domain);
    activate(domain);

    expect(attemptOf(db, "m1")).toMatchObject({
      message_id: "m1", attempt_no: 1, provider_idempotence_key: "key-m1",
      requested_at: "2026-07-01T00:00:00.000Z",
      started_at: "2026-07-01T00:01:00.000Z", provider_request_started_at: "2026-07-01T00:01:01.000Z",
      provider_job_id: "job-9", next_retry_at: "2026-07-02T00:00:00.000Z",
      outcome: "KNOWN_FAILED", failure_code: "PROVIDER_REFUSED",
      // send_try_count is the try counter for THIS attempt. Legacy `attempts`
      // backfills into it directly and must never be read as a count of
      // logical attempts.
      send_try_count: 4,
    });
    // Canonical JSON, not a concatenated string: this becomes evidence.
    expect(JSON.parse(String(attemptOf(db, "m1").failure_detail)))
      .toEqual({ provider_error_code: "403", provider_error_message: "forbidden" });
  });

  it("leaves failure_detail null when the provider recorded nothing", () => {
    const { db, domain } = fixture();
    historical(db, "m1", { status: "FAILED", delivery_outcome: "KNOWN_FAILED", last_error: "TIMEOUT" });
    fence(domain);
    activate(domain);
    expect(attemptOf(db, "m1").failure_detail).toBeNull();
  });

  it("reports settled attempts that carry no settlement instant", () => {
    // A refusal has no legacy counterpart - there is no failed_at - and
    // stamping the cutover clock would assert the send failed at activation
    // time. It is counted instead of invented.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "FAILED", delivery_outcome: "KNOWN_FAILED" });
    historical(db, "m2", { status: "SENT", sent_at: "2026-08-10T00:00:00.000Z" });
    fence(domain);
    expect(activate(domain)).toMatchObject({ settled_without_completion: 1 });
  });
});

describe("failure evidence is mapped separately from outcome", () => {
  // The five seams built a taxonomy: an attempt's failure_code is evidence
  // about THIS SEND. Copying legacy last_error unconditionally would let
  // activation undo it in one statement, and the two shapes below are exactly
  // where it shows.

  it("does not turn a suppression reason into attempt failure evidence", () => {
    // Seam 4: legacy last_error is a compatibility slot for legacyReason - a
    // consent withdrawal is a message-level fact, not a provider or send
    // failure. Under ATTEMPT nothing writes it, so activation must not either.
    const { db, domain } = fixture();
    historical(db, "m1", {
      status: "SKIPPED", suppressed_at: "2026-08-20T00:00:00.000Z",
      last_error: "CITY_INTEREST_CONSENT_WITHDRAWN",
    });
    fence(domain);
    activate(domain);

    expect(attemptOf(db, "m1")).toMatchObject({ outcome: null, failure_code: null, failure_detail: null });
  });

  it("does not turn the scheduler's own exhaustion decision into provider evidence", () => {
    // Seam 3: legacy exhaustion writes its budget decision into last_error AND
    // provider_error_code, where it reads exactly like something the provider
    // said. Under ATTEMPT exhaustion is reconciliation_exhausted_at and nothing
    // else - and FAILED + UNRESOLVED means precisely that nothing about the
    // result was established.
    const { db, domain } = fixture();
    historical(db, "m1", {
      status: "FAILED", delivery_outcome: "UNRESOLVED", attempts: 6,
      last_error: LEGACY_EXHAUSTION_ERROR,
      provider_error_code: "SEND_UNKNOWN_ATTEMPT_LIMIT",
      provider_error_message: "Ambiguous email dispatch retry limit reached.",
    });
    fence(domain);
    const result = activate(domain);

    expect(attemptOf(db, "m1")).toMatchObject({
      outcome: null, failure_code: null, failure_detail: null,
      // No invented exhaustion instant either: the legacy row has none.
      reconciliation_exhausted_at: null,
    });
    // Counted instead, so the cutover records the number.
    expect(result).toMatchObject({ exhausted_without_timestamp: 1 });
  });

  it("preserves per-send ambiguity evidence", () => {
    // The other side of the rule. UNISENDER_TRANSPORT_AMBIGUOUS IS about this
    // send, and it is exactly what the ATTEMPT branch of deferAmbiguousSend
    // writes, so dropping it would lose real evidence.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "SEND_UNKNOWN", last_error: "UNISENDER_TRANSPORT_AMBIGUOUS" });
    fence(domain);
    activate(domain);

    expect(attemptOf(db, "m1")).toMatchObject({
      outcome: null, failure_code: "UNISENDER_TRANSPORT_AMBIGUOUS", failure_detail: null,
    });
  });

  it("preserves a provider's stated refusal", () => {
    const { db, domain } = fixture();
    historical(db, "m1", {
      status: "FAILED", delivery_outcome: "KNOWN_FAILED", last_error: "UNISENDER_HTTP_REJECTED",
      provider_error_code: "403", provider_error_message: "forbidden",
    });
    fence(domain);
    activate(domain);

    expect(attemptOf(db, "m1")).toMatchObject({ outcome: "KNOWN_FAILED", failure_code: "UNISENDER_HTTP_REJECTED" });
    expect(JSON.parse(String(attemptOf(db, "m1").failure_detail)))
      .toEqual({ provider_error_code: "403", provider_error_message: "forbidden" });
  });

  it("carries no failure evidence onto an accepted attempt", () => {
    // Matches recordProviderAcceptance in both authorities, which clears it.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "DELIVERED", sent_at: "2026-08-10T00:00:00.000Z", last_error: "stale" });
    fence(domain);
    activate(domain);
    expect(attemptOf(db, "m1")).toMatchObject({ outcome: "ACCEPTED", failure_code: null, failure_detail: null });
  });

  it("applies the same rule on the refresh path", () => {
    // Both statements share the mapping, and a fix applied to one of them only
    // is the exact shape of the defect this replaces.
    const { db, domain } = fixture();
    shadowed(db, "m1", {
      status: "SKIPPED", suppressed_at: "2026-08-20T00:00:00.000Z", last_error: "CITY_INTEREST_CONSENT_WITHDRAWN",
    });
    shadowed(db, "m2", {
      status: "FAILED", delivery_outcome: "UNRESOLVED", last_error: LEGACY_EXHAUSTION_ERROR,
      provider_error_code: "SEND_UNKNOWN_ATTEMPT_LIMIT",
    });
    fence(domain);
    expect(activate(domain)).toMatchObject({ refreshed: 2, backfilled: 0 });

    expect(attemptOf(db, "m1")).toMatchObject({ failure_code: null, failure_detail: null });
    expect(attemptOf(db, "m2")).toMatchObject({ failure_code: null, failure_detail: null, reconciliation_exhausted_at: null });
  });
});

describe("refresh syncs shadow attempts without touching identity", () => {
  it("adopts legacy progress onto an attempt created by enqueue", () => {
    const { db, domain } = fixture();
    shadowed(db, "m1", {
      status: "SENT", attempts: 2, sent_at: "2026-08-10T00:00:00.000Z",
      send_started_at: "2026-08-09T00:00:00.000Z", job_id: "job-1",
    });
    fence(domain);
    expect(activate(domain)).toMatchObject({ activated: true, refreshed: 1, backfilled: 0 });
    expect(attemptOf(db, "m1")).toMatchObject({
      id: "a-m1", outcome: "ACCEPTED", provider_job_id: "job-1", send_try_count: 2,
      completed_at: "2026-08-10T00:00:00.000Z",
    });
  });

  it("never rewrites the five identity fields", () => {
    // The oracle is the 0041 identity trigger: a refresh that touched any of
    // these would abort with OUTBOX_ATTEMPT_IDENTITY_IMMUTABLE rather than pass
    // quietly. This asserts the values directly as well, because a statement
    // that writes a column its own value is not caught by the trigger.
    const { db, domain } = fixture();
    shadowed(db, "m1", { status: "SENT", sent_at: "2026-08-10T00:00:00.000Z", created_at: "2026-08-05T00:00:00.000Z" });
    fence(domain);
    activate(domain);
    expect(attemptOf(db, "m1")).toMatchObject({
      id: "a-m1", message_id: "m1", attempt_no: 1, provider_idempotence_key: "key-m1",
      // Deliberately NOT the message's created_at: identity is validated, never
      // aligned.
      requested_at: "2026-08-01T00:00:00.000Z",
    });
  });

  it("handles a mixed store in one pass", () => {
    const { db, domain } = fixture();
    historical(db, "old-1", { status: "DELIVERED", sent_at: "2026-07-01T00:00:00.000Z" });
    historical(db, "old-2", { status: "PENDING" });
    shadowed(db, "new-1", { status: "SEND_UNKNOWN" });
    fence(domain);
    expect(activate(domain)).toMatchObject({ activated: true, backfilled: 2, refreshed: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt").get()).toEqual({ n: 3 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM email_outbox o
      WHERE NOT EXISTS (SELECT 1 FROM outbox_attempt a WHERE a.message_id = o.id AND a.attempt_no = 1)`).get())
      .toEqual({ n: 0 });
  });
});

describe("the transition itself", () => {
  it("flips authority, bumps the revision and records the epoch", () => {
    const { db, domain } = fixture();
    fence(domain);
    const result = activate(domain);
    expect(result).toMatchObject({ activated: true, replayed: false, revision: 3 });
    expect(authority(db)).toEqual({
      attempt_authority: "ATTEMPT", email_dispatch_paused: 1,
      dispatch_owner_release_id: EPOCH.release_id, dispatch_owner_generation: 7, revision: 3,
    });
    expect(events(db)).toEqual([
      { action: "DISPATCH_FENCED", owner_release_id: EPOCH.release_id, owner_generation: 7, revision: 2 },
      // Same epoch, and the RESULTING revision - an audit line naming the
      // pre-transition revision would not identify the state it produced.
      { action: "AUTHORITY_ACTIVATED", owner_release_id: EPOCH.release_id, owner_generation: 7, revision: 3 },
    ]);
  });

  it("does not unfence dispatch", () => {
    // Activation and reopening mail are separate acts by separate steps of the
    // cutover; the fence is released only after convergence is proven.
    const { db, domain } = fixture();
    fence(domain);
    activate(domain);
    expect(authority(db)).toMatchObject({ email_dispatch_paused: 1 });
  });

  it("freezes legacy attempt writes from the moment it commits", () => {
    // State C. The 0040 guard is inert until exactly here.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "PENDING" });
    fence(domain);
    activate(domain);
    expect(() => db.prepare("UPDATE email_outbox SET attempts = 5 WHERE id = 'm1'").run())
      .toThrow(/EMAIL_OUTBOX_LEGACY_ATTEMPT_FROZEN/);
  });

  it("produces attempts the converted runtime can immediately claim", () => {
    // The load-bearing convergence proof: it is not enough that the backfilled
    // rows look right, the ATTEMPT-authority claim path has to be able to run
    // on them. A shape the runtime cannot consume would strand every historical
    // message the moment the fence lifts.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "PENDING", attempts: 1, next_attempt_at: "2026-08-01T00:00:00.000Z" });
    fence(domain);
    activate(domain);
    // Unfence, because the claim transition is exactly what the fence blocks.
    domain.unfenceEmailDispatch({ expected_revision: 3, reason: "cutover complete" }, EPOCH);

    const claimed = db.transaction(() =>
      claimForDispatch(db, { id: "m1", provider_idempotence_key: "key-m1" }, "worker-1", "2026-08-30T00:00:00.000Z")).immediate();

    expect(claimed).toMatchObject({ authority: "ATTEMPT", provider_idempotence_key: "key-m1", attempt_no: 1 });
    expect(attemptOf(db, "m1")).toMatchObject({ lease_owner: "worker-1", send_try_count: 2 });
  });
});

describe("convergence evidence for the cutover controller", () => {
  it("is null before the attempt store exists", () => {
    // Load-bearing: before the 0041-aware candidate is deployed, the ABSENCE of
    // this field is what proves the old runtime is still answering. A zeroed
    // record would read as a converged store.
    const { db } = fixture();
    db.exec("DROP TABLE outbox_attempt");
    expect(activationEvidence(db)).toBeNull();
  });

  it("reports a converged store after activation", () => {
    const { db, domain } = fixture();
    historical(db, "accepted", { status: "SENT", sent_at: "2026-08-10T00:00:00.000Z" });
    historical(db, "failed", { status: "FAILED", delivery_outcome: "KNOWN_FAILED" });
    shadowed(db, "pending", { status: "PENDING" });
    fence(domain);
    activate(domain);

    expect(activationEvidence(db)).toEqual({
      messages: 3, attempts: 3,
      defects: { messages_without_attempt: 0, provider_key_mismatches: 0, incomplete_identity: 0, ambiguous_messages: 0 },
      unsettled: 1, settled_accepted: 1, settled_known_failed: 1, leased: 0,
    });
  });

  it("reports the defect that activation would have refused", () => {
    // The controller reads the same numbers the transaction refuses on, so a
    // pre-flight and the transaction cannot disagree about whether the store is
    // ready.
    const { db, domain } = fixture();
    shadowed(db, "m1");
    db.prepare("UPDATE email_outbox SET provider_idempotence_key = 'key-rotated' WHERE id = 'm1'").run();
    fence(domain);

    expect(() => activate(domain)).toThrow(/OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH/);
    expect(activationEvidence(db)!.defects.provider_key_mismatches).toBe(1);
  });

  it("computes evidence and enforcement from one set of predicates", () => {
    // Not a style preference. A controller checking convergence with its own
    // copy of this SQL would be proving a restatement, and the copies would
    // drift at the first schema change. The assertion is that every defect the
    // transaction refuses on is also a reported key, and nothing else is.
    expect(Object.keys(STORE_DEFECTS).sort()).toEqual([
      "ambiguous_messages", "incomplete_identity", "messages_without_attempt", "provider_key_mismatches",
    ]);
    const { db } = fixture();
    expect(Object.keys(activationEvidence(db)!.defects).sort()).toEqual(Object.keys(STORE_DEFECTS).sort());
  });

  it("surfaces the activation audit line over the domain reader", () => {
    // "The activation was recorded" must be checkable from outside the
    // transaction that wrote the record.
    const { db, domain } = fixture();
    fence(domain);
    activate(domain);

    const surface = domain.outboxAuthority();
    expect(surface).toMatchObject({
      attempt_authority: "ATTEMPT", email_dispatch_paused: true, revision: 3,
      dispatch: { drained: true, sending: 0, leased: 0 },
      last_event: {
        action: "AUTHORITY_ACTIVATED", owner_release_id: EPOCH.release_id,
        owner_generation: 7, revision: 3,
      },
    });
    expect(surface.attempts).not.toBeNull();
    // The reader agrees with the durable row it claims to report.
    expect(db.prepare(`SELECT action, owner_release_id, owner_generation, revision
      FROM outbox_authority_events ORDER BY revision DESC LIMIT 1`).get())
      .toEqual({ action: "AUTHORITY_ACTIVATED", owner_release_id: EPOCH.release_id, owner_generation: 7, revision: 3 });
  });
});

describe("replay branches before any sync", () => {
  it("reconciles a repeat by the same epoch without consuming a revision", () => {
    const { db, domain } = fixture();
    historical(db, "m1", { status: "PENDING" });
    fence(domain);
    activate(domain);

    const again = activate(domain, { expected_revision: 3 });
    expect(again).toMatchObject({ activated: false, replayed: true, revision: 3 });
    expect(authority(db)).toMatchObject({ revision: 3 });
    expect(events(db).filter((e) => (e as { action: string }).action === "AUTHORITY_ACTIVATED")).toHaveLength(1);
  });

  it("does not re-run the sync over live attempt history", () => {
    // The decisive replay proof. After the flip the attempt row is the
    // authority and the legacy status is a projection that may legitimately
    // move on. A replay that reached the sync would copy that projection back
    // over history - here, settling an attempt the runtime deliberately left
    // open.
    const { db, domain } = fixture();
    historical(db, "m1", { status: "PENDING" });
    fence(domain);
    activate(domain);
    expect(attemptOf(db, "m1").outcome).toBeNull();

    db.prepare("UPDATE email_outbox SET status = 'SENT', sent_at = '2026-08-30T00:00:00.000Z' WHERE id = 'm1'").run();
    expect(activate(domain, { expected_revision: 3 })).toMatchObject({ replayed: true, backfilled: 0, refreshed: 0 });

    expect(attemptOf(db, "m1").outcome).toBeNull();
    expect(attemptOf(db, "m1").completed_at).toBeNull();
  });

  it("does not backfill messages created after the flip", () => {
    // Same property from the other side: a replay must not mint attempt rows
    // out of whatever the legacy table happens to hold now.
    const { db, domain } = fixture();
    fence(domain);
    activate(domain);
    historical(db, "later", { status: "PENDING" });

    expect(activate(domain, { expected_revision: 3 })).toMatchObject({ replayed: true, backfilled: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox_attempt WHERE message_id = 'later'").get()).toEqual({ n: 0 });
  });

  it("refuses a replay claimed by a different epoch", () => {
    const { db, domain } = fixture();
    fence(domain);
    activate(domain);
    expect(() => activate(domain, { expected_revision: 3 }, OTHER_EPOCH))
      .toThrow(/OUTBOX_ACTIVATION_OWNER_CONFLICT/);
    // The refusal changes nothing: the first epoch's activation still stands,
    // unamended and unclaimed.
    expect(authority(db)).toMatchObject({ attempt_authority: "ATTEMPT", revision: 3, dispatch_owner_release_id: EPOCH.release_id });
    expect(events(db).filter((e) => (e as { action: string }).action === "AUTHORITY_ACTIVATED"))
      .toEqual([{ action: "AUTHORITY_ACTIVATED", owner_release_id: EPOCH.release_id, owner_generation: 7, revision: 3 }]);
  });

  it("refuses a replay when the audit stream does not explain the state", () => {
    // ATTEMPT authority with no activation line is an inconsistent control
    // plane, not a replay, and reconciling it as success would launder it.
    const { db, domain } = fixture();
    fence(domain);
    activate(domain);
    db.prepare("DELETE FROM outbox_authority_events WHERE action = 'AUTHORITY_ACTIVATED'").run();
    expect(() => activate(domain, { expected_revision: 3 })).toThrow(/OUTBOX_ACTIVATION_AUDIT_MISSING/);
  });
});
