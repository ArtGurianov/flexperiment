import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { ReleaseSalesGate, type OutboxAuthoritySnapshot, type ReleaseRuntimeEvidence } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";

/**
 * The recovery edge for a defect found AFTER certification and BEFORE the
 * irreversible authority transfer.
 *
 * That window had no controller path in either direction, which is a stranded
 * state rather than a missing convenience:
 *
 *   abort                     refuses any generation that was ever CERTIFIED
 *   runtime-readiness defect  only classifies a PAUSED generation
 *   replacement adoption      requires RECOVERY_REQUIRED
 *
 * So the answer is deliberately narrow rather than a weaker abort: it opens
 * only while attempt authority is still LEGACY and the dispatch fence still
 * belongs to this release, so it cannot walk back anything that actually moved.
 */

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const SOURCE = "a".repeat(40);

/**
 * The real applied set, not two invented filenames.
 *
 * adoptCandidate checks the applied-migration ledger against the inventory as a
 * prefix, so a fixture inventory that does not describe this database refuses
 * the adopt for a reason that has nothing to do with what is being tested.
 */
const MIGRATIONS = (() => {
  const db = openDatabase(":memory:"); migrate(db);
  const versions = (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>)
    .map((row) => row.version);
  db.close();
  return Object.fromEntries(versions.map((version, index) => [version, String(index % 10).repeat(64)]));
})();
const legalBaseline = {
  legal_version: "2026-08-26.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
};

const head = (releaseId: string, overrides: Partial<GenerationHead> = {}): GenerationHead => ({
  release_id: releaseId, candidate_generation: 1, source_commit: SOURCE,
  migration_inventory: { files: MIGRATIONS }, legal_baseline: legalBaseline,
  release_family: "test-family", checkout_contract_version: "test-v1", admin_contract_version: "test-v1",
  phase: "PAUSED", phase_sequence: 0, ...overrides,
});

const evidence = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: SOURCE, migration_versions: Object.keys(MIGRATIONS), required_migrations: {},
  worker_source_commit: SOURCE, worker_started_at: null, worker_observed_at: null,
  worker_last_successful_sweep_at: null, legal_version: legalBaseline.legal_version,
  legal_manifest_sha256: legalBaseline.legal_manifest_sha256, legal_hashes: legalBaseline.legal_hashes,
  legal_publish_time: "2026-08-26T12:09:17Z", current_legal_copies_match: true,
  migration_source_hashes: MIGRATIONS, ...overrides,
} as ReleaseRuntimeEvidence);

const authority = (overrides: Partial<OutboxAuthoritySnapshot> = {}, releaseId = ""): OutboxAuthoritySnapshot => ({
  attempt_authority: "LEGACY", email_dispatch_paused: true, dispatch_owner_release_id: releaseId, ...overrides,
});

const CERTIFICATION = {
  lease_id: "lease-1", occurrence_id: "11111111-1111-4111-8111-111111111111",
  promo_id: "22222222-2222-4222-8222-222222222222",
  expected_idempotency_key_hash: "3".repeat(64), lease_expires_at: "2026-08-30T12:00:00.000Z",
  status: "CONSUMED" as const,
};

/**
 * Drives a real acquire, then writes the certification phases through the
 * ledger the same way the controller does. Going through replay rather than
 * inserting a head directly is the point: a transition the replay would reject
 * is not a transition the system has.
 */
const certified = () => {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const releaseId = `pre-activation-test:${randomUUID()}`;
  gate.acquireCandidate({ head: head(releaseId) });

  let current = head(releaseId);
  const step = (next: Partial<GenerationHead>) => {
    const to = { ...current, ...next, phase_sequence: current.phase_sequence + 1 } as GenerationHead;
    const details: Record<string, unknown> = {
      schema_version: 2, kind: "PHASE_CHANGED", from_phase: current.phase,
      from_phase_sequence: current.phase_sequence, head: to,
    };
    if (to.phase === "CERTIFIED") {
      details.certification_evidence = {
        occurrence_id: CERTIFICATION.occurrence_id, promo_id: CERTIFICATION.promo_id,
        order_id: "order-1", payment_id: "payment-1", refund_id: "refund-1",
        price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100,
        captured_kopecks: 100, refunded_kopecks: 100,
      };
    }
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'PAUSED', ?)")
      .run(randomUUID(), releaseId, JSON.stringify(details));
    current = to;
  };
  step({ phase: "DEPLOYED_READ_ONLY" });
  step({ phase: "CERTIFICATION_ONLY", certification: { ...CERTIFICATION, status: "ACTIVE" } });
  step({ phase: "CERTIFICATION_IN_FLIGHT", certification: CERTIFICATION });
  step({ phase: "CERTIFIED", certification: CERTIFICATION });

  const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(releaseId) as V2Event[];
  expect(replayReleaseGenerationChain(events).corrupt, "the fixture itself must replay cleanly").toBeUndefined();
  return { db, gate, releaseId, current };
};

const request = (releaseId: string, current: GenerationHead, overrides: Record<string, unknown> = {}) => ({
  release_id: releaseId, candidate_generation: current.candidate_generation,
  expected_state_hash: releaseStateHash(current),
  defect_class: "ACTIVATION_REFUSAL" as const, defect_code: "OUTBOX_ACTIVATION_PROVIDER_KEY_MISMATCH",
  ...overrides,
});

describe("pre-activation defect recovery", () => {
  it("moves a certified generation to RECOVERY_REQUIRED", () => {
    const { gate, releaseId, current } = certified();
    const result = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId));
    expect(result.head.phase).toBe("RECOVERY_REQUIRED");
    // The certification binding survives byte for byte: what failed is the step
    // AFTER certification, and the money it moved is not un-moved.
    expect(result.head.certification).toEqual(CERTIFICATION);
  });

  it("produces an event the replay accepts", () => {
    // The seam. A transition the ledger replay rejects is not a transition the
    // system has, however well the method reads - and this is precisely how the
    // certified generation could otherwise be left unrecoverable.
    const { db, gate, releaseId, current } = certified();
    gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId));
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(releaseId) as V2Event[];
    const replay = replayReleaseGenerationChain(events);
    expect(replay.corrupt).toBeUndefined();
    expect(replay.head?.phase).toBe("RECOVERY_REQUIRED");
  });

  it("leaves the release gate owned and sales paused", () => {
    // Recovery is not an exit. The epoch keeps the gate so a forward-only
    // replacement can be adopted into it.
    const { db, gate, releaseId, current } = certified();
    gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId));
    expect(db.prepare("SELECT sales_paused, owner_release_id FROM release_sales_gate WHERE singleton = 1").get())
      .toEqual({ sales_paused: 1, owner_release_id: releaseId });
  });

  it("refuses once attempt authority has moved", () => {
    // The load-bearing gate. After the transfer there is no going back, so
    // recovery can only mean forward.
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current), () => evidence(),
      () => authority({ attempt_authority: "ATTEMPT" }, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_AUTHORITY_ALREADY_ACTIVATED");
  });

  it("refuses when the dispatch fence is open or held by someone else", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current), () => evidence(),
      () => authority({ email_dispatch_paused: false, dispatch_owner_release_id: null }, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_FENCE_NOT_OWNED");
    expect(() => gate.markPreActivationDefect(request(releaseId, current), () => evidence(),
      () => authority({ dispatch_owner_release_id: "someone-else" })))
      .toThrow("PRE_ACTIVATION_DEFECT_FENCE_NOT_OWNED");
  });

  it("refuses a generation that has not certified", () => {
    // Those already have abort and readiness classification; widening this edge
    // would be the casual abort weakening it exists to avoid.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const releaseId = `pre-activation-test:${randomUUID()}`;
    gate.acquireCandidate({ head: head(releaseId) });
    expect(() => gate.markPreActivationDefect(request(releaseId, head(releaseId)), () => evidence(), () => authority({}, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_PHASE_INVALID");
  });

  it("refuses when the candidate under recovery is not the deployed one", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current),
      () => evidence({ worker_source_commit: "9".repeat(40) }), () => authority({}, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_CANDIDATE_NOT_DEPLOYED");
  });

  it("refuses an unbounded defect class or code", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current, { defect_class: "ACTIVATION_STORE" }), () => evidence(), () => authority({}, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_INVALID");
    expect(() => gate.markPreActivationDefect(request(releaseId, current, { defect_code: "not a code" }), () => evidence(), () => authority({}, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_INVALID");
  });

  it("refuses a stale generation or state hash", () => {
    const { gate, releaseId, current } = certified();
    expect(() => gate.markPreActivationDefect(request(releaseId, current, { expected_state_hash: "0".repeat(64) }), () => evidence(), () => authority({}, releaseId)))
      .toThrow("RELEASE_STATE_STALE");
  });

  it("reconciles a replay of that exact generation and evidence", () => {
    const { gate, releaseId, current } = certified();
    const first = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId));
    const replayed = gate.markPreActivationDefect(
      request(releaseId, first.head as GenerationHead), () => evidence(), () => authority({}, releaseId));
    expect(replayed.head.phase).toBe("RECOVERY_REQUIRED");
    expect(replayed.head.phase_sequence).toBe(first.head.phase_sequence);
  });

  it("refuses to reconcile a replay whose evidence differs", () => {
    // A replay reports what the ledger recorded, not what this request says.
    const { gate, releaseId, current } = certified();
    const first = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId));
    expect(() => gate.markPreActivationDefect(
      request(releaseId, first.head as GenerationHead, { defect_code: "OUTBOX_ACTIVATION_NOT_DRAINED" }),
      () => evidence(), () => authority({}, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_EVIDENCE_CONFLICT");
  });

  it("refuses to reconcile a recovery that came from a different edge", () => {
    // The audit blocker. RECOVERY_REQUIRED is reachable through three edges, so
    // reconciling on the phase alone would report a runtime-readiness recovery
    // as a successful replay of an activation defect that was never recorded -
    // which is exactly what the separate ledger kind exists to prevent.
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const releaseId = `pre-activation-test:${randomUUID()}`;
    gate.acquireCandidate({ head: head(releaseId) });
    const recovered = gate.markRuntimeReadinessDefect({
      release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(head(releaseId)),
      readiness_component: "PROVIDER_READINESS", error_class: "PROVIDER_NETWORK", error_code: "ECONNRESET",
    }, () => evidence());
    expect(recovered.head.phase).toBe("RECOVERY_REQUIRED");

    expect(() => gate.markPreActivationDefect(
      request(releaseId, recovered.head as GenerationHead), () => evidence(), () => authority({}, releaseId)))
      .toThrow("PRE_ACTIVATION_DEFECT_NOT_RECORDED");
  });

  it("hands the generation to a forward-only replacement", () => {
    // The whole point: RECOVERY_REQUIRED is what adoptCandidate accepts, so the
    // certified-but-unactivatable generation now has somewhere to go.
    const { gate, releaseId, current } = certified();
    const recovered = gate.markPreActivationDefect(request(releaseId, current), () => evidence(), () => authority({}, releaseId));
    const replacement = "9".repeat(40);
    const adopted = gate.adoptCandidate({
      head: { ...head(releaseId), candidate_generation: 2, source_commit: replacement, phase: "PAUSED", phase_sequence: 0 },
      expected_generation: 1, from_sha: SOURCE, expected_state_hash: releaseStateHash(recovered.head as GenerationHead),
    });
    expect(adopted.head).toMatchObject({ candidate_generation: 2, source_commit: replacement, phase: "PAUSED" });
  });
});
