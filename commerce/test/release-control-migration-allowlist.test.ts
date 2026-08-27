import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { diagnosticCutoverMigrations, requiredMigrationsFor, ReleaseSalesGate } from "../src/release-control";
import { releaseStateHash, type GenerationHead } from "../src/release-generation";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { while (databases.length) databases.pop()?.close(); });

const legacyRelease = (migration: string) => ({
  release_id: randomUUID(),
  mode: "CONTROLLED_CUTOVER" as const,
  expected: {
    source_commit: "a".repeat(40),
    migration,
    legal_version: "2026-08-25.1",
    legal_manifest_sha256: "b".repeat(64),
    legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
  },
});

const appendEvent = (db: ReturnType<typeof openDatabase>, releaseId: string, action: "ACQUIRED" | "PAUSED" | "REOPENED", details: Record<string, unknown>) =>
  db.prepare("INSERT INTO release_sales_gate_events(id, release_id, action, details_json) VALUES (?, ?, ?, ?)").run(randomUUID(), releaseId, action, JSON.stringify(details));

describe("generic-deploy migration allowlist", () => {
  it("supports the current 0035 and 0036 named migrations", () => {
    expect(requiredMigrationsFor("0035_promo_codes_v0.sql")).toBeDefined();
    expect(requiredMigrationsFor("0036_tochka_provider_error_evidence.sql")).toBeDefined();
  });

  it("lists 0036 exactly once in its own required-migration set", () => {
    const required = requiredMigrationsFor("0036_tochka_provider_error_evidence.sql")!;
    expect(required.filter((migration) => migration === "0036_tochka_provider_error_evidence.sql")).toHaveLength(1);
  });

  it("keeps the complete predecessor chain for 0036", () => {
    expect(requiredMigrationsFor("0036_tochka_provider_error_evidence.sql")).toEqual([...diagnosticCutoverMigrations, "0035_promo_codes_v0.sql", "0036_tochka_provider_error_evidence.sql"]);
  });

  it("fails closed for an unknown future migration", () => {
    expect(requiredMigrationsFor("0037_unknown_future_migration.sql")).toBeUndefined();
  });

  it("rejects legacy acquire for an unrecognized future migration even with no v2 history", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    expect(() => gate.acquire(legacyRelease("0037_unknown_future_migration.sql"))).toThrow("UNKNOWN_EXPECTED_MIGRATION");
  });

  it("reproduces the production condition: durable expected_migration=0036, sole v2 release COMPLETE, generic acquire must not throw UNKNOWN_EXPECTED_MIGRATION", () => {
    const db = openDatabase(":memory:"); databases.push(db); migrate(db);
    const gate = new ReleaseSalesGate(db);
    const releaseId = `promo-codes-v0:${randomUUID()}`;
    const head: GenerationHead = {
      release_id: releaseId, candidate_generation: 1, source_commit: "a".repeat(40),
      migration_inventory: { files: { "0036_tochka_provider_error_evidence.sql": "b".repeat(64) } },
      legal_baseline: { legal_version: "v1", legal_manifest_sha256: "c".repeat(64), legal_hashes: {} },
      release_family: "promo-codes-v0", checkout_contract_version: "promo-codes-v0", admin_contract_version: "promo-codes-v0",
      phase: "PAUSED", phase_sequence: 0,
    };
    const acquired = gate.acquireCandidate({ head });
    const deployed = gate.changeCandidatePhase({ release_id: releaseId, candidate_generation: 1, expected_state_hash: releaseStateHash(acquired.head), from_phase: "PAUSED", phase_sequence: 0, to_phase: "DEPLOYED_READ_ONLY" });

    // Hand-append the certification lifecycle directly at the ledger level
    // (mirroring the exact envelopes activateCertificationLease /
    // consumeCertificationLease / certifyCandidate / completeCandidate
    // produce) so this test proves only the replay-plus-legacy-acquire
    // interaction, without needing real occurrence/promo/order/payment rows
    // that those domain methods would otherwise require.
    const lease = { lease_id: randomUUID(), occurrence_id: randomUUID(), promo_id: randomUUID(), expected_idempotency_key_hash: "d".repeat(64), lease_expires_at: new Date(Date.now() + 200_000).toISOString() };
    const certificationOnly = { ...deployed.head, phase: "CERTIFICATION_ONLY" as const, phase_sequence: deployed.head.phase_sequence + 1, certification: { ...lease, status: "ACTIVE" as const } };
    appendEvent(db, releaseId, "PAUSED", { schema_version: 2, kind: "PHASE_CHANGED", from_phase: deployed.head.phase, from_phase_sequence: deployed.head.phase_sequence, head: certificationOnly });

    const inFlight = { ...certificationOnly, phase: "CERTIFICATION_IN_FLIGHT" as const, phase_sequence: certificationOnly.phase_sequence + 1, certification: { ...lease, status: "CONSUMED" as const } };
    appendEvent(db, releaseId, "PAUSED", { schema_version: 2, kind: "PHASE_CHANGED", from_phase: certificationOnly.phase, from_phase_sequence: certificationOnly.phase_sequence, head: inFlight });

    const certified = { ...inFlight, phase: "CERTIFIED" as const, phase_sequence: inFlight.phase_sequence + 1 };
    appendEvent(db, releaseId, "PAUSED", {
      schema_version: 2, kind: "PHASE_CHANGED", from_phase: inFlight.phase, from_phase_sequence: inFlight.phase_sequence, head: certified,
      certification_evidence: { occurrence_id: lease.occurrence_id, promo_id: lease.promo_id, order_id: randomUUID(), payment_id: randomUUID(), refund_id: randomUUID(), price_kopecks: 101, discount_kopecks: 1, amount_kopecks: 100, captured_kopecks: 100, refunded_kopecks: 100 },
    });

    const complete = { ...certified, phase: "COMPLETE" as const, phase_sequence: certified.phase_sequence + 1 };
    appendEvent(db, releaseId, "REOPENED", { schema_version: 2, kind: "PHASE_CHANGED", from_phase: certified.phase, from_phase_sequence: certified.phase_sequence, head: complete });
    db.prepare("UPDATE release_sales_gate SET sales_paused = 0, owner_release_id = NULL, owner_mode = NULL, reopened_at = datetime('now'), updated_at = datetime('now') WHERE singleton = 1").run();

    expect(() => gate.acquire(legacyRelease("0036_tochka_provider_error_evidence.sql"))).not.toThrow();
  });
});
