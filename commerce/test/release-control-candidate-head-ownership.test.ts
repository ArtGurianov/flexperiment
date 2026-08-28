import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { ReleaseSalesGate, type ReleaseControlRequest } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";

/**
 * candidateHead() (GET /v1/admin/release-control/candidates/head) shares its
 * ownership-consistency classification with assertNewOrdersOpen() (the
 * checkout-path gate) via ReleaseSalesGate.reconcileGateOwnership(). This
 * file exercises candidateHead() itself against the same matrix already
 * proven for assertNewOrdersOpen() in assert-new-orders-open-ownership.test.ts,
 * plus the head-selection/state-hash behavior specific to this read path -
 * the previous absence of this file is exactly what let a completed v2 epoch
 * + ordinary generic owner (the real production shape) be misclassified as
 * RELEASE_STATE_CORRUPT here while the checkout path already accepted it.
 */

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const legalBaseline = { legal_version: "v1", legal_manifest_sha256: "a".repeat(64), legal_hashes: { PUBLIC_OFFER: "1".repeat(64), PRIVACY_POLICY: "2".repeat(64), PD_CONSENT: "3".repeat(64), CHECKOUT_DISCLOSURE: "4".repeat(64) } };
const genericMigration = "0036_tochka_provider_error_evidence.sql";

const freshHead = (releaseId: string): GenerationHead => ({
  release_id: releaseId, candidate_generation: 1, source_commit: "a".repeat(40),
  migration_inventory: { files: { "0001_initial.sql": "b".repeat(64) } },
  legal_baseline: legalBaseline, release_family: "promo-codes-v0",
  checkout_contract_version: "promo-codes-v0", admin_contract_version: "promo-codes-v0",
  phase: "PAUSED", phase_sequence: 0,
});

const setupDb = () => { const db = openDatabase(":memory:"); databases.push(db); migrate(db); return db; };

const appendRaw = (db: ReturnType<typeof openDatabase>, releaseId: string, action: "PAUSED" | "REOPENED", details: Record<string, unknown>) =>
  db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), releaseId, action, JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", ...details }));

const setGate = (db: ReturnType<typeof openDatabase>, input: { owner: string | null; paused: boolean; expectedSourceCommit?: string; expectedMigration?: string }) =>
  db.prepare("UPDATE release_sales_gate SET owner_release_id = ?, sales_paused = ?, owner_mode = ?, expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ? WHERE singleton = 1")
    .run(input.owner, input.paused ? 1 : 0, input.owner ? "CONTROLLED_CUTOVER" : null, input.expectedSourceCommit ?? null, input.expectedMigration ?? null, input.owner ? legalBaseline.legal_version : null, input.owner ? legalBaseline.legal_manifest_sha256 : null);

/** Directly inserts a raw legacy (non-v2) event by action only, for
 * anomalous sequences that are not reachable through the real acquire/pause
 * /reopen API (e.g. REOPENED while the gate is still owned). */
const appendGenericAction = (db: ReturnType<typeof openDatabase>, releaseId: string, action: "ACQUIRED" | "PAUSED" | "REOPENED") =>
  db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), releaseId, action, JSON.stringify({}));

const genericRequest = (releaseId: string, sourceCommit = "f".repeat(40)): ReleaseControlRequest => ({
  release_id: releaseId, mode: "CONTROLLED_CUTOVER",
  expected: { source_commit: sourceCommit, migration: genericMigration, legal_version: legalBaseline.legal_version, legal_manifest_sha256: legalBaseline.legal_manifest_sha256, legal_hashes: legalBaseline.legal_hashes },
});

/** Reaches COMPLETE for a single generation-1 v2 release, via real acquire/deploy plus hand-appended certification-lifecycle events. */
function buildCompletedV2(db: ReturnType<typeof openDatabase>, releaseId: string) {
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: freshHead(releaseId) });
  const deployed = gate.changeCandidatePhase({ release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const lease = { lease_id: randomUUID(), occurrence_id: randomUUID(), promo_id: randomUUID(), expected_idempotency_key_hash: "d".repeat(64), lease_expires_at: new Date(Date.now() + 200_000).toISOString() };
  const certOnly = { ...deployed.head, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 2, certification: { ...lease, status: "ACTIVE" as const } };
  appendRaw(db, releaseId, "PAUSED", { from_phase: "DEPLOYED_READ_ONLY", from_phase_sequence: 1, head: certOnly });
  const inFlight = { ...certOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: 3, certification: { ...lease, status: "CONSUMED" as const } };
  appendRaw(db, releaseId, "PAUSED", { from_phase: "CERTIFICATION_ONLY", from_phase_sequence: 2, head: inFlight });
  const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: 4 };
  appendRaw(db, releaseId, "PAUSED", { from_phase: "CERTIFICATION_IN_FLIGHT", from_phase_sequence: 3, head: certified, certification_evidence: { occurrence_id: lease.occurrence_id, promo_id: lease.promo_id, order_id: randomUUID(), payment_id: randomUUID(), refund_id: randomUUID(), price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } });
  const complete = { ...certified, phase: "COMPLETE" as const, phase_sequence: 5 };
  appendRaw(db, releaseId, "REOPENED", { from_phase: "CERTIFIED", from_phase_sequence: 4, head: complete });
  return complete;
}

/** An active (non-COMPLETE) v2 release: acquired and deployed, nothing more. */
function buildActiveV2(db: ReturnType<typeof openDatabase>, releaseId: string) {
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: freshHead(releaseId) });
  const deployed = gate.changeCandidatePhase({ release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  return deployed.head;
}

/** Raw CANDIDATE_SUPERSEDED transition (release-generation.ts requires
 * candidate_generation to only ever increment by exactly 1 from an existing
 * head at PAUSED/phase_sequence 0 - there is no acquire-at-arbitrary-
 * generation entry point, matching how real generation bumps only ever
 * happen through a dedicated bridge/adopt process, never a fresh acquire). */
const supersedeCandidate = (db: ReturnType<typeof openDatabase>, releaseId: string, from: GenerationHead, nextSourceCommit: string): GenerationHead => {
  const next: GenerationHead = { ...from, candidate_generation: from.candidate_generation + 1, source_commit: nextSourceCommit, phase: "PAUSED", phase_sequence: 0 };
  db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), releaseId, "PAUSED", JSON.stringify({ schema_version: 2, kind: "CANDIDATE_SUPERSEDED", from_generation: from.candidate_generation, from_sha: from.source_commit, head: next }));
  return next;
};

/** Completes the same certification-lifecycle chain buildCompletedV2() uses,
 * but starting from an arbitrary already-deployed head - lets a fixture
 * reach COMPLETE at any candidate_generation/source_commit, not only
 * generation 1, so a test can reproduce the exact production topology
 * (generation 5) without fabricating unrelated migration/legal/certification
 * fields to force a specific hash. */
function completeFromDeployed(db: ReturnType<typeof openDatabase>, releaseId: string, deployed: GenerationHead) {
  const lease = { lease_id: randomUUID(), occurrence_id: randomUUID(), promo_id: randomUUID(), expected_idempotency_key_hash: "d".repeat(64), lease_expires_at: new Date(Date.now() + 200_000).toISOString() };
  const certOnly = { ...deployed, phase: "CERTIFICATION_ONLY" as const, phase_sequence: 2, certification: { ...lease, status: "ACTIVE" as const } };
  appendRaw(db, releaseId, "PAUSED", { from_phase: "DEPLOYED_READ_ONLY", from_phase_sequence: 1, head: certOnly });
  const inFlight = { ...certOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: 3, certification: { ...lease, status: "CONSUMED" as const } };
  appendRaw(db, releaseId, "PAUSED", { from_phase: "CERTIFICATION_ONLY", from_phase_sequence: 2, head: inFlight });
  const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: 4 };
  appendRaw(db, releaseId, "PAUSED", { from_phase: "CERTIFICATION_IN_FLIGHT", from_phase_sequence: 3, head: certified, certification_evidence: { occurrence_id: lease.occurrence_id, promo_id: lease.promo_id, order_id: randomUUID(), payment_id: randomUUID(), refund_id: randomUUID(), price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 } });
  const complete = { ...certified, phase: "COMPLETE" as const, phase_sequence: 5 };
  appendRaw(db, releaseId, "REOPENED", { from_phase: "CERTIFIED", from_phase_sequence: 4, head: complete });
  return complete;
}

/** Reaches COMPLETE at exactly the given candidate_generation, ending on the
 * given final source_commit (all earlier generations use an unrelated
 * placeholder source_commit - only the final, completed generation's source
 * needs to be the exact production value). */
function buildCompletedV2AtGeneration(db: ReturnType<typeof openDatabase>, releaseId: string, finalGeneration: number, finalSourceCommit: string) {
  const gate = new ReleaseSalesGate(db);
  let head = gate.acquireCandidate({ head: freshHead(releaseId) }).head;
  for (let generation = 1; generation < finalGeneration; generation++) {
    const nextSourceCommit = generation === finalGeneration - 1 ? finalSourceCommit : head.source_commit;
    head = supersedeCandidate(db, releaseId, head, nextSourceCommit);
  }
  const deployed = gate.changeCandidatePhase({ release_id: releaseId, candidate_generation: head.candidate_generation, expected_state_hash: releaseStateHash(head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  return completeFromDeployed(db, releaseId, deployed.head);
}

describe("candidateHead ownership classification", () => {
  it("A. production ownership shape: completed v2 + real deploy-R4 acquire+pause -> 200 exact completed head/hash", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
    const r4 = "aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const r5 = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";
    const complete = buildCompletedV2(db, releaseId);
    const expectedHash = releaseStateHash(complete);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    const request = genericRequest(`deploy-${r4}`, r5);
    gate.acquire(request);
    gate.pause(request);
    const snapshot = gate.candidateHead();
    expect(snapshot.head).toEqual(complete);
    expect(snapshot.state_hash).toBe(expectedHash);
  });

  it("exact production topology: gen5/R3/COMPLETE:5 + deploy-R4 ACQUIRED,PAUSED under R4 expectations, then updateExpectations R4->R5 -> candidateHead unchanged", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
    const r3 = "97678cc19d2549146b0d4999466a4cded9320208";
    const r4 = "aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const r5 = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";
    const deployReleaseId = `deploy-${r4}`;
    // Reproduces the exact production topology, not just the exact
    // identifiers: candidate_generation 5, source_commit R3, COMPLETE at
    // phase_sequence 5 - reached via real CANDIDATE_SUPERSEDED generation
    // bumps (1->2->3->4->5), never by acquiring directly at generation 5.
    const complete = buildCompletedV2AtGeneration(db, releaseId, 5, r3);
    expect(complete.candidate_generation).toBe(5);
    expect(complete.source_commit).toBe(r3);
    expect(complete.phase).toBe("COMPLETE");
    expect(complete.phase_sequence).toBe(5);
    const expectedHash = releaseStateHash(complete);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    // Ordinary history under R4's OWN expectations first (not R5 directly),
    // matching how the real deploy-R4 owner was actually acquired/paused.
    gate.acquire(genericRequest(deployReleaseId, r4));
    gate.pause(genericRequest(deployReleaseId, r4));
    // Then the same-owner expectations move R4 -> R5, exactly as the real
    // recoverGenericOwnerR4ToR5 recovery did - history stays [ACQUIRED, PAUSED].
    const updated = gate.updateExpectations(genericRequest(deployReleaseId, r5));
    expect(updated.owner_release_id).toBe(deployReleaseId);
    expect(updated.sales_paused).toBe(true);
    expect(updated.expected?.source_commit).toBe(r5);
    const snapshot = gate.candidateHead();
    expect(snapshot.head).toEqual(complete);
    expect(snapshot.state_hash).toBe(expectedHash);
  });

  it("B. same legitimate owner after updateExpectations (history stays ACQUIRED,PAUSED) -> candidateHead unchanged", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
    const r4 = "aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const r5 = "c".repeat(40);
    const r6 = "d".repeat(40);
    const deployReleaseId = `deploy-${r4}`;
    const complete = buildCompletedV2(db, releaseId);
    const expectedHash = releaseStateHash(complete);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    gate.acquire(genericRequest(deployReleaseId, r4));
    gate.pause(genericRequest(deployReleaseId, r4));
    gate.updateExpectations(genericRequest(deployReleaseId, r5));
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: complete, state_hash: expectedHash });
    gate.updateExpectations(genericRequest(deployReleaseId, r6));
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: complete, state_hash: expectedHash });
  });

  it("C. completed v2 + generic ACQUIRED only, unpaused -> candidate head still readable", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:release-1";
    const complete = buildCompletedV2(db, releaseId);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    gate.acquire(genericRequest("deploy-r4"));
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: complete, state_hash: releaseStateHash(complete) });
  });

  it("D. completed v2 + generic owner with no ACQUIRED at all -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: "deploy-never-acquired", paused: false, expectedSourceCommit: "f".repeat(40) });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("E. completed v2 + malformed generic sequence (PAUSED without ACQUIRED) -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    appendGenericAction(db, "deploy-r4", "PAUSED");
    setGate(db, { owner: "deploy-r4", paused: true, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("F. completed v2 + generic ACQUIRED,PAUSED,REOPENED but owner still set -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    appendGenericAction(db, "deploy-r4", "ACQUIRED");
    appendGenericAction(db, "deploy-r4", "PAUSED");
    appendGenericAction(db, "deploy-r4", "REOPENED");
    setGate(db, { owner: "deploy-r4", paused: false, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("G. active v2 + matching v2 owner/projection -> 200 active head", () => {
    const db = setupDb();
    const head = buildActiveV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: head.release_id, paused: true, expectedSourceCommit: head.source_commit, expectedMigration: "0001_initial.sql" });
    const snapshot = new ReleaseSalesGate(db).candidateHead();
    expect(snapshot.head).toEqual(head);
    expect(snapshot.state_hash).toBe(releaseStateHash(head));
  });

  it("H. active v2 + foreign generic owner -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildActiveV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: "deploy-foreign-sha", paused: true, expectedSourceCommit: "foreign-sha" });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("I. active v2 + owner=null -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildActiveV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("J. multiple active v2 heads -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    const head1 = buildActiveV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    buildActiveV2(db, "promo-codes-v0:release-2");
    setGate(db, { owner: head1.release_id, paused: true, expectedSourceCommit: head1.source_commit, expectedMigration: "0001_initial.sql" });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("K. corrupt v2 replay + generic owner -> RELEASE_STATE_CORRUPT regardless of generic state", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:release-1";
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), releaseId, "ACQUIRED", JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", head: freshHead(releaseId) }));
    setGate(db, { owner: "deploy-foreign-sha", paused: true, expectedSourceCommit: "foreign-sha" });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("L. completed v2 + owner=null + paused=false -> historical completed head readable", () => {
    const db = setupDb();
    const complete = buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    const snapshot = new ReleaseSalesGate(db).candidateHead();
    expect(snapshot.head).toEqual(complete);
    expect(snapshot.state_hash).toBe(releaseStateHash(complete));
  });

  it("M. completed v2 + owner=null + paused=true -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: true });
    expect(() => new ReleaseSalesGate(db).candidateHead()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("no v2 history at all + owner=null + paused=false -> null head, not corrupt", () => {
    const db = setupDb();
    expect(new ReleaseSalesGate(db).candidateHead()).toEqual({ schema_version: 2, head: null, state_hash: null });
  });

  it("no v2 history at all + real generic owner (never touched by v2) -> null head, not corrupt", () => {
    const db = setupDb();
    const gate = new ReleaseSalesGate(db);
    const request = genericRequest("deploy-plain");
    gate.acquire(request);
    gate.pause(request);
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: null, state_hash: null });
  });
});
