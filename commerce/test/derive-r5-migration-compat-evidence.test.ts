import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = "commerce/src/derive-r5-migration-compat-evidence.ts";
const EXACT_R5 = "71f6971cea630d4da9a1cb1c57f3ad01e8fdffe1";

const temporaryDirectories: string[] = [];
afterEach(() => { while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true }); });

const baseStatus = () => ({
  sales_paused: true,
  owner_release_id: "deploy-aa492d5a6361c8d43f8cbb2a4e3b245611f4f76b",
  owner_mode: "CONTROLLED_CUTOVER",
  expected: { source_commit: EXACT_R5, migration: "0036_tochka_provider_error_evidence.sql", legal_version: "2026-08-26.1", legal_manifest_sha256: "6cd4c54a3e63cf29ddb4a69330fb7e7794ec19c6da19cb64131b7dc9ef6bc9f3" },
  acquired_at: "2026-08-27 17:43:33",
  paused_at: "2026-08-27 17:43:33",
  reopened_at: "2026-08-27 14:32:08",
  runtime: {
    source_commit: EXACT_R5,
    required_migrations: { "0031_participant_age_band.sql": true, "0032_release_sales_gate.sql": true, "0033_runtime_release_evidence.sql": true, "0034_worker_sweep_evidence.sql": true },
    migration_versions: ["0001_initial.sql", "0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql", "0035_promo_codes_v0.sql", "0036_tochka_provider_error_evidence.sql"],
    worker_source_commit: EXACT_R5,
    worker_started_at: "2026-08-27T21:00:06Z",
    worker_observed_at: "2026-08-28T03:45:25Z",
    worker_last_successful_sweep_at: "2026-08-28T03:45:25Z",
    legal_version: "2026-08-26.1",
    legal_manifest_sha256: "6cd4c54a3e63cf29ddb4a69330fb7e7794ec19c6da19cb64131b7dc9ef6bc9f3",
    legal_hashes: { PUBLIC_OFFER: "a".repeat(64), PRIVACY_POLICY: "b".repeat(64), PD_CONSENT: "c".repeat(64), CHECKOUT_DISCLOSURE: "d".repeat(64) },
    current_legal_copies_match: true,
  },
});

const run = (status: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "r5-compat-"));
  temporaryDirectories.push(dir);
  const inputPath = join(dir, "status-before.json");
  const outputPath = join(dir, "status-before-r5-compat.json");
  writeFileSync(inputPath, JSON.stringify(status));
  const result = spawnSync("node", ["--import", "tsx", SCRIPT, inputPath, outputPath], { cwd: process.cwd(), encoding: "utf8" });
  let output: unknown;
  try { output = JSON.parse(readFileSync(outputPath, "utf8")); } catch { output = undefined; }
  return { result, output };
};

describe("derive-r5-migration-compat-evidence", () => {
  it("the exact known defect pattern: adds exactly the two missing keys, nothing else differs", () => {
    const status = baseStatus();
    const { result, output } = run(status);
    expect(result.status, result.stderr).toBe(0);
    expect(output).toEqual({
      ...status,
      runtime: {
        ...status.runtime,
        required_migrations: { ...status.runtime.required_migrations, "0035_promo_codes_v0.sql": true, "0036_tochka_provider_error_evidence.sql": true },
      },
    });
    // Every other top-level and runtime field byte-identical.
    const outputRecord = output as Record<string, unknown>;
    const outputRuntime = outputRecord.runtime as Record<string, unknown>;
    expect(outputRecord.owner_release_id).toBe(status.owner_release_id);
    expect(outputRecord.sales_paused).toBe(status.sales_paused);
    expect(outputRecord.expected).toEqual(status.expected);
    expect(outputRuntime.migration_versions).toEqual(status.runtime.migration_versions);
    expect(outputRuntime.legal_hashes).toEqual(status.runtime.legal_hashes);
    expect(outputRuntime.worker_last_successful_sweep_at).toBe(status.runtime.worker_last_successful_sweep_at);
  });

  it("fails closed on an owner expected.source_commit that is not exact R5, even though runtime.source_commit is exact R5", () => {
    const status = baseStatus();
    status.expected.source_commit = "b".repeat(40);
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_EXPECTED_SOURCE_COMMIT_MISMATCH");
    expect(output).toBeUndefined();
  });

  it("fails closed on an owner expected.migration that is not exactly 0036, even though runtime evidence otherwise matches the known defect pattern", () => {
    const status = baseStatus();
    status.expected.migration = "0037_unrelated_migration.sql";
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_EXPECTED_MIGRATION_MISMATCH");
    expect(output).toBeUndefined();
  });

  it("fails closed on a runtime.source_commit that is not exact R5", () => {
    const status = baseStatus();
    status.runtime.source_commit = "b".repeat(40);
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_SOURCE_COMMIT_MISMATCH");
    expect(output).toBeUndefined();
  });

  it.each(["0031_participant_age_band.sql", "0032_release_sales_gate.sql", "0033_runtime_release_evidence.sql", "0034_worker_sweep_evidence.sql"])(
    "fails closed if diagnostic migration %s is not true",
    (migration) => {
      const status = baseStatus();
      (status.runtime.required_migrations as Record<string, boolean>)[migration] = false;
      const { result, output } = run(status);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("R5_COMPAT_DIAGNOSTIC_MIGRATION_NOT_APPLIED");
      expect(output).toBeUndefined();
    },
  );

  it("fails closed if 0035 is missing from migration_versions", () => {
    const status = baseStatus();
    status.runtime.migration_versions = status.runtime.migration_versions.filter((v) => v !== "0035_promo_codes_v0.sql");
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_PREREQUISITE_MIGRATION_MISSING");
    expect(output).toBeUndefined();
  });

  it("fails closed if 0036 is missing from migration_versions", () => {
    const status = baseStatus();
    status.runtime.migration_versions = status.runtime.migration_versions.filter((v) => v !== "0036_tochka_provider_error_evidence.sql");
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_EXPECTED_MIGRATION_MISSING");
    expect(output).toBeUndefined();
  });

  it("fails closed if 0035 is already present as a required_migrations key (not the known defect pattern)", () => {
    const status = baseStatus();
    (status.runtime.required_migrations as Record<string, boolean>)["0035_promo_codes_v0.sql"] = false;
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_UNEXPECTED_PREREQUISITE_KEY_PRESENT");
    expect(output).toBeUndefined();
  });

  it("fails closed if 0036 is already present as a required_migrations key (not the known defect pattern)", () => {
    const status = baseStatus();
    (status.runtime.required_migrations as Record<string, boolean>)["0036_tochka_provider_error_evidence.sql"] = true;
    const { result, output } = run(status);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R5_COMPAT_UNEXPECTED_EXPECTED_KEY_PRESENT");
    expect(output).toBeUndefined();
  });

  it("requires both an input and an output path", () => {
    const dir = mkdtempSync(join(tmpdir(), "r5-compat-"));
    temporaryDirectories.push(dir);
    const result = spawnSync("node", ["--import", "tsx", SCRIPT], { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status).not.toBe(0);
  });
});
