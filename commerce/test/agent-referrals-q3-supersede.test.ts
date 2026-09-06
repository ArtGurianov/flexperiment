import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const OLD_RELEASE = "agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f";
const certPath = ".release/controlled-candidates/agent-referrals-recovery-2dc1a55a070a7e9e9ebcd52f46dff8d171da223e/certificate.json";
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

describe("Q3 stranded ROLLING supersede semantics", () => {
  let root: string;
  let gateModule: typeof import("../src/release-control");
  let dbModule: typeof import("../src/db");
  const replacement = "a".repeat(40);
  const expected = { source_commit: Q2, migration: "0033_runtime_release_evidence.sql", legal_version: "2026-08-25.1", legal_manifest_sha256: "b".repeat(64), legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) } };
  const request = () => ({ release_id: OLD_RELEASE, expected_old_source_commit: Q2, replacement_source_commit: replacement, replacement_expected: { ...expected, source_commit: replacement }, reason_code: "SURFACE_CONTRACT_UNAVAILABLE", incident_run_id: "34027377689" }) as const;

  beforeAll(async () => {
    const certificate = JSON.parse(readFileSync(certPath, "utf8")) as ControlledCandidateCertificate;
    const q3 = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: git("rev-parse", "HEAD") });
    root = mkdtempSync(join(tmpdir(), "q3-supersede-"));
    const added = spawnSync("git", ["worktree", "add", "--detach", root, q3], { encoding: "utf8" });
    if (added.status !== 0) throw new Error(added.stderr);
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    gateModule = await import(join(root, "commerce/src/release-control.ts"));
    dbModule = await import(join(root, "commerce/src/db.ts"));
  }, 60_000);

  afterAll(() => { spawnSync("git", ["worktree", "remove", "--force", root]); rmSync(root, { recursive: true, force: true }); });

  const fresh = () => {
    const db = dbModule.openDatabase(":memory:");
    dbModule.migrate(db, join(root, "commerce/migrations"));
    const gate = new gateModule.ReleaseSalesGate(db);
    gate.acquire({ release_id: OLD_RELEASE, mode: "ROLLING", expected });
    return { db, gate };
  };

  it("records a non-success resolution, clears only the exact held owner, and is exact-idempotent", () => {
    const { db, gate } = fresh();
    try {
      expect(() => gate.supersedeStrandedAgentReferralsRolling(request(), () => ({ runtime_source_commit: replacement, replacement_dormant_ready: false }))).toThrow("REPLACEMENT_NOT_DORMANT_READY");
      const result = gate.supersedeStrandedAgentReferralsRolling(request(), () => ({ runtime_source_commit: replacement, replacement_dormant_ready: true }));
      expect(result).toMatchObject({ owner_release_id: null, owner_mode: null, sales_paused: false });
      expect(gate.completion(OLD_RELEASE).complete).toBe(false);
      expect(gate.resolution(OLD_RELEASE)).toMatchObject({ complete: false, resolution: "SUPERSEDED", reason_code: "SURFACE_CONTRACT_UNAVAILABLE", replacement_source_commit: replacement });
      expect(gate.supersedeStrandedAgentReferralsRolling(request(), () => ({ runtime_source_commit: replacement, replacement_dormant_ready: true }))).toMatchObject({ owner_release_id: null });
      expect(() => gate.supersedeStrandedAgentReferralsRolling({ ...request(), replacement_source_commit: "d".repeat(40), replacement_expected: { ...expected, source_commit: "d".repeat(40) } as typeof expected }, () => ({ runtime_source_commit: replacement, replacement_dormant_ready: true }))).toThrow("OWNER_MISMATCH");
    } finally { db.close(); }
  });
});
