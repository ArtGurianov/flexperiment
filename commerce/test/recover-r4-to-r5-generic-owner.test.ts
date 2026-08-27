import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { r4ToR5GenericOwnerRecovery, ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";

const recovery = r4ToR5GenericOwnerRecovery;
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const migrationInventory = () => {
  const directory = resolve(process.cwd(), "commerce/migrations");
  return { files: Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")])) };
};

const legalBaseline = { legal_version: "test-1", legal_manifest_sha256: "a".repeat(64), legal_hashes: { PUBLIC_OFFER: "1".repeat(64), PRIVACY_POLICY: "2".repeat(64), PD_CONSENT: "3".repeat(64), CHECKOUT_DISCLOSURE: "4".repeat(64) } };

const firstHead = (): GenerationHead => ({
  release_id: recovery.promo_release_id,
  candidate_generation: 1,
  source_commit: "a".repeat(40),
  migration_inventory: migrationInventory(),
  legal_baseline: legalBaseline,
  release_family: "promo-codes-v0",
  checkout_contract_version: "promo-codes-v0",
  admin_contract_version: "promo-codes-v0",
  phase: "PAUSED",
  phase_sequence: 0,
});

/** Reaches gen5/R3/COMPLETE:5 for the promo release through real acquire/
 * deploy/recovery/adopt, then hand-appends the certification lifecycle for
 * generation 5 (replay does not read business tables). Also produces a real,
 * proven generic deploy-R4 owner (ACQUIRED + PAUSED) via the ordinary
 * acquire()/pause() API - the exact shape production is currently in. */
function productionShape() {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: firstHead() });
  let head = acquired.head;
  for (let generation = 1; generation < recovery.promo_generation; generation += 1) {
    const deployed = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
    const recovered = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: generation, expected_state_hash: releaseStateHash(deployed.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
    const nextHead = { ...recovered.head, candidate_generation: generation + 1, source_commit: generation + 1 === recovery.promo_generation ? recovery.promo_source_commit : `${generation + 1}`.repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
    const adopted = gate.adoptCandidate({ head: nextHead, expected_generation: generation, from_sha: recovered.head.source_commit, expected_state_hash: releaseStateHash(recovered.head) });
    head = adopted.head;
  }
  const deployedFive = gate.changeCandidatePhase({ release_id: head.release_id, candidate_generation: recovery.promo_generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });

  const lease = { lease_id: randomUUID(), occurrence_id: randomUUID(), promo_id: randomUUID(), expected_idempotency_key_hash: "d".repeat(64), lease_expires_at: new Date(Date.now() + 200_000).toISOString() };
  const append = (action: "PAUSED" | "REOPENED", details: Record<string, unknown>) =>
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), recovery.promo_release_id, action, JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", ...details }));

  const certificationOnly = { ...deployedFive.head, phase: "CERTIFICATION_ONLY" as const, phase_sequence: deployedFive.head.phase_sequence + 1, certification: { ...lease, status: "ACTIVE" as const } };
  append("PAUSED", { from_phase: deployedFive.head.phase, from_phase_sequence: deployedFive.head.phase_sequence, head: certificationOnly });
  const inFlight = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: certificationOnly.phase_sequence + 1, certification: { ...lease, status: "CONSUMED" as const } };
  append("PAUSED", { from_phase: certificationOnly.phase, from_phase_sequence: certificationOnly.phase_sequence, head: inFlight });
  const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: inFlight.phase_sequence + 1 };
  append("PAUSED", { from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: certified, certification_evidence: { occurrence_id: lease.occurrence_id, promo_id: lease.promo_id, order_id: randomUUID(), payment_id: randomUUID(), refund_id: randomUUID(), price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } });
  const complete = { ...certified, phase: "COMPLETE" as const, phase_sequence: certified.phase_sequence + 1 };
  append("REOPENED", { from_phase: certified.phase, from_phase_sequence: certified.phase_sequence, head: complete });
  db.prepare("UPDATE release_sales_gate SET sales_paused = 0, owner_release_id = NULL, owner_mode = NULL, reopened_at = datetime('now'), updated_at = datetime('now') WHERE singleton = 1").run();

  // Now the real, ordinary deploy-R4 generic acquire+pause, exactly as the
  // real controlled-production-deploy workflow (or the R3->R4 bootstrap)
  // would have produced it.
  const request = {
    release_id: recovery.deploy_release_id, mode: "CONTROLLED_CUTOVER" as const,
    expected: { source_commit: recovery.from_source_commit, migration: recovery.expected_migration, legal_version: legalBaseline.legal_version, legal_manifest_sha256: legalBaseline.legal_manifest_sha256, legal_hashes: legalBaseline.legal_hashes },
  };
  gate.acquire(request);
  gate.pause(request);

  return { db, gate, promoHead: complete };
}

describe("R4->R5 generic-owner recovery", () => {
  it("cannot be redirected: hard-bound identities are frozen", () => {
    expect(Object.keys(recovery)).toEqual(["promo_release_id", "promo_generation", "promo_phase", "promo_phase_sequence", "promo_source_commit", "from_source_commit", "to_source_commit", "deploy_release_id", "expected_migration"]);
    expect(recovery.promo_phase).toBe("COMPLETE");
    expect(recovery.deploy_release_id).toBe(`deploy-${recovery.from_source_commit}`);
  });

  it("changes exactly one field (expected_source_commit) on the gate row, appends zero ledger rows anywhere, and leaves the Promo v2 head byte-identical", () => {
    const { db, gate, promoHead } = productionShape();
    const stateHashBefore = releaseStateHash(promoHead);
    const beforeGateRow = db.prepare("SELECT * FROM release_sales_gate WHERE singleton = 1").get() as Record<string, unknown>;
    const beforeEventCount = (db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number }).count;
    const beforeEventRows = db.prepare("SELECT rowid, id, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all();

    const result = gate.recoverGenericOwnerR4ToR5({ expected_state_hash: stateHashBefore });
    expect(result).toMatchObject({ sales_paused: true, owner_release_id: recovery.deploy_release_id, expected: { source_commit: recovery.to_source_commit, migration: recovery.expected_migration } });

    // Exact one-field semantic delta: every other column on the singleton
    // gate row is byte-identical (updated_at is the only other column
    // allowed to change, since the UPDATE always touches it).
    const afterGateRow = db.prepare("SELECT * FROM release_sales_gate WHERE singleton = 1").get() as Record<string, unknown>;
    const { expected_source_commit: beforeSource, updated_at: beforeUpdatedAt, ...beforeRest } = beforeGateRow;
    const { expected_source_commit: afterSource, updated_at: afterUpdatedAt, ...afterRest } = afterGateRow;
    expect(beforeSource).toBe(recovery.from_source_commit);
    expect(afterSource).toBe(recovery.to_source_commit);
    expect(afterRest).toEqual(beforeRest);
    void beforeUpdatedAt; void afterUpdatedAt;

    // Zero new ledger rows anywhere in the table - not merely deploy-R4's
    // own action sequence unchanged, but the whole append-only table.
    const afterEventCount = (db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number }).count;
    expect(afterEventCount).toBe(beforeEventCount);
    const afterEventRows = db.prepare("SELECT rowid, id, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all();
    expect(afterEventRows).toEqual(beforeEventRows);

    // The owner's coarse history is exactly unchanged - updateExpectations()
    // never appends a new ACQUIRED/PAUSED event.
    const ownerEvents = db.prepare("SELECT action FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(recovery.deploy_release_id) as Array<{ action: string }>;
    expect(ownerEvents.map((e) => e.action)).toEqual(["ACQUIRED", "PAUSED"]);

    // assertNewOrdersOpen must still resolve to paused, not corrupt.
    expect(() => gate.assertNewOrdersOpen()).toThrow("SALES_TEMPORARILY_PAUSED");

    // The Promo v2 head remains completely unchanged - generation, source
    // (still R3, never R5), phase, phase_sequence, certification, and the
    // exact state_hash.
    const promoEvents = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(recovery.promo_release_id) as V2Event[];
    expect(promoEvents.length).toBeGreaterThan(0);
    expect(promoHead).toMatchObject({ release_id: recovery.promo_release_id, candidate_generation: recovery.promo_generation, source_commit: recovery.promo_source_commit, phase: recovery.promo_phase, phase_sequence: recovery.promo_phase_sequence });
    expect(releaseStateHash(promoHead)).toBe(stateHashBefore);
  });

  it("fails closed on a second invocation (expected_source is no longer R4)", () => {
    const { gate, promoHead } = productionShape();
    const stateHash = releaseStateHash(promoHead);
    gate.recoverGenericOwnerR4ToR5({ expected_state_hash: stateHash });
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: stateHash })).toThrow("R4_R5_RECOVERY_PRECONDITION_FAILED");
  });

  it("rejects a stale state hash", () => {
    const { gate } = productionShape();
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: "0".repeat(64) })).toThrow("RELEASE_STATE_STALE");
  });

  it("rejects when the gate is not owned by deploy-R4", () => {
    const { db, gate, promoHead } = productionShape();
    db.prepare("UPDATE release_sales_gate SET owner_release_id = ? WHERE singleton = 1").run("deploy-someone-else");
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: releaseStateHash(promoHead) })).toThrow("R4_R5_RECOVERY_PRECONDITION_FAILED");
  });

  it("rejects when sales_paused is not true", () => {
    const { db, gate, promoHead } = productionShape();
    db.prepare("UPDATE release_sales_gate SET sales_paused = 0 WHERE singleton = 1").run();
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: releaseStateHash(promoHead) })).toThrow("R4_R5_RECOVERY_PRECONDITION_FAILED");
  });

  it("rejects when expected_source_commit is not exactly R4", () => {
    const { db, gate, promoHead } = productionShape();
    db.prepare("UPDATE release_sales_gate SET expected_source_commit = ? WHERE singleton = 1").run("b".repeat(40));
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: releaseStateHash(promoHead) })).toThrow("R4_R5_RECOVERY_PRECONDITION_FAILED");
  });

  it("rejects when expected_migration is not the exact bound value", () => {
    const { db, gate, promoHead } = productionShape();
    db.prepare("UPDATE release_sales_gate SET expected_migration = ? WHERE singleton = 1").run("0035_promo_codes_v0.sql");
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: releaseStateHash(promoHead) })).toThrow("R4_R5_RECOVERY_PRECONDITION_FAILED");
  });

  it("rejects an owner whose own coarse history is not proven (ACQUIRED only, no PAUSED)", () => {
    const { db, gate, promoHead } = productionShape();
    db.prepare("DELETE FROM release_sales_gate_events WHERE release_id = ? AND action = 'PAUSED'").run(recovery.deploy_release_id);
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: releaseStateHash(promoHead) })).toThrow("R4_R5_RECOVERY_OWNER_NOT_PROVEN");
  });

  it("rejects when the promo head does not match the hard-bound generation/phase/source", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    // A promo release stuck at generation 1, PAUSED - not the bound gen5/COMPLETE.
    const acquired = gate.acquireCandidate({ head: firstHead() });
    db.prepare("UPDATE release_sales_gate SET owner_release_id = ?, sales_paused = 1, expected_source_commit = ?, expected_migration = ? WHERE singleton = 1")
      .run(recovery.deploy_release_id, recovery.from_source_commit, recovery.expected_migration);
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'ACQUIRED', '{}')").run(randomUUID(), recovery.deploy_release_id);
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'PAUSED', '{}')").run(randomUUID(), recovery.deploy_release_id);
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: releaseStateHash(acquired.head) })).toThrow("R4_R5_RECOVERY_PROMO_HEAD_MISMATCH");
  });

  it("rolls back the whole transaction if forced to fail immediately after updateExpectations() has already performed the real UPDATE", () => {
    // The trigger fires AFTER the row-changing UPDATE that
    // updateExpectations() itself performs - proving this recovery unwinds
    // completely (not merely "the outer wrapper never ran") when a failure
    // is injected after the real mutation already happened, not before it.
    const { db, gate, promoHead } = productionShape();
    const stateHash = releaseStateHash(promoHead);
    const beforeGateRow = db.prepare("SELECT * FROM release_sales_gate WHERE singleton = 1").get();
    const beforeEventCount = (db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number }).count;
    const beforeEventRows = db.prepare("SELECT rowid, id, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all();

    db.exec("CREATE TEMP TRIGGER r4_r5_recovery_force_fail AFTER UPDATE OF expected_source_commit ON release_sales_gate WHEN NEW.expected_source_commit != OLD.expected_source_commit BEGIN SELECT RAISE(ABORT, 'forced'); END;");
    expect(() => gate.recoverGenericOwnerR4ToR5({ expected_state_hash: stateHash })).toThrow();

    const afterGateRow = db.prepare("SELECT * FROM release_sales_gate WHERE singleton = 1").get();
    expect(afterGateRow).toEqual(beforeGateRow);
    const afterEventCount = (db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number }).count;
    expect(afterEventCount).toBe(beforeEventCount);
    const afterEventRows = db.prepare("SELECT rowid, id, release_id, action, details_json FROM release_sales_gate_events ORDER BY rowid ASC").all();
    expect(afterEventRows).toEqual(beforeEventRows);

    const promoEvents = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(recovery.promo_release_id) as V2Event[];
    const replay = replayReleaseGenerationChain(promoEvents);
    expect(replay.corrupt).toBeUndefined();
    expect(replay.head).toEqual(promoHead);
    expect(releaseStateHash(replay.head!)).toBe(stateHash);
  });
});
