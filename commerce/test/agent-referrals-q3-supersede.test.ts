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

type Gate = {
  acquire(input: unknown): unknown;
  completeRolling(input: unknown, dormantReady: () => boolean): unknown;
  supersedeStrandedAgentReferralsRolling(input: unknown, evidence: () => { runtime_source_commit: string | null; replacement_dormant_ready: boolean }): { owner_release_id: string | null; owner_mode: string | null; sales_paused: boolean };
  completion(releaseId: string): { complete: boolean };
  resolution(releaseId: string): { complete: boolean; resolution: string; reason_code: string | null; replacement_source_commit: string | null };
};

type Q3GateModule = { ReleaseSalesGate: new (db: unknown) => Gate };

describe("Q3 stranded ROLLING supersede semantics", () => {
  let root: string;
  // This module exists only in the reconstructed Q3 worktree.  Do not bind
  // this dynamic import to the controller tree's older type declarations.
  let gateModule: Q3GateModule;
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
    gateModule = await import(join(root, "commerce/src/release-control.ts")) as Q3GateModule;
    dbModule = await import(join(root, "commerce/src/db.ts"));
  }, 60_000);

  afterAll(() => { spawnSync("git", ["worktree", "remove", "--force", root]); rmSync(root, { recursive: true, force: true }); });

  const fresh = (releaseId = OLD_RELEASE, mode: "ROLLING" | "CONTROLLED_CUTOVER" = "ROLLING", source = Q2) => {
    const db = dbModule.openDatabase(":memory:");
    dbModule.migrate(db, join(root, "commerce/migrations"));
    const gate = new gateModule.ReleaseSalesGate(db);
    gate.acquire({ release_id: releaseId, mode, expected: { ...expected, source_commit: source } });
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
      expect(() => gate.supersedeStrandedAgentReferralsRolling({ ...request(), replacement_source_commit: "d".repeat(40), replacement_expected: { ...expected, source_commit: "d".repeat(40) } }, () => ({ runtime_source_commit: replacement, replacement_dormant_ready: true }))).toThrow("OWNER_MISMATCH");
    } finally { db.close(); }
  });

  it("rejects every distinct held-state guard before it mutates the old owner", () => {
    const cases: ReadonlyArray<{ name: string; setup: (db: ReturnType<typeof dbModule.openDatabase>, gate: Gate) => void; evidence?: { runtime_source_commit: string | null; replacement_dormant_ready: boolean } }> = [
      { name: "wrong owner", setup: () => undefined },
      { name: "wrong mode", setup: () => undefined },
      { name: "sales paused", setup: (db) => { db.prepare("UPDATE release_sales_gate SET sales_paused = 1 WHERE singleton = 1").run(); } },
      { name: "old acquired source differs", setup: () => undefined },
      { name: "replacement runtime source mismatch", setup: () => undefined, evidence: { runtime_source_commit: "e".repeat(40), replacement_dormant_ready: true } },
    ];
    for (const entry of cases) {
      const input = entry.name === "wrong owner" ? fresh("foreign-release-123") : entry.name === "wrong mode" ? fresh(OLD_RELEASE, "CONTROLLED_CUTOVER") : entry.name === "old acquired source differs" ? fresh(OLD_RELEASE, "ROLLING", "b".repeat(40)) : fresh();
      try {
        entry.setup(input.db, input.gate);
        expect(() => input.gate.supersedeStrandedAgentReferralsRolling(request(), () => entry.evidence ?? ({ runtime_source_commit: replacement, replacement_dormant_ready: true }))).toThrow();
      } finally { input.db.close(); }
    }
  });

  it("refuses a previously successfully completed Q2 release", () => {
    const { db, gate } = fresh();
    try {
      gate.completeRolling({ release_id: OLD_RELEASE, mode: "ROLLING", expected }, () => true);
      expect(gate.completion(OLD_RELEASE).complete).toBe(true);
      expect(() => gate.supersedeStrandedAgentReferralsRolling(request(), () => ({ runtime_source_commit: replacement, replacement_dormant_ready: true }))).toThrow("OWNER_MISMATCH");
    } finally { db.close(); }
  });
});
