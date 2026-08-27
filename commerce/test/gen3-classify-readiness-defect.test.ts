import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { gen3ReadinessClassification, ReleaseSalesGate, type ReleaseRuntimeEvidence } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const migrationInventory = () => {
  const directory = resolve(process.cwd(), "commerce/migrations");
  return { files: Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")])) };
};

const firstHead = (): GenerationHead => ({
  release_id: gen3ReadinessClassification.release_id,
  candidate_generation: 1,
  source_commit: "a".repeat(40),
  migration_inventory: migrationInventory(),
  legal_baseline: { legal_version: "test-1", legal_manifest_sha256: "a".repeat(64), legal_hashes: {} },
  release_family: "promo-codes-v0",
  checkout_contract_version: "promo-codes-v0",
  admin_contract_version: "promo-codes-v0",
  phase: "PAUSED",
  phase_sequence: 0,
});

/** Reaches a legitimate PAUSED generation-3 head through the same acquire/deploy/recovery/adopt sequence production used, so migration_inventory matches what migrate() actually applied. */
function pausedGenerationThree() {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: firstHead() });
  const deployedOne = gate.changeCandidatePhase({ release_id: acquired.head.release_id, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const recoveryOne = gate.changeCandidatePhase({ release_id: deployedOne.head.release_id, candidate_generation: 1, expected_state_hash: releaseStateHash(deployedOne.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
  const generationTwo = { ...recoveryOne.head, candidate_generation: 2, source_commit: "b".repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
  const adoptedTwo = gate.adoptCandidate({ head: generationTwo, expected_generation: 1, from_sha: recoveryOne.head.source_commit, expected_state_hash: releaseStateHash(recoveryOne.head) });
  const deployedTwo = gate.changeCandidatePhase({ release_id: adoptedTwo.head.release_id, candidate_generation: 2, expected_state_hash: releaseStateHash(adoptedTwo.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const recoveryTwo = gate.changeCandidatePhase({ release_id: deployedTwo.head.release_id, candidate_generation: 2, expected_state_hash: releaseStateHash(deployedTwo.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
  const generationThree = { ...recoveryTwo.head, candidate_generation: gen3ReadinessClassification.generation, source_commit: gen3ReadinessClassification.source_commit, phase: "PAUSED" as const, phase_sequence: 0 };
  const adoptedThree = gate.adoptCandidate({ head: generationThree, expected_generation: 2, from_sha: recoveryTwo.head.source_commit, expected_state_hash: releaseStateHash(recoveryTwo.head) });
  return { db, gate, head: adoptedThree.head };
}

const deployedEvidence = (head: GenerationHead, overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: gen3ReadinessClassification.source_commit,
  required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true },
  migration_versions: Object.keys(head.migration_inventory.files),
  migration_source_hashes: head.migration_inventory.files,
  legal_version: "2026-08-26.1",
  legal_manifest_sha256: "c".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "d".repeat(64), PRIVACY_POLICY: "e".repeat(64), PD_CONSENT: "f".repeat(64), CHECKOUT_DISCLOSURE: "1".repeat(64) },
  legal_publish_time: new Date().toISOString(),
  current_legal_copies_match: true,
  worker_source_commit: gen3ReadinessClassification.source_commit,
  worker_started_at: new Date().toISOString(),
  worker_observed_at: new Date().toISOString(),
  worker_last_successful_sweep_at: new Date().toISOString(),
  source_legal_manifest_sha256: "c".repeat(64),
  source_legal_publish_time: new Date().toISOString(),
  ...overrides,
});

describe("generation-three offline readiness classification", () => {
  it("atomically appends the bounded readiness defect for the deployed defective candidate", () => {
    const { db, gate, head } = pausedGenerationThree();
    const evidence = () => deployedEvidence(head);
    const before = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number };
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: "0".repeat(64) }, evidence)).toThrow("GEN3_CLASSIFY_PRECONDITION_FAILED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(before);
    const result = gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash(head) }, evidence);
    expect(result.head).toMatchObject({
      release_id: gen3ReadinessClassification.release_id,
      candidate_generation: gen3ReadinessClassification.generation,
      source_commit: gen3ReadinessClassification.source_commit,
      phase: "RECOVERY_REQUIRED",
      phase_sequence: 1,
    });
    expect(result.head).not.toHaveProperty("certification");
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(gen3ReadinessClassification.release_id) as V2Event[];
    expect(JSON.parse(events.at(-1)!.details_json)).toMatchObject({ kind: "RUNTIME_READINESS_DEFECT", runtime_readiness_defect: { reason: "RUNTIME_READINESS_DEFECT", readiness_component: "PROVIDER_READINESS", error_class: "PROVIDER_BAD_REQUEST", error_code: "HTTP_400", source_commit: gen3ReadinessClassification.source_commit } });
    expect(replayReleaseGenerationChain(events)).toEqual({ head: result.head });
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: result.head, state_hash: result.state_hash });
  });

  it("fails closed as ALREADY_APPLIED on a second run once gen3 is RECOVERY_REQUIRED", () => {
    const { gate, head } = pausedGenerationThree();
    const evidence = () => deployedEvidence(head);
    const result = gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash(head) }, evidence);
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: result.state_hash }, evidence)).toThrow("GEN3_CLASSIFY_ALREADY_APPLIED");
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: "0".repeat(64) }, evidence)).toThrow("GEN3_CLASSIFY_ALREADY_APPLIED");
  });

  it("rejects a stale expected_state_hash without mutating anything", () => {
    const { db, gate, head } = pausedGenerationThree();
    const evidence = () => deployedEvidence(head);
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get();
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash({ ...head, phase_sequence: 1 }) }, evidence)).toThrow("GEN3_CLASSIFY_PRECONDITION_FAILED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(eventCount);
  });

  it("cannot be redirected to another generation or source through its public input", () => {
    const { gate, head } = pausedGenerationThree();
    const evidence = () => deployedEvidence(head);
    expect(Object.keys(gen3ReadinessClassification)).toEqual(["release_id", "generation", "source_commit", "from_phase", "phase_sequence", "readiness_component", "error_class", "error_code"]);
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash({ ...head, source_commit: randomUUID() }) }, evidence)).toThrow("GEN3_CLASSIFY_PRECONDITION_FAILED");
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash({ ...head, candidate_generation: 4 }) }, evidence)).toThrow("GEN3_CLASSIFY_PRECONDITION_FAILED");
  });

  it("requires an exact owner and paused sales", () => {
    const { db, gate, head } = pausedGenerationThree();
    const evidence = () => deployedEvidence(head);
    db.prepare("UPDATE release_sales_gate SET sales_paused = 0 WHERE singleton = 1").run();
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash(head) }, evidence)).toThrow("GEN3_CLASSIFY_PRECONDITION_FAILED");
    db.prepare("UPDATE release_sales_gate SET sales_paused = 1, owner_release_id = ? WHERE singleton = 1").run(randomUUID());
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash(head) }, evidence)).toThrow("GEN3_CLASSIFY_PRECONDITION_FAILED");
  });

  it("rejects a runtime that has not deployed the classified candidate", () => {
    const { gate, head } = pausedGenerationThree();
    const stateHash = releaseStateHash(head);
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: stateHash }, () => deployedEvidence(head, { source_commit: randomUUID() }))).toThrow("GEN3_CLASSIFY_CANDIDATE_NOT_DEPLOYED");
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: stateHash }, () => deployedEvidence(head, { worker_source_commit: randomUUID() }))).toThrow("GEN3_CLASSIFY_CANDIDATE_NOT_DEPLOYED");
    const withoutNewest = Object.keys(head.migration_inventory.files).slice(0, -1);
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: stateHash }, () => deployedEvidence(head, { migration_versions: withoutNewest }))).toThrow("GEN3_CLASSIFY_CANDIDATE_NOT_DEPLOYED");
    const newestMigration = Object.keys(head.migration_inventory.files).at(-1)!;
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: stateHash }, () => deployedEvidence(head, { migration_source_hashes: { ...head.migration_inventory.files, [newestMigration]: "f".repeat(64) } }))).toThrow("GEN3_CLASSIFY_CANDIDATE_NOT_DEPLOYED");
  });

  it("rolls back the projection and event append when persistence aborts", () => {
    const { db, gate, head } = pausedGenerationThree();
    const evidence = () => deployedEvidence(head);
    const before = db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get();
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get();
    db.exec(`CREATE TRIGGER fail_gen3_classify_defect BEFORE INSERT ON release_sales_gate_events
      WHEN json_extract(NEW.details_json, '$.kind') = 'RUNTIME_READINESS_DEFECT'
      BEGIN SELECT RAISE(ABORT, 'forced gen3 classify failure'); END`);
    expect(() => gate.classifyGenerationThreeReadinessDefect({ expected_state_hash: releaseStateHash(head) }, evidence)).toThrow("forced gen3 classify failure");
    expect(db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(eventCount);
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head, state_hash: releaseStateHash(head) });
  });
});
