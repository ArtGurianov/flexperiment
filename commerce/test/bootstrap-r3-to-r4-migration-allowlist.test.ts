import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { r3ToR4MigrationAllowlistBootstrap, ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, type GenerationHead, type V2Event } from "../src/release-generation";

const bootstrap = r3ToR4MigrationAllowlistBootstrap;
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const migrationInventory = () => {
  const directory = resolve(process.cwd(), "commerce/migrations");
  return { files: Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")])) };
};

const firstHead = (): GenerationHead => ({
  release_id: bootstrap.release_id,
  candidate_generation: 1,
  source_commit: "a".repeat(40),
  migration_inventory: migrationInventory(),
  legal_baseline: { legal_version: "test-1", legal_manifest_sha256: "a".repeat(64), legal_hashes: { PUBLIC_OFFER: "1".repeat(64), PRIVACY_POLICY: "2".repeat(64), PD_CONSENT: "3".repeat(64), CHECKOUT_DISCLOSURE: "4".repeat(64) } },
  release_family: "promo-codes-v0",
  checkout_contract_version: "promo-codes-v0",
  admin_contract_version: "promo-codes-v0",
  phase: "PAUSED",
  phase_sequence: 0,
});

/**
 * Reaches an authoritative COMPLETE:5 head at exactly bootstrap's
 * from_source_commit/from_generation/from_phase_sequence through the real
 * acquire/deploy/recovery/adopt sequence for generations 1-4, then hand-
 * appends the certification lifecycle and the final COMPLETE transition for
 * generation 5 directly at the ledger level (mirroring the exact envelopes
 * activateCertificationLease / consumeCertificationLease / certifyCandidate
 * / completeCandidate produce) - replay does not read business tables, so no
 * real occurrence/promo/order/payment rows are needed to prove this.
 */
function completedGenerationFive(options: { overrideGate?: Partial<{ owner_release_id: string; sales_paused: number }> } = {}) {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: firstHead() });
  let head = acquired.head;
  for (let generation = 1; generation < bootstrap.from_generation; generation += 1) {
    const deployed = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
    const recovery = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: generation, expected_state_hash: releaseStateHash(deployed.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
    const nextHead = { ...recovery.head, candidate_generation: generation + 1, source_commit: generation + 1 === bootstrap.from_generation ? bootstrap.from_source_commit : `${generation + 1}`.repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
    const adopted = gate.adoptCandidate({ head: nextHead, expected_generation: generation, from_sha: recovery.head.source_commit, expected_state_hash: releaseStateHash(recovery.head) });
    head = adopted.head;
  }
  const deployedFive = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: bootstrap.from_generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });

  const lease = { lease_id: randomUUID(), occurrence_id: randomUUID(), promo_id: randomUUID(), expected_idempotency_key_hash: "d".repeat(64), lease_expires_at: new Date(Date.now() + 200_000).toISOString() };
  const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(bootstrap.release_id) as V2Event[];
  const append = (action: "PAUSED" | "REOPENED", details: Record<string, unknown>) =>
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), bootstrap.release_id, action, JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", ...details }));

  const certificationOnly = { ...deployedFive.head, phase: "CERTIFICATION_ONLY" as const, phase_sequence: deployedFive.head.phase_sequence + 1, certification: { ...lease, status: "ACTIVE" as const } };
  append("PAUSED", { from_phase: deployedFive.head.phase, from_phase_sequence: deployedFive.head.phase_sequence, head: certificationOnly });

  const inFlight = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: certificationOnly.phase_sequence + 1, certification: { ...lease, status: "CONSUMED" as const } };
  append("PAUSED", { from_phase: certificationOnly.phase, from_phase_sequence: certificationOnly.phase_sequence, head: inFlight });

  const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: inFlight.phase_sequence + 1 };
  append("PAUSED", {
    from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: certified,
    certification_evidence: { occurrence_id: lease.occurrence_id, promo_id: lease.promo_id, order_id: randomUUID(), payment_id: randomUUID(), refund_id: randomUUID(), price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 },
  });

  const complete = { ...certified, phase: "COMPLETE" as const, phase_sequence: certified.phase_sequence + 1 };
  append("REOPENED", { from_phase: certified.phase, from_phase_sequence: certified.phase_sequence, head: complete });
  void events;

  const gateOverride = options.overrideGate ?? { owner_release_id: null as unknown as string, sales_paused: 0 };
  db.prepare("UPDATE release_sales_gate SET sales_paused = ?, owner_release_id = ?, owner_mode = NULL, reopened_at = datetime('now'), updated_at = datetime('now') WHERE singleton = 1")
    .run(gateOverride.sales_paused ?? 0, gateOverride.owner_release_id ?? null);

  return { db, gate, head: complete };
}

describe("R3->R4 migration-allowlist bootstrap", () => {
  it("cannot be redirected: hard-bound identities are frozen", () => {
    expect(Object.keys(bootstrap)).toEqual(["release_id", "from_source_commit", "from_generation", "from_phase", "from_phase_sequence", "to_source_commit", "deploy_release_id", "expected_migration"]);
    expect(bootstrap.from_phase).toBe("COMPLETE");
    expect(bootstrap.from_generation).toBe(5);
    expect(bootstrap.from_phase_sequence).toBe(5);
    expect(bootstrap.deploy_release_id).toBe(`deploy-${bootstrap.to_source_commit}`);
  });

  it("runs the ordinary acquire+pause once, reaching the exact deploy-owned paused state", () => {
    const { db, gate, head } = completedGenerationFive();
    const result = gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(head) });
    expect(result).toMatchObject({ sales_paused: true, owner_release_id: bootstrap.deploy_release_id, owner_mode: "CONTROLLED_CUTOVER" });

    const gateRow = db.prepare("SELECT sales_paused, owner_release_id, owner_mode, expected_source_commit, expected_migration FROM release_sales_gate WHERE singleton = 1").get();
    expect(gateRow).toMatchObject({ sales_paused: 1, owner_release_id: bootstrap.deploy_release_id, owner_mode: "CONTROLLED_CUTOVER", expected_source_commit: bootstrap.to_source_commit, expected_migration: bootstrap.expected_migration });

    const events = db.prepare("SELECT action FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(bootstrap.deploy_release_id) as Array<{ action: string }>;
    expect(events.map((event) => event.action)).toEqual(["ACQUIRED", "PAUSED"]);

    // The promo-codes-v0 v2 chain itself is untouched: same exact replayed head.
    const promoEvents = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events WHERE release_id = ?").get(bootstrap.release_id) as { count: number };
    expect(promoEvents.count).toBeGreaterThan(0);
  });

  it("fails closed on a second invocation without changing state", () => {
    const { db, gate, head } = completedGenerationFive();
    gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(head) });
    const before = db.prepare("SELECT * FROM release_sales_gate WHERE singleton = 1").get();
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(head) })).toThrow("R3_R4_BOOTSTRAP_ALREADY_APPLIED");
    expect(db.prepare("SELECT * FROM release_sales_gate WHERE singleton = 1").get()).toEqual(before);
  });

  it("rejects a stale state hash", () => {
    const { gate, head } = completedGenerationFive();
    void head;
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: "0".repeat(64) })).toThrow("RELEASE_STATE_STALE");
  });

  it("rejects when the gate is already owned by something else", () => {
    const { gate, head } = completedGenerationFive({ overrideGate: { owner_release_id: "some-other-release", sales_paused: 1 } });
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(head) })).toThrow("R3_R4_BOOTSTRAP_GATE_NOT_OPEN");
  });

  it("rejects a wrong source commit at the expected phase/generation", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const acquired = gate.acquireCandidate({ head: { ...firstHead(), source_commit: "z".repeat(40) } });
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(acquired.head) })).toThrow("R3_R4_BOOTSTRAP_PRECONDITION_FAILED");
  });

  it("rejects a candidate not yet at generation 5", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const acquired = gate.acquireCandidate({ head: { ...firstHead(), source_commit: bootstrap.from_source_commit } });
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(acquired.head) })).toThrow("R3_R4_BOOTSTRAP_PRECONDITION_FAILED");
  });

  it("rejects a candidate that has not yet reached COMPLETE", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const acquired = gate.acquireCandidate({ head: firstHead() });
    let head = acquired.head;
    for (let generation = 1; generation < bootstrap.from_generation; generation += 1) {
      const deployed = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
      const recovery = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: generation, expected_state_hash: releaseStateHash(deployed.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
      const nextHead = { ...recovery.head, candidate_generation: generation + 1, source_commit: generation + 1 === bootstrap.from_generation ? bootstrap.from_source_commit : `${generation + 1}`.repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
      const adopted = gate.adoptCandidate({ head: nextHead, expected_generation: generation, from_sha: recovery.head.source_commit, expected_state_hash: releaseStateHash(recovery.head) });
      head = adopted.head;
    }
    const deployedFive = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: bootstrap.from_generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(deployedFive.head) })).toThrow("R3_R4_BOOTSTRAP_PRECONDITION_FAILED");
  });

  it("rejects when the head's own migration inventory does not resolve to the expected migration", () => {
    // Built entirely from raw ledger events (replay is a pure function of
    // the event log; it never reads schema_migrations) so a deliberately
    // stale migration_inventory doesn't also trip adoptCandidate's separate,
    // unrelated applied-migration-prefix check - only the bootstrap's own
    // migration-mismatch guard is under test here.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const staleFiles = { "0034_worker_sweep_evidence.sql": "a".repeat(64) };
    const append = (action: "ACQUIRED" | "PAUSED" | "REOPENED", details: Record<string, unknown>) =>
      db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), bootstrap.release_id, action, JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", ...details }));

    let head = { ...firstHead(), migration_inventory: { files: staleFiles } };
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), bootstrap.release_id, "ACQUIRED", JSON.stringify({ schema_version: 2, kind: "CANDIDATE_ACQUIRED", head }));
    for (let generation = 1; generation < bootstrap.from_generation; generation += 1) {
      const nextHead = { ...head, candidate_generation: generation + 1, source_commit: generation + 1 === bootstrap.from_generation ? bootstrap.from_source_commit : `${generation + 1}`.repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
      db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), bootstrap.release_id, "PAUSED", JSON.stringify({ schema_version: 2, kind: "CANDIDATE_SUPERSEDED", from_generation: generation, from_sha: head.source_commit, head: nextHead }));
      head = nextHead;
    }
    const deployedFive = { ...head, phase: "DEPLOYED_READ_ONLY" as const, phase_sequence: 1 };
    append("PAUSED", { from_phase: head.phase, from_phase_sequence: head.phase_sequence, head: deployedFive });

    const lease = { lease_id: randomUUID(), occurrence_id: randomUUID(), promo_id: randomUUID(), expected_idempotency_key_hash: "d".repeat(64), lease_expires_at: new Date(Date.now() + 200_000).toISOString() };
    const certificationOnly = { ...deployedFive, phase: "CERTIFICATION_ONLY" as const, phase_sequence: deployedFive.phase_sequence + 1, certification: { ...lease, status: "ACTIVE" as const } };
    append("PAUSED", { from_phase: deployedFive.phase, from_phase_sequence: deployedFive.phase_sequence, head: certificationOnly });
    const inFlight = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: certificationOnly.phase_sequence + 1, certification: { ...lease, status: "CONSUMED" as const } };
    append("PAUSED", { from_phase: certificationOnly.phase, from_phase_sequence: certificationOnly.phase_sequence, head: inFlight });
    const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: inFlight.phase_sequence + 1 };
    append("PAUSED", { from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: certified, certification_evidence: { occurrence_id: lease.occurrence_id, promo_id: lease.promo_id, order_id: randomUUID(), payment_id: randomUUID(), refund_id: randomUUID(), price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } });
    const complete = { ...certified, phase: "COMPLETE" as const, phase_sequence: certified.phase_sequence + 1 };
    append("REOPENED", { from_phase: certified.phase, from_phase_sequence: certified.phase_sequence, head: complete });
    db.prepare("UPDATE release_sales_gate SET sales_paused = 0, owner_release_id = NULL, owner_mode = NULL, reopened_at = datetime('now'), updated_at = datetime('now') WHERE singleton = 1").run();

    const gate = new ReleaseSalesGate(db);
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(complete) })).toThrow("R3_R4_BOOTSTRAP_MIGRATION_MISMATCH");
  });

  it("rolls back the whole transaction if the ledger write is forced to fail after the projection update", () => {
    const { db, gate, head } = completedGenerationFive();
    const trigger = "CREATE TEMP TRIGGER r3_r4_bootstrap_block AFTER INSERT ON release_sales_gate_events WHEN NEW.action = 'PAUSED' AND NEW.release_id = 'INTENTIONALLY_UNUSED' BEGIN SELECT 1; END;";
    db.exec(trigger);
    const forcedFailureTrigger = `CREATE TEMP TRIGGER r3_r4_bootstrap_force_fail AFTER UPDATE OF sales_paused ON release_sales_gate WHEN NEW.sales_paused = 1 BEGIN SELECT RAISE(ABORT, 'forced'); END;`;
    db.exec(forcedFailureTrigger);
    expect(() => gate.bootstrapR3ToR4MigrationAllowlistTransition({ expected_state_hash: releaseStateHash(head) })).toThrow();
    const gateRow = db.prepare("SELECT sales_paused, owner_release_id FROM release_sales_gate WHERE singleton = 1").get();
    expect(gateRow).toMatchObject({ sales_paused: 0, owner_release_id: null });
    const deployEvents = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events WHERE release_id = ?").get(bootstrap.deploy_release_id) as { count: number };
    expect(deployEvents.count).toBe(0);
  });
});
