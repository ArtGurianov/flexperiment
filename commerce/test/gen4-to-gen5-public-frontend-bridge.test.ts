import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { gen4PublicFrontendRecoveryBridge, ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, replayReleaseGenerationChain, type GenerationHead, type V2Event } from "../src/release-generation";

const bridge = gen4PublicFrontendRecoveryBridge;
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const migrationInventory = () => {
  const directory = resolve(process.cwd(), "commerce/migrations");
  return { files: Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => [name, createHash("sha256").update(readFileSync(resolve(directory, name))).digest("hex")])) };
};

const firstHead = (): GenerationHead => ({
  release_id: bridge.release_id,
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

/**
 * Reaches an authoritative CERTIFIED gen4/R2 head through the real
 * acquire/deploy/recovery/adopt sequence up to DEPLOYED_READ_ONLY, then
 * hand-appends the certification lifecycle (mirroring exactly what
 * activateCertificationLease/consumeCertificationLease/certifyCandidate
 * produce) so the ledger's certification binding uses the bridge's own
 * hard-bound lease/occurrence/promo/order/payment/refund identifiers -
 * those can't be forced through the generating public API, which mints its
 * own IDs.
 */
function certifiedGenerationFour(options: { promoStatus?: string; fixtureOverride?: Partial<{ visibility: string; sales_status: string; fulfillment_status: string; price_kopecks: number }>; skipRows?: boolean } = {}) {
  const db = openDatabase(":memory:"); databases.push(db); migrate(db);
  const gate = new ReleaseSalesGate(db);
  const acquired = gate.acquireCandidate({ head: firstHead() });
  const deployed1 = gate.changeCandidatePhase({ release_id: acquired.head.release_id, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const recovery1 = gate.changeCandidatePhase({ release_id: deployed1.head.release_id, candidate_generation: 1, expected_state_hash: releaseStateHash(deployed1.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
  const gen2Head = { ...recovery1.head, candidate_generation: 2, source_commit: "b".repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
  const adopted2 = gate.adoptCandidate({ head: gen2Head, expected_generation: 1, from_sha: recovery1.head.source_commit, expected_state_hash: releaseStateHash(recovery1.head) });
  const deployed2 = gate.changeCandidatePhase({ release_id: adopted2.head.release_id, candidate_generation: 2, expected_state_hash: releaseStateHash(adopted2.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const recovery2 = gate.changeCandidatePhase({ release_id: deployed2.head.release_id, candidate_generation: 2, expected_state_hash: releaseStateHash(deployed2.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
  const gen3Head = { ...recovery2.head, candidate_generation: 3, source_commit: "c".repeat(40), phase: "PAUSED" as const, phase_sequence: 0 };
  const adopted3 = gate.adoptCandidate({ head: gen3Head, expected_generation: 2, from_sha: recovery2.head.source_commit, expected_state_hash: releaseStateHash(recovery2.head) });
  const deployed3 = gate.changeCandidatePhase({ release_id: adopted3.head.release_id, candidate_generation: 3, expected_state_hash: releaseStateHash(adopted3.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });
  const recovery3 = gate.changeCandidatePhase({ release_id: deployed3.head.release_id, candidate_generation: 3, expected_state_hash: releaseStateHash(deployed3.head), from_phase: "DEPLOYED_READ_ONLY", phase_sequence: 1, to_phase: "RECOVERY_REQUIRED" });
  const gen4Head = { ...recovery3.head, candidate_generation: 4, source_commit: bridge.from_source_commit, phase: "PAUSED" as const, phase_sequence: 0 };
  const adopted4 = gate.adoptCandidate({ head: gen4Head, expected_generation: 3, from_sha: recovery3.head.source_commit, expected_state_hash: releaseStateHash(recovery3.head) });
  const deployed4 = gate.changeCandidatePhase({ release_id: adopted4.head.release_id, candidate_generation: 4, expected_state_hash: releaseStateHash(adopted4.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });

  if (options.skipRows) return { db, gate, head: deployed4.head };

  // Business-data rows, using the bridge's own hard-bound identifiers.
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'novosibirsk', 'Новосибирск')").run(cityId);
  const legalReleaseId = randomUUID();
  const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((document) => [document, { document_id: document, version: "test-1", sha256: "0".repeat(64), current_url: "https://example.test", archive_url: "https://example.test", checkout_relevant: true }])) };
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(legalReleaseId, JSON.stringify(legalManifest));
  const fixture = { visibility: "HIDDEN", sales_status: "CLOSED", fulfillment_status: "SCHEDULED", price_kopecks: 101, ...options.fixtureOverride };
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, sales_status, visibility, fulfillment_status, venue_status, venue_disclosure_text, venue_announce_by)
    VALUES (?, ?, 'Certification fixture', '2027-01-15T12:00:00.000Z', '2027-01-15T15:00:00.000Z', 'Asia/Novosibirsk', ?, 1, ?, ?, ?, 'TO_BE_ANNOUNCED', 'Venue TBD', '2027-01-14T12:00:00.000Z')`)
    .run(bridge.certification.occurrence_id, cityId, fixture.price_kopecks, fixture.sales_status, fixture.visibility, fixture.fulfillment_status);
  db.prepare("INSERT INTO promo_codes(id, code, normalized_code, status, discount_type, discount_value) VALUES (?, ?, ?, ?, 'FIXED', 1)")
    .run(bridge.certification.promo_id, "CERT-TEST", "CERT-TEST", options.promoStatus ?? "DISABLED");
  db.prepare(`INSERT INTO orders(id, public_status_id, public_order_number, occurrence_id, customer_name, customer_email, customer_email_hash, amount_kopecks, occurrence_material_revision, venue_disclosure_snapshot, checkout_legal_release_id, legal_snapshot_json, eligibility_confirmed_at, promo_code_snapshot, discount_type_snapshot, discount_value_snapshot)
    VALUES (?, ?, 'TEST-0001', ?, 'Test Customer', 'buyer@example.test', ?, ?, 1, 'Venue TBD', ?, '{}', datetime('now'), ?, 'FIXED', 1)`)
    .run(bridge.certification.order_id, randomUUID(), bridge.certification.occurrence_id, "e".repeat(64), bridge.certification.amount_kopecks, legalReleaseId, "CERT-TEST");
  db.prepare(`INSERT INTO payments(id, order_id, state, status, captured_amount_kopecks, provider_payment_id, provider_idempotency_key, creation_started_at)
    VALUES (?, ?, 'CREATED', 'REFUNDED', ?, ?, ?, datetime('now'))`)
    .run(bridge.certification.payment_id, bridge.certification.order_id, bridge.certification.captured_kopecks, randomUUID(), randomUUID());
  db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
    VALUES (?, ?, ?, ?, ?, 'test refund', 'ADMIN_COMPENSATION', 'SUCCEEDED', ?, ?)`)
    .run(bridge.certification.refund_id, randomUUID(), bridge.certification.order_id, bridge.certification.payment_id, bridge.certification.refunded_kopecks, randomUUID(), randomUUID());
  db.prepare(`INSERT INTO release_certification_allowlist(lease_id, owner_release_id, candidate_generation, expected_source_commit, occurrence_id, promo_id, expected_idempotency_key_hash, lease_expires_at, status, consumed_at, consumed_order_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONSUMED', datetime('now'), ?)`)
    .run(bridge.certification.lease_id, bridge.release_id, 4, bridge.from_source_commit, bridge.certification.occurrence_id, bridge.certification.promo_id, bridge.certification.expected_idempotency_key_hash, bridge.certification.lease_expires_at, bridge.certification.order_id);

  // Hand-append the certification lifecycle events; activateCertificationLease
  // mints its own random lease_id, so this is the only way to land the
  // ledger's certification binding on the bridge's exact hard-bound lease.
  const active = { lease_id: bridge.certification.lease_id, occurrence_id: bridge.certification.occurrence_id, promo_id: bridge.certification.promo_id, expected_idempotency_key_hash: bridge.certification.expected_idempotency_key_hash, lease_expires_at: bridge.certification.lease_expires_at, status: "ACTIVE" as const };
  const certificationOnly = { ...deployed4.head, phase: "CERTIFICATION_ONLY" as const, phase_sequence: deployed4.head.phase_sequence + 1, certification: active };
  const inFlight = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: certificationOnly.phase_sequence + 1, certification: { ...active, status: "CONSUMED" as const } };
  const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: inFlight.phase_sequence + 1 };
  const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(bridge.release_id) as V2Event[];
  const append = (kind: string, details: Record<string, unknown>) => {
    const next = { schema_version: 2, kind, ...details };
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, 'PAUSED', ?)").run(randomUUID(), bridge.release_id, JSON.stringify(next));
  };
  append("PHASE_CHANGED", { from_phase: deployed4.head.phase, from_phase_sequence: deployed4.head.phase_sequence, head: certificationOnly });
  append("PHASE_CHANGED", { from_phase: certificationOnly.phase, from_phase_sequence: certificationOnly.phase_sequence, head: inFlight });
  append("PHASE_CHANGED", {
    from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: certified,
    certification_evidence: { occurrence_id: bridge.certification.occurrence_id, promo_id: bridge.certification.promo_id, order_id: bridge.certification.order_id, payment_id: bridge.certification.payment_id, refund_id: bridge.certification.refund_id, price_kopecks: bridge.certification.price_kopecks, discount_kopecks: bridge.certification.discount_kopecks, amount_kopecks: bridge.certification.amount_kopecks, captured_kopecks: bridge.certification.captured_kopecks, refunded_kopecks: bridge.certification.refunded_kopecks },
  });
  const expectedMigration = Object.keys(certified.migration_inventory.files).sort().at(-1)!;
  db.prepare("UPDATE release_sales_gate SET expected_source_commit = ?, expected_migration = ?, expected_legal_version = ?, expected_legal_manifest_sha256 = ?, sales_paused = 1, owner_release_id = ?, owner_mode = 'CONTROLLED_CUTOVER' WHERE singleton = 1")
    .run(certified.source_commit, expectedMigration, (certified.legal_baseline as { legal_version: string }).legal_version, (certified.legal_baseline as { legal_manifest_sha256: string }).legal_manifest_sha256, certified.release_id);

  const replay = replayReleaseGenerationChain([...events, ...(db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? AND rowid > ? ORDER BY rowid ASC").all(bridge.release_id, events.at(-1)?.seq ?? 0) as V2Event[])]);
  if (replay.corrupt || !replay.head) throw new Error(`fixture setup produced a corrupt chain: ${replay.corrupt}`);
  return { db, gate, head: replay.head as GenerationHead };
}

describe("gen4 to gen5 public-frontend recovery bridge", () => {
  it("atomically appends the bounded defect and the gen5 adoption for the certified fixture", () => {
    const { db, gate, head } = certifiedGenerationFour();
    const before = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get() as { count: number };
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: "0".repeat(64) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(before);
    const result = gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) });
    expect(result.head).toMatchObject({ release_id: bridge.release_id, candidate_generation: bridge.to_generation, source_commit: bridge.to_source_commit, phase: "PAUSED", phase_sequence: 0 });
    expect(result.head).not.toHaveProperty("certification");
    const events = db.prepare("SELECT rowid AS seq, release_id, action, details_json FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid").all(bridge.release_id) as V2Event[];
    expect(events.slice(-2).map((event) => JSON.parse(event.details_json).kind)).toEqual(["PUBLIC_FRONTEND_DEFECT", "CANDIDATE_SUPERSEDED"]);
    expect(replayReleaseGenerationChain(events)).toEqual({ head: result.head });
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head: result.head, state_hash: result.state_hash });
  });

  it("fails closed as ALREADY_APPLIED on a second run once gen5 exists", () => {
    const { gate, head } = certifiedGenerationFour();
    const result = gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) });
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: result.state_hash })).toThrow("GEN4_BRIDGE_ALREADY_APPLIED");
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: "0".repeat(64) })).toThrow("GEN4_BRIDGE_ALREADY_APPLIED");
  });

  it("rejects a stale expected_state_hash without mutating anything", () => {
    const { db, gate, head } = certifiedGenerationFour();
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get();
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash({ ...head, phase_sequence: head.phase_sequence + 1 }) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(eventCount);
  });

  it("requires an exact owner and paused sales", () => {
    const { db, gate, head } = certifiedGenerationFour();
    db.prepare("UPDATE release_sales_gate SET sales_paused = 0 WHERE singleton = 1").run();
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
    db.prepare("UPDATE release_sales_gate SET sales_paused = 1, owner_release_id = ? WHERE singleton = 1").run(randomUUID());
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
  });

  it("rejects a candidate at the wrong generation, source, phase, or phase_sequence", () => {
    const { head: wrongPhase } = certifiedGenerationFour({ skipRows: true });
    expect(() => new ReleaseSalesGate(databases.at(-1)!).bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(wrongPhase) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
    const { gate, head } = certifiedGenerationFour();
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash({ ...head, candidate_generation: 3 }) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash({ ...head, source_commit: "z".repeat(40) }) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash({ ...head, phase_sequence: head.phase_sequence + 1 }) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
  });

  it("rejects certification identifiers that don't match the bridge's bound scope", () => {
    const { gate, head } = certifiedGenerationFour();
    const mutated = { ...head, certification: { ...head.certification!, lease_id: randomUUID() } };
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(mutated) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
  });

  it("rejects when the temporary promo has not been disabled", () => {
    const { gate, head } = certifiedGenerationFour({ promoStatus: "ACTIVE" });
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("GEN4_BRIDGE_EVIDENCE_MISMATCH");
  });

  it("rejects when another refund exists for the same payment, even if net capture is still zero", () => {
    const { db, gate, head } = certifiedGenerationFour();
    db.prepare(`INSERT INTO refunds(id, public_id, order_id, payment_id, amount_kopecks, reason, source, status, idempotency_key_hash, canonical_request_hash)
      VALUES (?, ?, ?, ?, 1, 'stray attempt', 'ADMIN_COMPENSATION', 'FAILED', ?, ?)`)
      .run(randomUUID(), randomUUID(), bridge.certification.order_id, bridge.certification.payment_id, randomUUID(), randomUUID());
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("GEN4_BRIDGE_EVIDENCE_MISMATCH");
  });

  it("rejects when the fixture occurrence is not HIDDEN/CLOSED/SCHEDULED/101", () => {
    for (const fixtureOverride of [{ visibility: "PUBLISHED", sales_status: "CLOSED" }, { visibility: "PUBLISHED", sales_status: "OPEN" }, { price_kopecks: 100 }]) {
      const { gate, head } = certifiedGenerationFour({ fixtureOverride });
      expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("GEN4_BRIDGE_EVIDENCE_MISMATCH");
    }
  });

  it("rejects when the on-disk migration set no longer matches the candidate's inventory", () => {
    const { gate, head } = certifiedGenerationFour();
    const tampered = { ...head, migration_inventory: { files: { ...head.migration_inventory.files, "0036_tochka_provider_error_evidence.sql": "f".repeat(64) } } };
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(tampered) })).toThrow("GEN4_BRIDGE_PRECONDITION_FAILED");
  });

  it("rolls back entirely when the second event append fails", () => {
    const { db, gate, head } = certifiedGenerationFour();
    const before = db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get();
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get();
    db.exec(`CREATE TRIGGER fail_gen4_bridge_supersede BEFORE INSERT ON release_sales_gate_events
      WHEN json_extract(NEW.details_json, '$.kind') = 'CANDIDATE_SUPERSEDED'
      BEGIN SELECT RAISE(ABORT, 'forced gen4 bridge supersede failure'); END`);
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("forced gen4 bridge supersede failure");
    expect(db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(eventCount);
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head, state_hash: releaseStateHash(head) });
  });

  it("rolls back entirely when the projection update fails after both events would otherwise commit", () => {
    const { db, gate, head } = certifiedGenerationFour();
    const before = db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get();
    const eventCount = db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get();
    db.exec("CREATE TRIGGER fail_gen4_bridge_projection BEFORE UPDATE ON release_sales_gate BEGIN SELECT RAISE(ABORT, 'forced gen4 bridge projection failure'); END");
    expect(() => gate.bridgeGenerationFourToFive({ expected_state_hash: releaseStateHash(head) })).toThrow("forced gen4 bridge projection failure");
    expect(db.prepare("SELECT expected_source_commit FROM release_sales_gate WHERE singleton = 1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM release_sales_gate_events").get()).toEqual(eventCount);
    expect(gate.candidateHead()).toEqual({ schema_version: 2, head, state_hash: releaseStateHash(head) });
  });

  it("cannot be redirected to another release/generation/source/defect through its public input", () => {
    expect(Object.keys(bridge)).toEqual(["release_id", "from_generation", "from_source_commit", "from_phase", "from_phase_sequence", "to_generation", "to_source_commit", "defect", "certification", "fixture", "target_replay_sha256"]);
    // This bridge has already been executed in production and retired
    // (second-run fails closed with GEN4_BRIDGE_ALREADY_APPLIED); its pin is
    // a frozen historical fact, not a live comparison against HEAD's
    // ever-evolving release-generation.ts (see gen2-bootstrap-adopt.test.ts
    // for the same fix, applied for the same reason).
    expect(bridge.target_replay_sha256).toBe("088bc22ca1aafe40b3c075998a94588275093b10e1646b7cefddc3be01bff6c6");
  });
});
