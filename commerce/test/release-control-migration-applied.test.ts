import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { ReleaseSalesGate, evaluateReopenGate, migrationApplied, type ReleaseControlRequest, type ReleaseRuntimeEvidence } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";

/**
 * evaluateReopenGate() must treat evidence.migration_versions as the
 * complete, authoritative applied-migration inventory, with
 * evidence.required_migrations[version] === true as an additional (never
 * exclusive) way to prove a migration applied - never the reverse. This
 * file exercises exactly the defect that made run 33139603447 fail
 * (33137857861 failed earlier, for an unrelated reason: the readiness
 * parser then ran from main's own stale checkout instead of a pinned R5
 * worktree - see the runtime-pinning invariant): production's own
 * required_migrations map is permanently bounded to the
 * diagnosticCutoverMigrations set (0031-0034) and never carries 0035 or
 * 0036 as keys at all, even when those migrations are genuinely applied and
 * correctly listed in migration_versions.
 */

const legalHashes = { PUBLIC_OFFER: "1".repeat(64), PRIVACY_POLICY: "2".repeat(64), PD_CONSENT: "3".repeat(64), CHECKOUT_DISCLOSURE: "4".repeat(64) };

const baseEvidence = (overrides: Partial<ReleaseRuntimeEvidence> = {}): ReleaseRuntimeEvidence => ({
  source_commit: "a".repeat(40),
  required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true },
  migration_versions: ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"],
  worker_source_commit: "a".repeat(40),
  worker_started_at: new Date(Date.now() - 1_000).toISOString(),
  worker_observed_at: new Date().toISOString(),
  worker_last_successful_sweep_at: new Date().toISOString(),
  legal_version: "v1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: legalHashes,
  legal_publish_time: new Date().toISOString(),
  current_legal_copies_match: true,
  source_legal_manifest_sha256: "0".repeat(64),
  source_legal_publish_time: new Date().toISOString(),
  ...overrides,
});

const request = (migration: string, sourceCommit = "a".repeat(40)): ReleaseControlRequest => ({
  release_id: "deploy-x",
  mode: "CONTROLLED_CUTOVER",
  expected: { source_commit: sourceCommit, migration, legal_version: "v1", legal_manifest_sha256: "b".repeat(64), legal_hashes: legalHashes },
});

/** The exact runtime.required_migrations/migration_versions shape captured
 * live from production during this investigation: required_migrations has
 * only the four diagnostic keys, migration_versions correctly lists every
 * migration through 0036. */
const exactProductionShapeEvidence = (): ReleaseRuntimeEvidence => baseEvidence({
  migration_versions: [
    "0001_initial.sql", "0002_operations.sql", "0003_provider_phase0.sql", "0004_legal_evidence.sql", "0005_provider_webhook_evidence.sql",
    "0006_legal_release_publish_events.sql", "0007_reservation_recovery.sql", "0008_venue_announcement_deadline.sql", "0009_admin_sessions.sql",
    "0010_occurrence_visibility_sales_invariant.sql", "0011_occurrence_cancellation_and_refund_capabilities.sql", "0012_refund_hardening.sql",
    "0013_promoter_attribution_rewards.sql", "0014_prepared_settlement_hardening.sql", "0015_city_interest_requests.sql", "0016_city_interest_lifecycle.sql",
    "0017_city_interest_delivery_lifecycle.sql", "0018_city_interest_suppression.sql", "0019_city_interest_notification_epochs.sql",
    "0020_email_outbox_recovery_hardening.sql", "0021_city_interest_request_epochs.sql", "0022_create_unknown_recovery.sql",
    "0023_email_operational_attention.sql", "0024_tochka_webhook_collision_evidence.sql", "0025_tochka_webhook_conflicts_fail_closed.sql",
    "0026_post_purchase_occurrence_lifecycle.sql", "0027_occurrence_notification_payload_attention.sql", "0028_customer_participant_ticketing.sql",
    "0029_unisender_event_dump_reconciliation.sql", "0030_unisender_event_dump_probe_and_saturation.sql", "0031_participant_age_band.sql",
    "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql", "0035_promo_codes_v0.sql",
    "0036_tochka_provider_error_evidence.sql",
  ],
});

describe("migrationApplied - shared predicate", () => {
  it("counts a version applied via migration_versions even when absent from required_migrations", () => {
    const evidence = baseEvidence();
    expect(evidence.required_migrations["0036_tochka_provider_error_evidence.sql"]).toBeUndefined();
    expect(migrationApplied(evidence, "0036_tochka_provider_error_evidence.sql")).toBe(false);
    evidence.migration_versions.push("0036_tochka_provider_error_evidence.sql");
    expect(migrationApplied(evidence, "0036_tochka_provider_error_evidence.sql")).toBe(true);
  });

  it("counts a version applied via required_migrations === true even when absent from migration_versions", () => {
    const evidence = baseEvidence();
    evidence.required_migrations["0036_tochka_provider_error_evidence.sql"] = true;
    expect(evidence.migration_versions).not.toContain("0036_tochka_provider_error_evidence.sql");
    expect(migrationApplied(evidence, "0036_tochka_provider_error_evidence.sql")).toBe(true);
  });

  it("is false-closed when absent from both", () => {
    const evidence = baseEvidence();
    expect(migrationApplied(evidence, "0036_tochka_provider_error_evidence.sql")).toBe(false);
  });
});

describe("evaluateReopenGate - regression for run 33139603447", () => {
  it("exact live evidence shape (required_migrations 0031-0034 only, migration_versions through 0036) -> PASS for expected 0036", () => {
    const evidence = exactProductionShapeEvidence();
    expect(evidence.required_migrations["0035_promo_codes_v0.sql"]).toBeUndefined();
    expect(evidence.required_migrations["0036_tochka_provider_error_evidence.sql"]).toBeUndefined();
    expect(evaluateReopenGate(request("0036_tochka_provider_error_evidence.sql"), evidence)).toBeUndefined();
  });

  it("same exact live evidence shape -> PASS for expected 0035", () => {
    const evidence = exactProductionShapeEvidence();
    expect(evaluateReopenGate(request("0035_promo_codes_v0.sql"), evidence)).toBeUndefined();
  });

  it("0035 absent from both representations -> REQUIRED_MIGRATION_NOT_APPLIED", () => {
    const evidence = exactProductionShapeEvidence();
    evidence.migration_versions = evidence.migration_versions.filter((v) => v !== "0035_promo_codes_v0.sql");
    expect(evaluateReopenGate(request("0035_promo_codes_v0.sql"), evidence)).toBe("REQUIRED_MIGRATION_NOT_APPLIED");
  });

  it("0036 absent from both representations -> REQUIRED_MIGRATION_NOT_APPLIED", () => {
    const evidence = exactProductionShapeEvidence();
    evidence.migration_versions = evidence.migration_versions.filter((v) => v !== "0036_tochka_provider_error_evidence.sql");
    expect(evaluateReopenGate(request("0036_tochka_provider_error_evidence.sql"), evidence)).toBe("REQUIRED_MIGRATION_NOT_APPLIED");
  });

  it("required_migrations[version] === true also counts an intermediate prerequisite (0035) as applied, even absent from migration_versions", () => {
    // The requiredMigrations.some(...) check (via migrationApplied) covers
    // every version requiredMigrationsFor() returns for the *expected*
    // migration, including earlier prerequisites like 0035 when expected is
    // 0036 - required_migrations[version] === true is sufficient there even
    // without migration_versions agreeing.
    const evidence = exactProductionShapeEvidence();
    evidence.migration_versions = evidence.migration_versions.filter((v) => v !== "0035_promo_codes_v0.sql");
    evidence.required_migrations["0035_promo_codes_v0.sql"] = true;
    expect(evaluateReopenGate(request("0036_tochka_provider_error_evidence.sql"), evidence)).toBeUndefined();
  });

  it("the top-level expected migration itself still requires migration_versions specifically (separate, unchanged, stricter check)", () => {
    // Line 192's EXPECTED_MIGRATION_NOT_APPLIED check only ever consults
    // migration_versions for the exact requested migration, with no
    // required_migrations fallback - this is pre-existing, unchanged
    // behavior, not part of the migrationApplied() fix. required_migrations
    // === true for the expected migration itself is not sufficient on its
    // own if migration_versions disagrees.
    const evidence = exactProductionShapeEvidence();
    evidence.migration_versions = evidence.migration_versions.filter((v) => v !== "0036_tochka_provider_error_evidence.sql");
    evidence.required_migrations["0036_tochka_provider_error_evidence.sql"] = true;
    expect(evaluateReopenGate(request("0036_tochka_provider_error_evidence.sql"), evidence)).toBe("EXPECTED_MIGRATION_NOT_APPLIED");
  });

  it("unknown expected migration remains UNKNOWN_EXPECTED_MIGRATION", () => {
    const evidence = exactProductionShapeEvidence();
    expect(evaluateReopenGate(request("0099_future_release_gate.sql"), evidence)).toBe("UNKNOWN_EXPECTED_MIGRATION");
  });

  it("a diagnostic-set migration missing from both representations remains fail-closed", () => {
    const evidence = exactProductionShapeEvidence();
    evidence.required_migrations["0032_release_sales_gate.sql"] = false;
    evidence.migration_versions = evidence.migration_versions.filter((v) => v !== "0032_release_sales_gate.sql");
    expect(evaluateReopenGate(request("0036_tochka_provider_error_evidence.sql"), evidence)).toBe("REQUIRED_MIGRATION_NOT_APPLIED");
  });
});

describe("ReleaseSalesGate.reopen() - atomicity with the exact production migration shape", () => {
  const databases: ReturnType<typeof openDatabase>[] = [];
  afterEach(() => { while (databases.length) databases.pop()?.close(); });
  const setupDb = () => { const db = openDatabase(":memory:"); databases.push(db); migrate(db); return db; };

  const legalBaseline = { legal_version: "v1", legal_manifest_sha256: "a".repeat(64), legal_hashes: legalHashes };
  const freshHead = (releaseId: string): GenerationHead => ({
    release_id: releaseId, candidate_generation: 1, source_commit: "e".repeat(40),
    migration_inventory: { files: { "0001_initial.sql": "b".repeat(64) } },
    legal_baseline: legalBaseline, release_family: "promo-codes-v0",
    checkout_contract_version: "promo-codes-v0", admin_contract_version: "promo-codes-v0",
    phase: "PAUSED", phase_sequence: 0,
  });
  const appendRaw = (db: ReturnType<typeof openDatabase>, releaseId: string, action: "PAUSED" | "REOPENED", details: Record<string, unknown>) =>
    db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), releaseId, action, JSON.stringify({ schema_version: 2, kind: "PHASE_CHANGED", ...details }));
  /** A completed v2 release, so assertLegacyMutationAllowed() passes -
   * reopen() requires every v2 release to already be COMPLETE. */
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
  const setGate = (db: ReturnType<typeof openDatabase>, input: { owner: string | null; paused: boolean }) =>
    db.prepare("UPDATE release_sales_gate SET owner_release_id = ?, sales_paused = ?, owner_mode = ? WHERE singleton = 1")
      .run(input.owner, input.paused ? 1 : 0, input.owner ? "CONTROLLED_CUTOVER" : null);
  const genericRequest = (releaseId: string, sourceCommit: string): ReleaseControlRequest => ({
    release_id: releaseId, mode: "CONTROLLED_CUTOVER",
    expected: { source_commit: sourceCommit, migration: "0036_tochka_provider_error_evidence.sql", legal_version: legalBaseline.legal_version, legal_manifest_sha256: legalBaseline.legal_manifest_sha256, legal_hashes: legalBaseline.legal_hashes },
  });

  it("succeeds exactly once with the exact production migration shape: history [ACQUIRED, PAUSED] -> owner cleared, paused=false, exactly one REOPENED", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    const deployReleaseId = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const sourceCommit = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";
    const gate = new ReleaseSalesGate(db);
    const req = genericRequest(deployReleaseId, sourceCommit);
    gate.acquire(req);
    gate.pause(req);
    const historyBefore = (db.prepare("SELECT action FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(deployReleaseId) as { action: string }[]).map((r) => r.action);
    expect(historyBefore).toEqual(["ACQUIRED", "PAUSED"]);

    const evidence = exactProductionShapeEvidence();
    evidence.source_commit = sourceCommit;
    evidence.worker_source_commit = sourceCommit;
    evidence.legal_version = legalBaseline.legal_version;
    evidence.legal_manifest_sha256 = legalBaseline.legal_manifest_sha256;
    evidence.legal_hashes = legalBaseline.legal_hashes;

    const result = gate.reopen(req, evidence);
    expect(result.sales_paused).toBe(false);
    expect(result.owner_release_id).toBeNull();
    expect(result.owner_mode).toBeNull();

    const status = db.prepare("SELECT owner_release_id, owner_mode, sales_paused FROM release_sales_gate WHERE singleton = 1").get() as { owner_release_id: string | null; owner_mode: string | null; sales_paused: number };
    expect(status).toEqual({ owner_release_id: null, owner_mode: null, sales_paused: 0 });

    const historyAfter = (db.prepare("SELECT action FROM release_sales_gate_events WHERE release_id = ? ORDER BY rowid ASC").all(deployReleaseId) as { action: string }[]).map((r) => r.action);
    expect(historyAfter).toEqual(["ACQUIRED", "PAUSED", "REOPENED"]);
  });

  it("negative: missing 0036 from both evidence views -> reopen throws, gate and events are completely unchanged", () => {
    const db = setupDb();
    buildCompletedV2(db, "promo-codes-v0:release-1");
    setGate(db, { owner: null, paused: false });
    const deployReleaseId = "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b";
    const sourceCommit = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";
    const gate = new ReleaseSalesGate(db);
    const req = genericRequest(deployReleaseId, sourceCommit);
    gate.acquire(req);
    gate.pause(req);

    const evidence = exactProductionShapeEvidence();
    evidence.source_commit = sourceCommit;
    evidence.worker_source_commit = sourceCommit;
    evidence.legal_version = legalBaseline.legal_version;
    evidence.legal_manifest_sha256 = legalBaseline.legal_manifest_sha256;
    evidence.legal_hashes = legalBaseline.legal_hashes;
    // The genuine defect: 0036 absent from both views.
    evidence.migration_versions = evidence.migration_versions.filter((v) => v !== "0036_tochka_provider_error_evidence.sql");

    const totalEventsBefore = (db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events").get() as { n: number }).n;
    expect(() => gate.reopen(req, evidence)).toThrow("REQUIRED_MIGRATION_NOT_APPLIED");

    const status = db.prepare("SELECT owner_release_id, owner_mode, sales_paused FROM release_sales_gate WHERE singleton = 1").get() as { owner_release_id: string | null; owner_mode: string | null; sales_paused: number };
    expect(status).toEqual({ owner_release_id: deployReleaseId, owner_mode: "CONTROLLED_CUTOVER", sales_paused: 1 });
    const totalEventsAfter = (db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events").get() as { n: number }).n;
    expect(totalEventsAfter).toBe(totalEventsBefore);
    const reopenedEvents = (db.prepare("SELECT COUNT(*) AS n FROM release_sales_gate_events WHERE release_id = ? AND action = 'REOPENED'").get(deployReleaseId) as { n: number }).n;
    expect(reopenedEvents).toBe(0);
  });
});
