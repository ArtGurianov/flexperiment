import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db";
import { issueCapability } from "../../src/certification/capability";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";
import type { CertificationRun } from "../../src/certification/run";
import { liveCapabilityBlocking, supersessionDefect } from "../../src/release/supersession-safety";
import { testSecret } from "../support/certification-secret";

/**
 * Whether a session's certification of one release may be left behind.
 *
 * A failed run with nothing pending is not the proof: its payment can still be
 * resolving, or captured and not refunded. The predicate reads the state that
 * matters, and every way money or a fixture could still be in motion refuses.
 */

const SHA = "b".repeat(40);
const OTHER = "c".repeat(40);
const SESSION = "armed";
const now = new Date("2026-09-24T12:00:00.000Z");

let db: Database.Database;

const run = (over: Partial<CertificationRun> = {}, runId = "run", releaseSha = SHA) => {
  new SqliteCertificationRunStore(db).create({
    runId, revision: 1, releaseSha, phase: "NEW", direction: "CATALOGUE_CLEAN", startedAt: now.toISOString(),
    failure: { outcome: "FAILED", code: "CERTIFICATION_OCCURRENCE_CITY_MISMATCH", recordedAt: now.toISOString() },
    ...over,
  });
  // Issued long ago, so the slot is free for the next run's capability.
  const issued = new Date("2020-01-01T00:00:00.000Z");
  const live = db.prepare("SELECT id FROM certification_capabilities WHERE consumed_at IS NULL AND retired_at IS NULL").get() as { id: string } | undefined;
  if (live) db.prepare("UPDATE certification_capabilities SET consumed_at = ? WHERE id = ?").run(issued.toISOString(), live.id);
  return issueCapability(new SqliteCertificationCapabilityStore(db),
    { runId, deploymentSessionId: SESSION, releaseSha, maxAmountKopecks: 100, ttlMs: 60_000 }, issued, testSecret()).capability;
};

const fixture = (runId = "run", occurrence = "occ", sales = "CLOSED", visibility = "HIDDEN") => {
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
    VALUES (?, 'city', 'PRODUCTION CERTIFICATION', '2026-12-15T15:00:00.000Z', '2026-12-15T18:00:00.000Z', 'Europe/Moscow', 100, 1,
      'TO_BE_ANNOUNCED', 'Later', '2026-12-08T09:00:00.000Z', ?, ?)`).run(occurrence, visibility, sales);
  db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
    VALUES (?, 'CREATE_OCCURRENCE', ?, ?, '{}')`).run(runId, `create-${runId}`, occurrence);
};

let orders = 0;
const payment = (options: { state?: string; status: string; captured?: number; runId?: string; occurrence?: string }) => {
  const id = `order-${orders += 1}`;
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email,
      customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot,
      checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, resolution_reason, certification_run_id)
    VALUES (?, ?, ?, ?, 'Certification', 'c@example.invalid', 'hash', 100, 1, 'TBA', 'legal', '{}', '2026-09-24T00:00:00.000Z', 'DIRECT', ?)`)
    .run(id, `status-${id}`, `FX-${id}`, options.occurrence ?? "occ", options.runId ?? "run");
  db.prepare(`INSERT INTO payments(id, order_id, state, status, captured_amount_kopecks, provider_idempotency_key, creation_started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(`pay-${id}`, id, options.state ?? "CREATED", options.status, options.captured ?? 0, `key-${id}`, now.toISOString());
  return { orderId: id, paymentId: `pay-${id}` };
};

const refund = (paid: { orderId: string; paymentId: string }, amount: number, status: string) =>
  db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
    VALUES (?, ?, ?, ?, ?, 'certification', 'REFUND_OBLIGATION', ?, ?, 'h')`).run(`refund-${paid.paymentId}-${status}`, `public-${paid.paymentId}-${status}`, paid.orderId, paid.paymentId, amount, status, `idem-${paid.paymentId}-${status}`);

const obligation = (paid: { paymentId: string }, status: string) =>
  db.prepare("INSERT INTO refund_obligations(id, payment_id, initial_source, target_refunded_amount_kopecks, status) VALUES (?, ?, 'CUSTOMER_CANCELLATION_PARTIAL', 100, ?)")
    .run(`obligation-${paid.paymentId}`, paid.paymentId, status);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  orders = 0;
  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city', 'moscow', 'Москва')").run();
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES ('legal', 'v', datetime('now'), '{}', 1)").run();
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'RECOVERY_REQUIRED', 'NEW_LINEAGE_ONLY',
      '{"runtime":{"frontend":"a","admin":"a","commerce":"a","worker":"a"},"controlPlane":{"productionDeployRefSha":"a"}}',
      datetime('now'), datetime('now'), 1)`).run(SESSION, SHA, SHA);
});

describe("certification safe to supersede", () => {
  it("accepts attempt 5's state: a failed run that did nothing, and a retry whose one fixture never opened", () => {
    run({}, "base");
    run({}, "a2");
    fixture("a2");
    expect(supersessionDefect(db, SESSION, SHA)).toBeUndefined();
  });

  it("accepts a certification whose money went out and came back in full", () => {
    run();
    fixture();
    const paid = payment({ status: "REFUNDED", captured: 100 });
    refund(paid, 100, "SUCCEEDED");
    obligation(paid, "FULFILLED");
    expect(supersessionDefect(db, SESSION, SHA)).toBeUndefined();
  });

  it("refuses a pending command", () => {
    run({ pendingCommand: { kind: "CREATE_OCCURRENCE", idempotencyKey: "k", draft: { cityId: "city", startsAt: "s", endsAt: "e", venueDisclosureText: "v", venueAnnounceBy: "a" } } });
    expect(supersessionDefect(db, SESSION, SHA)).toBe("COMMAND_PENDING:run");
  });

  it("refuses a fixture still open or visible", () => {
    run();
    // Visible, though no longer selling: the schema itself forbids hidden and open.
    fixture("run", "occ", "CLOSED", "PUBLISHED");
    expect(supersessionDefect(db, SESSION, SHA)).toBe("FIXTURE_NOT_SHUT:occ");
  });

  it("refuses a payment still being created", () => {
    run();
    fixture();
    payment({ state: "CREATE_UNKNOWN", status: "PENDING" });
    expect(supersessionDefect(db, SESSION, SHA)).toMatch(/^PAYMENT_UNRESOLVED:/);
  });

  it("refuses a captured payment that has not been refunded", () => {
    run();
    fixture();
    payment({ status: "PAID", captured: 100 });
    expect(supersessionDefect(db, SESSION, SHA)).toMatch(/^PAYMENT_NOT_TERMINAL:.*:PAID$/);
  });

  it("refuses a refund still in flight, and one short of the capture", () => {
    run();
    fixture();
    const inFlight = payment({ status: "REFUNDED", captured: 100 });
    refund(inFlight, 100, "SUBMITTING");
    expect(supersessionDefect(db, SESSION, SHA)).toMatch(/^REFUND_IN_FLIGHT:/);
  });

  it("refuses when refunds fall short of what was captured", () => {
    run();
    fixture();
    const short = payment({ status: "REFUNDED", captured: 100 });
    refund(short, 60, "SUCCEEDED");
    expect(supersessionDefect(db, SESSION, SHA)).toMatch(/^CAPTURE_NOT_REFUNDED:/);
  });

  it("refuses an open refund obligation", () => {
    run();
    fixture();
    const paid = payment({ status: "REFUNDED", captured: 100 });
    refund(paid, 100, "SUCCEEDED");
    obligation(paid, "FULFILLING");
    expect(supersessionDefect(db, SESSION, SHA)).toMatch(/^REFUND_OBLIGATION_OPEN:/);
  });

  it("judges only the runs this session certified this release with", () => {
    run({}, "other", OTHER);
    fixture("other", "other-occ", "OPEN", "PUBLISHED");
    expect(supersessionDefect(db, SESSION, SHA)).toBeUndefined();
    expect(supersessionDefect(db, SESSION, OTHER)).toBe("FIXTURE_NOT_SHUT:other-occ");
  });
});

describe("a live capability blocking the next one", () => {
  it("blocks while unspent and unexpired, and not once it has expired or been spent", () => {
    new SqliteCertificationRunStore(db).create({ runId: "run", revision: 1, releaseSha: SHA, phase: "NEW", direction: "NORMAL", startedAt: now.toISOString() });
    const { capability } = issueCapability(new SqliteCertificationCapabilityStore(db),
      { runId: "run", deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 60_000 }, now, testSecret());
    expect(liveCapabilityBlocking(db, SESSION, now)).toContain(capability.id);
    expect(liveCapabilityBlocking(db, SESSION, new Date(now.getTime() + 61_000))).toBeUndefined();
    db.prepare("UPDATE certification_capabilities SET consumed_at = ? WHERE id = ?").run(now.toISOString(), capability.id);
    expect(liveCapabilityBlocking(db, SESSION, now)).toBeUndefined();
  });
});
