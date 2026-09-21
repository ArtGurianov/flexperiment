import Database from "better-sqlite3";
import { migrate } from "../../src/db";
import { sha256 } from "../../src/crypto";
import { InMemoryCertificationCapabilityStore, issueCapability, type CertificationCapability } from "../../src/certification/capability";
import {
  InMemoryCertificationCheckoutAuthority, InMemoryCertificationOrderLedger,
  type CertificationCheckoutAuthority, type CertificationOrderLedger,
} from "../../src/certification/checkout-authority";
import { SqliteCertificationCheckoutAuthority, SqliteCertificationOrderLedger } from "../../src/certification/checkout-authority-sqlite";
import { InMemoryCertificationRunStore, type CertificationRun, type CertificationRunStore } from "../../src/certification/run";
import { SqliteCertificationCapabilityStore, SqliteCertificationRunStore } from "../../src/certification/store-sqlite";

/**
 * Both checkout authorities, so the contract suite runs against each.
 *
 * The in-memory one is the reference the ordering was designed against; the
 * SQLite one is what the public checkout will actually admit through. The
 * difference worth catching is the rollback: the reference restores a spent
 * capability by hand, and production gets that from the transaction - which is
 * only the same thing if it is proved to be.
 */

export const SHA = "a".repeat(40);
export const SESSION = "deploy-session";

export type AuthorityFixture = {
  readonly authority: CertificationCheckoutAuthority;
  readonly orders: CertificationOrderLedger;
  readonly capability: CertificationCapability;
  readonly runs: CertificationRunStore;
  /** Creates the order the admission stands for, the way the real checkout would. */
  readonly create: (idempotencyKey: string, runId: string) => { orderId: string; statusId: string };
  /** An order made by an ordinary customer, carrying no certification run. */
  readonly plantOrdinaryOrder: (idempotencyKey: string) => void;
  capabilityConsumedAt(id: string): string | null | undefined;
};

const runSeed = (over: Partial<CertificationRun> = {}): CertificationRun => ({
  runId: "run", revision: 1, releaseSha: SHA, phase: "CHECKOUT_SUBMITTING", direction: "FINANCIAL_EFFECT_POSSIBLE",
  startedAt: "2026-09-19T00:00:00.000Z", occurrenceId: "occ", quoteId: "quote", ...over,
});

const memory = (over: Partial<CertificationRun>, now: Date): AuthorityFixture => {
  const capabilities = new InMemoryCertificationCapabilityStore();
  const runs = new InMemoryCertificationRunStore();
  const orders = new InMemoryCertificationOrderLedger();
  runs.create(runSeed(over));
  const capability = issueCapability(capabilities, { runId: "run", deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 300_000 }, now);
  return {
    authority: new InMemoryCertificationCheckoutAuthority(capabilities, runs, orders),
    orders, capability, runs,
    create: () => ({ orderId: "order", statusId: "status" }),
    plantOrdinaryOrder: (idempotencyKey) => orders.record(idempotencyKey, { orderId: "customer-order", statusId: "customer-status", certificationRunId: "" }),
    capabilityConsumedAt: (id) => capabilities.get(id)?.consumedAt,
  };
};

const sqlite = (over: Partial<CertificationRun>, now: Date): AuthorityFixture => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);

  db.prepare("INSERT INTO cities(id, slug, title) VALUES ('city', 'test-city', 'Test City')").run();
  // Visibility and sales status spelled out: the baseline refuses a hidden
  // occurrence that is open for sale, and a fixture that leaned on a default
  // would be asserting one.
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
    VALUES ('occ', 'city', 'Certification', '2026-10-01T10:00:00.000Z', '2026-10-01T12:00:00.000Z', 'Europe/Moscow', 100, 1,
      'TO_BE_ANNOUNCED', 'Venue announced later', '2026-09-25T00:00:00.000Z', 'PUBLISHED', 'OPEN')`).run();
  // An ordinary event, which no certification run ever touched. An ordinary
  // order can only exist on one of these now.
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity,
      venue_status, venue_disclosure_text, venue_announce_by, visibility, sales_status)
    VALUES ('ordinary-occ', 'city', 'A real workshop', '2026-11-01T10:00:00.000Z', '2026-11-01T12:00:00.000Z', 'Europe/Moscow', 100, 1,
      'TO_BE_ANNOUNCED', 'Venue announced later', '2026-10-25T00:00:00.000Z', 'PUBLISHED', 'OPEN')`).run();
  db.prepare(`INSERT INTO legal_releases(id, version, effective_at, manifest_json, active)
    VALUES ('legal', '2026-09-20.1', '2026-09-20T00:00:00.000Z', '{"documents":{}}', 1)`).run();
  db.prepare(`INSERT INTO deploy_sessions(id, owner_id, mode, target_sha, candidate_id, state, rollback_authority,
      pre_deploy_topology, created_at, lease_expires_at, deployment_gate_closed)
    VALUES (?, 'owner', 'MAINTENANCE_CUTOVER', ?, ?, 'DEPLOYING', 'NEW_LINEAGE_ONLY',
      '{"runtime":{"frontend":"b","admin":"b","commerce":"b","worker":"b"},"controlPlane":{"productionDeployRefSha":"b"}}',
      '2026-09-19T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 1)`).run(SESSION, SHA, SHA);

  const runs = new SqliteCertificationRunStore(db);
  runs.create(runSeed(over));
  // The occurrence is this run's fixture, and the schema now says so: an order
  // may name a certification run only for an occurrence that run created.
  db.prepare(`INSERT INTO certification_catalogue_mutations(run_id, command_kind, command_id, occurrence_id, occurrence_json)
    VALUES ('run', 'CREATE_OCCURRENCE', 'command-1', 'occ', '{"id":"occ"}')`).run();
  const capabilities = new SqliteCertificationCapabilityStore(db);
  const capability = issueCapability(capabilities, { runId: "run", deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: 300_000 }, now);
  const orders = new SqliteCertificationOrderLedger(db);

  let created = 0;
  const insert = (idempotencyKey: string, runId: string | null, occurrenceId = runId ? "occ" : "ordinary-occ") => {
    const orderId = `order-${created += 1}`;
    const statusId = `status-${created}`;
    db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email,
        customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot,
        checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, resolution_reason, certification_run_id)
      VALUES (?, ?, ?, ?, 'Certification', 'certification@example.invalid', ?, 100, 1, 'TBA',
        'legal', '{}', '2026-09-19T00:00:00.000Z', 'DIRECT', ?)`)
      .run(orderId, statusId, `FX-CERT-${created}`, occurrenceId, sha256("certification@example.invalid"), runId);
    db.prepare("INSERT INTO checkout_idempotency(idempotency_key_hash, canonical_request_hash, order_id) VALUES (?, ?, ?)")
      .run(sha256(idempotencyKey), sha256("body"), orderId);
    return { orderId, statusId };
  };

  return {
    authority: new SqliteCertificationCheckoutAuthority(db, capabilities, runs, orders),
    orders, capability, runs,
    // What the real checkout writes: the order carrying its run, and the
    // permanent idempotency record, in the caller's transaction.
    create: (idempotencyKey: string, runId: string) => insert(idempotencyKey, runId || null),
    plantOrdinaryOrder: (idempotencyKey) => { insert(idempotencyKey, null); },
    capabilityConsumedAt: (id) => capabilities.get(id)?.consumedAt,
  };
};

export const certificationCheckoutAuthorities: ReadonlyArray<
  readonly [string, (over: Partial<CertificationRun>, now: Date) => AuthorityFixture]
> = [["in-memory", memory], ["sqlite", sqlite]];
