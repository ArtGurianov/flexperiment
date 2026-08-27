import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { gen2BootstrapAdoption, ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const migrationInventory = () => {
  const directory = resolve(process.cwd(), "commerce/migrations");
  return { files: Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")])) };
};

const firstHead = (): GenerationHead => ({
  release_id: gen2BootstrapAdoption.release_id,
  candidate_generation: 1,
  source_commit: "b01f217ffd2a798fd32aa3d88e125a2e460bd39f",
  migration_inventory: migrationInventory(),
  legal_baseline: { legal_version: "test-1", legal_manifest_sha256: "a".repeat(64), legal_hashes: {} },
  release_family: "promo-codes-v0",
  checkout_contract_version: "promo-codes-v0",
  admin_contract_version: "promo-codes-v0",
  phase: "PAUSED",
  phase_sequence: 0,
});

function pausedGenerationTwo() {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: firstHead() });
  const deployed = gate.changeCandidatePhase({ release_id: acquired.head.release_id, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const recovery = gate.changeCandidatePhase({ release_id: deployed.head.release_id, candidate_generation: 1, expected_state_hash: releaseStateHash(deployed.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
  const generationTwo = { ...recovery.head, candidate_generation: gen2BootstrapAdoption.from_generation, source_commit: gen2BootstrapAdoption.from_source_commit, phase: "PAUSED" as const, phase_sequence: 0 };
  const adopted = gate.adoptCandidate({ head: generationTwo, expected_generation: 1, from_sha: recovery.head.source_commit, expected_state_hash: releaseStateHash(recovery.head) });
  return { db, gate, head: adopted.head };
}

describe("generation-two bootstrap adoption", () => {
  it("atomically appends the fixed readiness defect and fixed generation-three adoption", () => {
    const { db, gate, head } = pausedGenerationTwo();
    const before = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number };
    expect(() => gate.bootstrapGenerationTwoAdoption({ expected_state_hash: "0".repeat(64) })).toThrow("GEN2_BOOTSTRAP_ADOPT_PRECONDITION_FAILED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(before);
    const result = gate.bootstrapGenerationTwoAdoption({ expected_state_hash: releaseStateHash(head) });
    expect(result.head).toMatchObject({
      release_id: gen2BootstrapAdoption.release_id,
      candidate_generation: gen2BootstrapAdoption.to_generation,
      source_commit: gen2BootstrapAdoption.to_source_commit,
      phase: "PAUSED",
      phase_sequence: 0,
    });
    expect(result.head).not.toHaveProperty("certification");
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(gen2BootstrapAdoption.release_id) as V2Event[];
    expect(events.slice(-2).map((event) => JSON.parse(event.details_json).kind)).toEqual(["RUNTIME_READINESS_DEFECT", "CANDIDATE_SUPERSEDED"]);
    expect(replayReleaseGenerationChain(events)).toEqual({ head: result.head });
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: result.head, state_hash: result.state_hash });
    expect(() => gate.bootstrapGenerationTwoAdoption({ expected_state_hash: result.state_hash })).toThrow("GEN2_BOOTSTRAP_ADOPT_ALREADY_APPLIED");
  });

  it("rolls back the projection and first event when the second append aborts", () => {
    const { db, gate, head } = pausedGenerationTwo();
    const before = db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get();
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get();
    db.exec(`CREATE TRIGGER fail_gen2_bootstrap_supersede BEFORE INSERT ON release_sales_gate_events
      WHEN json_extract(NEW.details_json, '$.kind') = 'CANDIDATE_SUPERSEDED'
      BEGIN SELECT RAISE(ABORT, 'forced bootstrap supersede failure'); END`);
    expect(() => gate.bootstrapGenerationTwoAdoption({ expected_state_hash: releaseStateHash(head) })).toThrow("forced bootstrap supersede failure");
    expect(db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(eventCount);
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head, state_hash: releaseStateHash(head) });
  });

  it("cannot be redirected to another source or generation through its public input", () => {
    const { gate, head } = pausedGenerationTwo();
    expect(Object.keys(gen2BootstrapAdoption)).toEqual(["release_id", "from_generation", "from_source_commit", "to_generation", "to_source_commit", "target_replay_sha256"]);
    expect(createHash("sha256").update(readFileSync(resolve(process.cwd(), "commerce/src/release-generation.ts"))).digest("hex")).toBe(gen2BootstrapAdoption.target_replay_sha256);
    expect(() => gate.bootstrapGenerationTwoAdoption({ expected_state_hash: releaseStateHash({ ...head, source_commit: randomUUID() }) })).toThrow("GEN2_BOOTSTRAP_ADOPT_PRECONDITION_FAILED");
  });
});
