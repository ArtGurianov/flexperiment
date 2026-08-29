import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain } from "../src/domain";
import { MockProvider } from "../src/provider";
import { ReleaseSalesGate, type ReleaseRuntimeEvidence } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const SOURCE = "a".repeat(40);
const MIGRATIONS = { "0031_participant_age_band.sql": "1".repeat(64), "0032_release_sales_gate.sql": "2".repeat(64) };

const legalBaseline = {
  legal_version: "2026-08-26.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
};

const head = (releaseId: string, overrides: Partial<GenerationHead> = {}): GenerationHead => ({
  release_id: releaseId,
  candidate_generation: 1,
  source_commit: SOURCE,
  migration_inventory: { files: MIGRATIONS },
  legal_baseline: legalBaseline,
  release_family: "test-family",
  checkout_contract_version: "test-v1",
  admin_contract_version: "test-v1",
  phase: "PAUSED",
  phase_sequence: 0,
  ...overrides,
});

const evidence = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: SOURCE,
  migration_versions: Object.keys(MIGRATIONS),
  required_migrations: {},
  worker_source_commit: SOURCE,
  worker_started_at: null,
  worker_observed_at: null,
  worker_last_successful_sweep_at: null,
  legal_version: legalBaseline.legal_version,
  legal_manifest_sha256: legalBaseline.legal_manifest_sha256,
  legal_hashes: legalBaseline.legal_hashes,
  legal_publish_time: "2026-08-26T12:09:17Z",
  current_legal_copies_match: true,
  migration_source_hashes: MIGRATIONS,
  ...overrides,
} as ReleaseRuntimeEvidence);

function acquired(phase: GenerationHead["phase"] = "PAUSED") {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const releaseId = `abort-test:${randomUUID()}`;
  gate.acquireCandidate({ head: head(releaseId) });
  let current = head(releaseId);
  if (phase !== "PAUSED") {
    const next = { ...current, phase, phase_sequence: 1 };
    gate.changeCandidatePhase({ release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(current), from_phase: "PAUSED", phase_sequence: 0, to_phase: phase as "DEPLOYED_READ_ONLY" });
    current = next;
  }
  return { db, gate, releaseId, current };
}

const abortRequest = (releaseId: string, current: GenerationHead) => ({
  release_id: releaseId, candidate_generation: current.candidate_generation,
  expected_state_hash: releaseStateHash(current), reason: "operator abandoned the release",
});

const gateRow = (db: ReturnType<typeof openDatabase>) =>
  db.prepare("SELECT sales_paused, owner_release_id FROM release_sales_gate WHERE singleton = 1").get() as { sales_paused: number; owner_release_id: string | null };

describe("candidate abort", () => {
  it("aborts from PAUSED and reopens sales", () => {
    const { db, gate, releaseId, current } = acquired("PAUSED");
    expect(gateRow(db)).toEqual({ sales_paused: 1, owner_release_id: releaseId });

    const result = gate.abortCandidate(abortRequest(releaseId, current), () => evidence());
    expect(result.head.phase).toBe("ABORTED");
    expect(gateRow(db)).toEqual({ sales_paused: 0, owner_release_id: null });
    expect(() => gate.assertNewOrdersOpen()).not.toThrow();
  });

  it("aborts from DEPLOYED_READ_ONLY while the production SHA is unchanged", () => {
    const { db, gate, releaseId, current } = acquired("DEPLOYED_READ_ONLY");
    gate.abortCandidate(abortRequest(releaseId, current), () => evidence());
    expect(gateRow(db)).toEqual({ sales_paused: 0, owner_release_id: null });
  });

  it("refuses once the production SHA has moved under the generation", () => {
    const { gate, releaseId, current } = acquired("DEPLOYED_READ_ONLY");
    expect(() => gate.abortCandidate(abortRequest(releaseId, current), () => evidence({ source_commit: "9".repeat(40) })))
      .toThrow("RELEASE_ABORT_PRODUCTION_CHANGED");
  });

  /** Symmetric with the expectation authority: compare canonical inventories. */
  it("refuses once the applied migration inventory differs from acquire time", () => {
    const { gate, releaseId, current } = acquired("DEPLOYED_READ_ONLY");
    expect(() => gate.abortCandidate(abortRequest(releaseId, current), () => evidence({ migration_versions: [...Object.keys(MIGRATIONS), "0033_runtime_release_evidence.sql"] })))
      .toThrow("RELEASE_ABORT_MIGRATION_STATE_CHANGED");
  });

  it("refuses a stale generation or a mismatched state hash", () => {
    const { gate, releaseId, current } = acquired("PAUSED");
    expect(() => gate.abortCandidate({ ...abortRequest(releaseId, current), candidate_generation: 2 }, () => evidence())).toThrow("RELEASE_STATE_STALE");
    expect(() => gate.abortCandidate({ ...abortRequest(releaseId, current), expected_state_hash: "0".repeat(64) }, () => evidence())).toThrow("RELEASE_STATE_STALE");
  });

  it("replays a duplicate abort of the same generation as success", () => {
    const { db, gate, releaseId, current } = acquired("PAUSED");
    const first = gate.abortCandidate(abortRequest(releaseId, current), () => evidence());
    const replay = gate.abortCandidate({ ...abortRequest(releaseId, current), candidate_generation: 1, expected_state_hash: releaseStateHash(first.head) }, () => evidence());
    expect(replay.head.phase).toBe("ABORTED");
    expect(gateRow(db)).toEqual({ sales_paused: 0, owner_release_id: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events WHERE release_id = ?").get(releaseId)).toEqual({ n: 2 });
  });

  it("refuses a stale abort replayed against an already-aborted generation", () => {
    const { gate, releaseId, current } = acquired("PAUSED");
    const first = gate.abortCandidate(abortRequest(releaseId, current), () => evidence());
    // Same release, aborted - but the caller names the pre-abort state.
    expect(releaseStateHash(first.head)).not.toBe(releaseStateHash(current));
    expect(() => gate.abortCandidate(abortRequest(releaseId, current), () => evidence())).toThrow("RELEASE_STATE_STALE");
  });

  it("leaves the state machine usable by the ordinary controller afterwards", () => {
    const { db, gate, releaseId, current } = acquired("PAUSED");
    gate.abortCandidate(abortRequest(releaseId, current), () => evidence());
    // The whole point of abort: a new generation acquires with no repair
    // primitive, and the aborted one no longer counts as active.
    const nextId = `abort-test:${randomUUID()}`;
    expect(() => gate.acquireCandidate({ head: head(nextId) })).not.toThrow();
    expect(gateRow(db)).toEqual({ sales_paused: 1, owner_release_id: nextId });
  });

  it("does not reopen sales an operator stopped with the emergency gate", () => {
    const { db, gate, releaseId, current } = acquired("PAUSED");
    db.prepare("UPDATE emergency_sales_gate SET sales_paused = 1, revision = revision + 1 WHERE singleton = 1").run();
    gate.abortCandidate(abortRequest(releaseId, current), () => evidence());

    // The release gate is clear - ReleaseSalesGate knows nothing about the
    // emergency gate, so its own check passes...
    expect(gateRow(db)).toEqual({ sales_paused: 0, owner_release_id: null });
    expect(() => gate.assertNewOrdersOpen()).not.toThrow();
    expect(db.prepare("SELECT sales_paused FROM emergency_sales_gate WHERE singleton = 1").get()).toEqual({ sales_paused: 1 });

    // ...but the composed enforcement is what customers actually hit, and it
    // must still deny. Asserting only the release-gate half would let a future
    // refactor drop the emergency check without failing a test.
    const domain = new CommerceDomain(db, new MockProvider());
    expect(() => domain.assertNewOrdersOpen()).toThrow("SALES_TEMPORARILY_PAUSED");

    // And once the operator clears it, sales genuinely reopen.
    db.prepare("UPDATE emergency_sales_gate SET sales_paused = 0, revision = revision + 1 WHERE singleton = 1").run();
    expect(() => domain.assertNewOrdersOpen()).not.toThrow();
  });

  it("reports corruption rather than repairing a projection that already disagrees", () => {
    const { db, gate, releaseId, current } = acquired("PAUSED");
    db.prepare("UPDATE release_sales_gate SET owner_release_id = NULL, sales_paused = 0 WHERE singleton = 1").run();
    expect(() => gate.abortCandidate(abortRequest(releaseId, current), () => evidence())).toThrow("RELEASE_STATE_STALE");
  });
});
