import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { gen1PostActivationEmailToGen2Bridge, ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";

const bridge = gen1PostActivationEmailToGen2Bridge;
const databases: ReturnType<typeof openDatabase>[] = [];
const directories: string[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

const migrationInventory = () => {
  const db = openDatabase(":memory:"); migrate(db);
  const files = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>)
    .map(({ version }, index) => [version, String(index % 10).repeat(64)]);
  db.close();
  return { files: Object.fromEntries(files) };
};
const inventory = migrationInventory();
const legal = { legal_version: "test", legal_manifest_sha256: "a".repeat(64), legal_hashes: {} };
const certification = { lease_id: "lease", occurrence_id: "occurrence", promo_id: "promo", expected_idempotency_key_hash: "b".repeat(64), lease_expires_at: "2030-01-01T00:00:00.000Z", status: "CONSUMED" as const };
const activeCertification = (lease_id: string) => ({ ...certification, lease_id, status: "ACTIVE" as const });

const fixture = (databasePath = ":memory:") => {
  const db = openDatabase(databasePath); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const paused: GenerationHead = { release_id: bridge.release_id, candidate_generation: 1, source_commit: bridge.from_source_commit,
    migration_inventory: inventory, legal_baseline: legal, release_family: "sales-availability-v1", checkout_contract_version: "sales-availability-v1", admin_contract_version: "sales-availability-v1", phase: "PAUSED", phase_sequence: 0 };
  gate.acquireCandidate({ head: paused });
  let current = paused;
  const certificationLeases = [activeCertification("lease-expired-1"), activeCertification("lease-expired-2"), activeCertification("lease")];
  let certificationLeaseIndex = 0;
  for (const phase of ["DEPLOYED_READ_ONLY", "CERTIFICATION_ONLY", "DEPLOYED_READ_ONLY", "CERTIFICATION_ONLY", "DEPLOYED_READ_ONLY", "CERTIFICATION_ONLY", "CERTIFICATION_IN_FLIGHT", "CERTIFIED"] as const) {
    const nextCertification = phase === "CERTIFICATION_ONLY" ? certificationLeases[certificationLeaseIndex++]
      : phase === "DEPLOYED_READ_ONLY" && current.certification ? { ...current.certification, status: "REVOKED" as const }
        : phase === "CERTIFICATION_IN_FLIGHT" || phase === "CERTIFIED" ? certification : undefined;
    const next = { ...current, phase, phase_sequence: current.phase_sequence + 1,
      ...(nextCertification ? { certification: nextCertification } : {}) } as GenerationHead;
    const details: Record<string, unknown> = { schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase, from_phase_sequence: current.phase_sequence, head: next };
    if (phase === "CERTIFIED") details.certification_evidence = { occurrence_id: certification.occurrence_id, promo_id: certification.promo_id, order_id: "order", payment_id: "payment", refund_id: "refund", price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 };
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'PAUSED', ?)").run(randomUUID(), bridge.release_id, JSON.stringify(details));
    current = next;
  }
  db.prepare("UPDATE outbox_authority SET attempt_authority = 'ATTEMPT', email_dispatch_paused = 1, dispatch_owner_release_id = ?, dispatch_owner_generation = NULL, revision = 7 WHERE singleton = 1").run(bridge.release_id);
  db.prepare("INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision, created_at) VALUES (?, 'DISPATCH_UNFENCED', ?, NULL, 'historical unfence', 6, '2026-08-30 10:00:00')").run(randomUUID(), bridge.release_id);
  db.prepare("INSERT INTO outbox_authority_events(id, action, owner_release_id, owner_generation, reason, revision, created_at) VALUES (?, 'DISPATCH_FENCED', ?, NULL, 'contained', 7, '2026-08-30 10:00:02')").run(randomUUID(), bridge.release_id);
  db.prepare(`INSERT INTO email_outbox(id, type, recipient_email, recipient_email_hash, template, payload_snapshot, payload_ref, status, delivery_outcome, provider_idempotence_key)
    VALUES ('ticket', 'TICKET', 'buyer@example.test', 'h', 'ticket', ?, 'order', 'FAILED', 'KNOWN_FAILED', 'key')`).run(JSON.stringify({ order_id: "order" }));
  db.prepare(`INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key, started_at, outcome, failure_code, failure_detail)
    VALUES ('attempt', 'ticket', 1, 'key', '2026-08-30T10:00:01.000Z', 'KNOWN_FAILED', 'UNISENDER_HTTP_REJECTED', ?)`)
    .run(JSON.stringify({ provider_error_code: "1588" }));
  return { db, gate, current };
};

describe("0041 offline gen1 to gen2 post-activation bridge", () => {
  it("hard-binds the observed live certified sequence 8", () => {
    const { gate, current } = fixture();
    expect(current).toMatchObject({ phase: "CERTIFIED", phase_sequence: 8, certification: { status: "CONSUMED" } });
    expect(bridge.from_phase_sequence).toBe(8);
    expect(gate.releaseHead(bridge.release_id).head).toEqual(current);
  });

  it("executes only a maintenance replay closure byte-identical to exact Gen2", () => {
    for (const [file, expectedHash] of Object.entries(bridge.target_replay_closure_sha256)) {
      const target = execFileSync("git", ["show", `${bridge.to_source_commit}:${file}`]);
      expect(createHash("sha256").update(target).digest("hex")).toBe(expectedHash);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(expectedHash);
    }
  });

  it("re-proves the committed bridge from SQLite and rejects a stale receipt hash or authority drift", () => {
    const directory = mkdtempSync(join(tmpdir(), "gen1-gen2-bridge-proof-")); directories.push(directory);
    const { db, gate, current } = fixture(join(directory, "commerce.sqlite"));
    const result = gate.bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: releaseStateHash(current) });
    const runProof = (stateHash = result.state_hash) => execFileSync("node", ["--import", "tsx", "commerce/src/assert-gen1-to-gen2-offline-bridge.ts"], {
      env: { ...process.env, COMMERCE_DATABASE_PATH: join(directory, "commerce.sqlite"), COMMERCE_GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH: stateHash },
      encoding: "utf8",
    });
    expect(runProof()).toContain('"bridge_verified":true');
    expect(() => runProof("0".repeat(64))).toThrow("GEN1_TO_GEN2_BRIDGE_RECEIPT_STATE_HASH_MISMATCH");
    db.exec("UPDATE outbox_authority SET revision = 8 WHERE singleton = 1");
    expect(runProof).toThrow("GEN1_TO_GEN2_BRIDGE_DURABLE_AUTHORITY_INVALID");
  });

  it("atomically appends the exact defect then GEN2 and replays without mutation", () => {
    const { db, gate, current } = fixture();
    const beforeAuthority = db.prepare("SELECT attempt_authority, email_dispatch_paused, dispatch_owner_release_id, dispatch_owner_generation, revision FROM outbox_authority WHERE singleton = 1").get();
    const result = gate.bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: releaseStateHash(current) });
    expect(result).toMatchObject({ head: { candidate_generation: 2, source_commit: bridge.to_source_commit, phase: "PAUSED", phase_sequence: 0 }, replayed: false });
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(bridge.release_id) as V2Event[];
    const [defect, supersede] = events.slice(-2).map((event) => JSON.parse(event.details_json));
    expect(defect).toMatchObject({ kind: "POST_ACTIVATION_EMAIL_PROVIDER_DEFECT", from_phase: "CERTIFIED", from_phase_sequence: 8,
      head: { phase: "RECOVERY_REQUIRED", phase_sequence: 9, certification: { status: "CONSUMED" } } });
    expect(supersede).toMatchObject({ kind: "CANDIDATE_SUPERSEDED", from_generation: 1, from_sha: bridge.from_source_commit,
      head: { candidate_generation: 2, source_commit: bridge.to_source_commit, phase: "PAUSED", phase_sequence: 0 } });
    expect(replayReleaseGenerationChain(events)).toMatchObject({ head: result.head });
    expect(db.prepare("SELECT attempt_authority, email_dispatch_paused, dispatch_owner_release_id, dispatch_owner_generation, revision FROM outbox_authority WHERE singleton = 1").get()).toEqual(beforeAuthority);
    const again = gate.bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: result.state_hash });
    expect(again).toMatchObject({ replayed: true, head: result.head });
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events WHERE release_id = ?").get(bridge.release_id)).toEqual({ n: events.length });
  });

  it("refuses adjacent certified sequence bindings", () => {
    const mutableBridge = bridge as unknown as { from_phase_sequence: number };
    const expectedSequence = mutableBridge.from_phase_sequence;
    try {
      for (const wrongSequence of [7, 9]) {
        mutableBridge.from_phase_sequence = wrongSequence;
        const { gate, current } = fixture();
        expect(() => gate.bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: releaseStateHash(current) })).toThrow("GEN1_TO_GEN2_BRIDGE_PRECONDITION_FAILED");
      }
    } finally {
      mutableBridge.from_phase_sequence = expectedSequence;
    }
  });

  it("rolls both events back when the supersede append fails", () => {
    const { db, gate, current } = fixture();
    const count = db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events WHERE release_id = ?").get(bridge.release_id);
    db.exec(`CREATE TRIGGER fail_bridge_supersede BEFORE INSERT ON release_sales_gate_events
      WHEN json_extract(NEW.details_json, '$.kind') = 'CANDIDATE_SUPERSEDED'
      BEGIN SELECT RAISE(ABORT, 'injected supersede failure'); END`);
    expect(() => gate.bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: releaseStateHash(current) })).toThrow("injected supersede failure");
    expect(gate.releaseHead(bridge.release_id).head).toEqual(current);
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events WHERE release_id = ?").get(bridge.release_id)).toEqual(count);
  });

  it("refuses moved authority, open dispatch, and successor attempts", () => {
    const mutations = [
      "UPDATE outbox_authority SET revision = 6 WHERE singleton = 1",
      "UPDATE outbox_authority SET email_dispatch_paused = 0, dispatch_owner_release_id = NULL, dispatch_owner_generation = NULL WHERE singleton = 1",
      "INSERT INTO outbox_attempt(id, message_id, attempt_no, provider_idempotence_key) VALUES ('successor', 'ticket', 2, 'key-2')",
    ];
    for (const mutation of mutations) {
      const { gate, db, current } = fixture(); db.exec(mutation);
      expect(() => gate.bridgeGen1PostActivationEmailDefectToGen2({ expected_state_hash: releaseStateHash(current) })).toThrow(/GEN1_TO_GEN2_BRIDGE_(PRECONDITION|EVIDENCE)_/);
    }
  });
});
