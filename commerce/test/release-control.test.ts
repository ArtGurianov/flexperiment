import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { evaluateReopenGate, ReleaseSalesGate, releaseRuntimeEvidence, type ReleaseControlRequest, type ReleaseRuntimeEvidence } from "../src/release-control";

const sourceCommit = "a".repeat(40);
const legalHashes = {
  PUBLIC_OFFER: "b".repeat(64),
  PRIVACY_POLICY: "c".repeat(64),
  PD_CONSENT: "d".repeat(64),
  CHECKOUT_DISCLOSURE: "e".repeat(64),
};

const request = (migration: string): ReleaseControlRequest => ({
  release_id: randomUUID(),
  mode: "CONTROLLED_CUTOVER",
  expected: { source_commit: sourceCommit, migration, legal_version: "2026-08-23.2", legal_manifest_sha256: "f".repeat(64), legal_hashes: legalHashes },
});

const evidence = (migrationVersions: string[]): ReleaseRuntimeEvidence => ({
  source_commit: sourceCommit,
  required_migrations: {},
  migration_versions: migrationVersions,
  legal_version: "2026-08-23.2",
  legal_manifest_sha256: "f".repeat(64),
  legal_hashes: legalHashes,
  legal_publish_time: new Date().toISOString(),
  current_legal_copies_match: true,
  worker_source_commit: sourceCommit,
  worker_observed_at: new Date().toISOString(),
  worker_last_successful_sweep_at: null,
  source_legal_manifest_sha256: null,
  source_legal_publish_time: null,
});

describe("release-control migration readiness", () => {
  it("allows a Phase 0 guarded reopen with 0032 and 0033 while 0031 is intentionally absent", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const phase0 = request("0033_runtime_release_evidence.sql");
    const runtime = releaseRuntimeEvidence(db, { sourceCommit, currentLegalCopiesMatch: () => true });
    const phase0Evidence = { ...evidence(runtime.migration_versions), required_migrations: runtime.required_migrations };

    expect(runtime.required_migrations).toMatchObject({ "0031_participant_age_band.sql": false, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true });
    expect(evaluateReopenGate(phase0, phase0Evidence)).toBeUndefined();
    const gate = new ReleaseSalesGate(db);
    gate.acquire(phase0);
    gate.pause(phase0);
    expect(() => gate.reopen(phase0, phase0Evidence)).not.toThrow();
    expect(gate.status().sales_paused).toBe(false);
    db.close();
  });

  it("requires both Phase 0 migrations", () => {
    const phase0 = request("0033_runtime_release_evidence.sql");
    expect(evaluateReopenGate(phase0, evidence(["0033_runtime_release_evidence.sql"]))).toBe("REQUIRED_MIGRATION_NOT_APPLIED_0032_release_sales_gate.sql");
    expect(evaluateReopenGate(phase0, evidence(["0032_release_sales_gate.sql"]))).toBe("REQUIRED_MIGRATION_NOT_APPLIED_0033_runtime_release_evidence.sql");
  });

  it("enforces the full-cutover migration set and rejects unknown expectations before pause", () => {
    const full = request("0034_worker_sweep_evidence.sql");
    const fullVersions = ["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"];
    expect(evaluateReopenGate(full, evidence(fullVersions))).toBeUndefined();
    expect(evaluateReopenGate(full, evidence(fullVersions.filter((version) => version !== "0031_participant_age_band.sql")))).toBe("REQUIRED_MIGRATION_NOT_APPLIED_0031_participant_age_band.sql");

    const unknown = request("0099_unknown_release.sql");
    expect(evaluateReopenGate(unknown, evidence(fullVersions))).toBe("UNKNOWN_EXPECTED_MIGRATION");
    const db = openDatabase(":memory:");
    migrate(db);
    expect(() => new ReleaseSalesGate(db).acquire(unknown)).toThrow("UNKNOWN_EXPECTED_MIGRATION");
    expect(new ReleaseSalesGate(db).status().sales_paused).toBe(false);
    db.close();
  });
});
