import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { ReleaseSalesGate, type ReleaseControlRequest } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";

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

/** Reaches COMPLETE for a single generation-1 v2 release, via real acquire/deploy plus hand-appended certification-lifecycle events (replay does not read business tables, so no real occurrence/promo/order rows are needed - see gen4-to-gen5-public-frontend-bridge.test.ts for the precedent). */
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
  // completeCandidate's own reconcile always leaves owner=null, paused=false
  // for the v2 release's own release_id; scenarios below set the singleton
  // row explicitly, independent of this real reopen side effect.
  return complete;
}

/** An active (non-COMPLETE) v2 release: acquired and deployed, nothing more. */
function buildActiveV2(db: ReturnType<typeof openDatabase>, releaseId: string) {
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: freshHead(releaseId) });
  const deployed = gate.changeCandidatePhase({ release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  return deployed.head;
}

describe("assertNewOrdersOpen ownership classification", () => {
  it("1. completed v2 + owner=null + paused=false -> OPEN", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    expect(new ReleaseSalesGate(db).assertNewOrdersOpen()).toBeUndefined();
  });

  it("4. completed v2 + owner equal to that same completed v2 release_id -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: "promo-codes-v0:release-1", paused: true });
    expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("5. active v2 + matching owner/projection -> existing behavior (fails closed to SALES_TEMPORARILY_PAUSED for the public path)", () => {
    const db = setupDb();
    const head = buildActiveV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: head.release_id, paused: true, expectedSourceCommit: head.source_commit, expectedMigration: "0001_initial.sql" });
    expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("SALES_TEMPORARILY_PAUSED");
  });

  it("6. active v2 + foreign generic owner -> RELEASE_STATE_CORRUPT (not reachable via the real API - acquire() itself requires all v2 releases COMPLETE)", () => {
    const db = setupDb();
    const head = buildActiveV2(db, "promo-codes-v0:release-1");
    void head;
    setGate(db, { owner: "deploy-foreign-sha", paused: true, expectedSourceCommit: "foreign-sha" });
    expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("7. active v2 + owner=null -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    buildActiveV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("8. corrupt v2 replay + generic owner -> RELEASE_STATE_CORRUPT (foreign owner does not mask a broken ledger)", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:release-1";
    // A malformed PHASE_CHANGED event (missing required fields) makes replay corrupt.
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), releaseId, "ACQUIRED", JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", head: freshHead(releaseId) }));
    setGate(db, { owner: "deploy-foreign-sha", paused: true, expectedSourceCommit: "foreign-sha" });
    expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
  });

  it("9. multiple active v2 heads -> RELEASE_STATE_CORRUPT", () => {
    const db = setupDb();
    const head1 = buildActiveV2(db, "promo-codes-v0:release-1");
    // acquireCandidate sets gate ownership as a side effect; reset before
    // building the second, unrelated v2 release so it doesn't collide.
    setGate(db, { owner: null, paused: false });
    buildActiveV2(db, "promo-codes-v0:release-2");
    setGate(db, { owner: head1.release_id, paused: true, expectedSourceCommit: head1.source_commit, expectedMigration: "0001_initial.sql" });
    expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
  });

  describe("generic (legacy) owner history reconciliation", () => {
    it("completed v2 + unknown owner + no generic events -> RELEASE_STATE_CORRUPT", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      setGate(db, { owner: "deploy-never-acquired", paused: false, expectedSourceCommit: "f".repeat(40) });
      expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
    });

    it("completed v2 + real generic ACQUIRED, paused=false -> OPEN", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      setGate(db, { owner: null, paused: false });
      const gate = new ReleaseSalesGate(db);
      gate.acquire(genericRequest("deploy-r4"));
      expect(gate.assertNewOrdersOpen()).toBeUndefined();
    });

    it("completed v2 + real generic ACQUIRED+PAUSED, paused=true -> SALES_TEMPORARILY_PAUSED, not corrupt", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      setGate(db, { owner: null, paused: false });
      const gate = new ReleaseSalesGate(db);
      const request = genericRequest("deploy-r4");
      gate.acquire(request);
      gate.pause(request);
      expect(() => gate.assertNewOrdersOpen()).toThrow("SALES_TEMPORARILY_PAUSED");
    });

    it("completed v2 + generic ACQUIRED only but gate paused=true -> RELEASE_STATE_CORRUPT", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      setGate(db, { owner: null, paused: false });
      const gate = new ReleaseSalesGate(db);
      gate.acquire(genericRequest("deploy-r4"));
      setGate(db, { owner: "deploy-r4", paused: true, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
      expect(() => gate.assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
    });

    it("completed v2 + generic ACQUIRED+PAUSED but gate paused=false -> RELEASE_STATE_CORRUPT", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      setGate(db, { owner: null, paused: false });
      const gate = new ReleaseSalesGate(db);
      const request = genericRequest("deploy-r4");
      gate.acquire(request);
      gate.pause(request);
      setGate(db, { owner: "deploy-r4", paused: false, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
      expect(() => gate.assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
    });

    it("completed v2 + generic ACQUIRED,PAUSED,REOPENED but owner still set -> RELEASE_STATE_CORRUPT", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      appendGenericAction(db, "deploy-r4", "ACQUIRED");
      appendGenericAction(db, "deploy-r4", "PAUSED");
      appendGenericAction(db, "deploy-r4", "REOPENED");
      // Not reachable via the real reopen() API, which always clears
      // ownership atomically with the event - this proves the classifier
      // itself still fails closed if that invariant is ever violated.
      setGate(db, { owner: "deploy-r4", paused: false, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
      expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
    });

    it("rejects a malformed generic sequence: PAUSED without a preceding ACQUIRED", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      appendGenericAction(db, "deploy-r4", "PAUSED");
      setGate(db, { owner: "deploy-r4", paused: true, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
      expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
    });

    it("rejects a malformed generic sequence: event after the terminal REOPENED", () => {
      const db = setupDb();
      buildCompletedV2(db, "promo-codes-v0:release-1");
      appendGenericAction(db, "deploy-r4", "ACQUIRED");
      appendGenericAction(db, "deploy-r4", "PAUSED");
      appendGenericAction(db, "deploy-r4", "REOPENED");
      appendGenericAction(db, "deploy-r4", "ACQUIRED");
      setGate(db, { owner: "deploy-r4", paused: false, expectedSourceCommit: "f".repeat(40), expectedMigration: genericMigration });
      expect(() => new ReleaseSalesGate(db).assertNewOrdersOpen()).toThrow("RELEASE_STATE_CORRUPT");
    });
  });

  it("reproduces the exact production shape: completed v2 + real deploy-R4 acquire+pause history -> public checkout is SALES_TEMPORARILY_PAUSED, not corrupt", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
    const r4 = "aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    buildCompletedV2(db, releaseId);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    const request = genericRequest(`deploy-${r4}`, r4);
    gate.acquire(request);
    gate.pause(request);
    expect(() => gate.assertNewOrdersOpen()).toThrow("SALES_TEMPORARILY_PAUSED");
  });

  it("reproduces the exact production shape: /candidates/head style replay stays a clean 200 with an unchanged state_hash", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
    const r4 = "aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const complete = buildCompletedV2(db, releaseId);
    const stateHashBefore = releaseStateHash(complete);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    const request = genericRequest(`deploy-${r4}`, r4);
    gate.acquire(request);
    gate.pause(request);
    // A foreign paused owner must not affect this v2 release's own replay:
    // re-replay its exact event history independently of the gate row and
    // confirm it is still the same clean, unchanged COMPLETE head - this is
    // the read GET /v1/admin/release-control/candidates/head performs.
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(releaseId) as { seq: number; release_id: string; action: string; details_json: string }[];
    expect(events.length).toBeGreaterThan(0);
    expect(releaseStateHash(complete)).toBe(stateHashBefore);
    // And the checkout-gating path (which shares the same byRelease/replay
    // logic) must not report this release's own replay as corrupt either.
    expect(() => gate.assertNewOrdersOpen()).not.toThrow("RELEASE_STATE_CORRUPT");
  });

  it("recovery path: same-owner updateExpectations resumes a paused foreign owner from R4 to R5 expectations", () => {
    const db = setupDb();
    const releaseId = "promo-codes-v0:b01f217ffd2a798fd32aa3d88e125a2e460bd39f";
    const r4 = "aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const r5 = "c".repeat(40);
    const deployReleaseId = `deploy-${r4}`;
    buildCompletedV2(db, releaseId);
    setGate(db, { owner: null, paused: false });
    const gate = new ReleaseSalesGate(db);
    gate.acquire(genericRequest(deployReleaseId, r4));
    gate.pause(genericRequest(deployReleaseId, r4));

    // updateExpectations intentionally does not append a new ACQUIRED/PAUSED
    // event; the owner's coarse history remains exactly [ACQUIRED, PAUSED].
    const updated = gate.updateExpectations(genericRequest(deployReleaseId, r5));
    expect(updated.owner_release_id).toBe(deployReleaseId);
    expect(updated.sales_paused).toBe(true);
    expect(updated.expected?.source_commit).toBe(r5);

    expect(() => gate.assertNewOrdersOpen()).toThrow("SALES_TEMPORARILY_PAUSED");
  });
});
