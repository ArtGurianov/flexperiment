import { createHash, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q5 = "b153ed226770a947cdbf9cd83e1a9c1181b7cf6f";
const Q6 = "fa3b4aa5651956bb0a35f7a843e95423f057824b";
const OLD_Q2_RELEASE = "agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-activation-${Q5}/certificate.json`;

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "agent-referrals-test-otp-pepper";

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

type Q6Gate = {
  acquire(input: unknown): unknown;
  completeRolling(input: unknown, dormantReady: () => boolean): unknown;
  supersedeStrandedAgentReferralsRolling(input: unknown, evidence: () => { runtime_source_commit: string | null; replacement_dormant_ready: boolean }): unknown;
  status(): { owner_release_id: string | null; owner_mode: string | null; sales_paused: boolean };
  completion(releaseId: string): unknown;
  resolution(releaseId: string): unknown;
};

type Q6Modules = {
  db: typeof import("../src/db");
  provider: { MockProvider: new () => unknown };
  domain: { CommerceDomain: new (db: unknown, provider: unknown) => { releaseRuntimeEvidence(): unknown } };
  expectation: typeof import("../src/release-expectation");
  runtime: typeof import("../src/runtime-release-evidence");
  gate: { ReleaseSalesGate: new (db: unknown) => Q6Gate };
  feature: typeof import("../src/agent-referrals-feature-state");
  activation: { activateAgentReferralsIfReady: (db: unknown, runtimeReader: () => unknown, gate: unknown, otpDeliveryReader: () => unknown, input: unknown) => unknown };
};

type LegalHashes = Record<"PUBLIC_OFFER" | "PRIVACY_POLICY" | "PD_CONSENT" | "CHECKOUT_DISCLOSURE", string>;
const LEGAL_PATHS = {
  PUBLIC_OFFER: "public/legal/public-offer.md",
  PRIVACY_POLICY: "public/legal/privacy-policy.md",
  PD_CONSENT: "public/legal/personal-data-consent.md",
  CHECKOUT_DISCLOSURE: "public/legal/disclaimer.md",
} as const;

const legalManifest = (root: string, version: string) => {
  const hash = (path: string) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
  const hashes: LegalHashes = Object.fromEntries(Object.entries(LEGAL_PATHS).map(([id, path]) => [id, hash(path)])) as LegalHashes;
  const manifest = JSON.stringify({ documents: Object.fromEntries(Object.entries(hashes).map(([document_id, sha256]) => [document_id, {
    document_id, version, sha256, current_url: `https://flexperiment.ru/legal/${document_id.toLowerCase()}.md`,
    archive_url: `https://flexperiment.ru/legal/archive/${document_id.toLowerCase()}/${version}/${document_id.toLowerCase()}.md`, checkout_relevant: true,
  }])) });
  return { hashes, manifest, sha256: createHash("sha256").update(manifest).digest("hex") };
};

describe("Q6 activation terminal identity correction", () => {
  let root: string;
  let modules: Q6Modules;
  let previousCwd: string;

  beforeAll(async () => {
    const certificate = JSON.parse(readFileSync(CERTIFICATE_PATH, "utf8")) as ControlledCandidateCertificate;
    const reconstructed = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: git("rev-parse", "HEAD") });
    expect(reconstructed).toBe(Q6);
    expect(git("rev-parse", `${reconstructed}^`)).toBe(Q5);
    expect(git("diff", "--name-only", Q5, reconstructed)).toBe("commerce/src/agent-referrals-activation-readiness.ts");
    root = mkdtempSync(join(tmpdir(), "q6-activation-terminal-identity-"));
    const added = spawnSync("git", ["worktree", "add", "--detach", root, reconstructed], { encoding: "utf8" });
    if (added.status !== 0) throw new Error(added.stderr);
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    modules = {
      db: await import(join(root, "commerce/src/db.ts")),
      provider: await import(join(root, "commerce/src/provider.ts")),
      domain: await import(join(root, "commerce/src/domain.ts")),
      expectation: await import(join(root, "commerce/src/release-expectation.ts")),
      runtime: await import(join(root, "commerce/src/runtime-release-evidence.ts")),
      gate: await import(join(root, "commerce/src/release-control.ts")),
      feature: await import(join(root, "commerce/src/agent-referrals-feature-state.ts")),
      activation: await import(join(root, "commerce/src/agent-referrals-activation-readiness.ts")),
    };
  }, 60_000);

  afterAll(() => {
    spawnSync("git", ["worktree", "remove", "--force", root]);
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => { previousCwd = process.cwd(); process.chdir(root); process.env.SOURCE_COMMIT = Q6; });
  afterEach(() => { process.chdir(previousCwd); delete process.env.SOURCE_COMMIT; });

  const count = (sqlite: ReturnType<typeof modules.db.openDatabase>) => ({
    events: Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get() as { n: number }).n),
    manifests: Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get() as { n: number }).n),
  });

  const fresh = (terminal: "Q6" | "Q5" | "MISMATCHED" | "NONE" = "Q6", otpConfigured = true) => {
    const sqlite = modules.db.openDatabase(":memory:");
    modules.db.migrate(sqlite, join(root, "commerce/migrations"));
    const legal = legalManifest(root, "q6-test");
    sqlite.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, datetime('now'), ?, 1)")
      .run(randomUUID(), "q6-test", legal.manifest);
    modules.runtime.recordRuntimeStartupEvidence(sqlite, "WORKER", Q6);
    modules.runtime.recordSuccessfulWorkerSweep(sqlite, Q6);
    const migrationVersions = (sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((entry) => entry.version);
    const expected = {
      source_commit: Q6,
      migration: modules.expectation.migrationInventoryExpectation(migrationVersions),
      legal_version: "q6-test",
      legal_manifest_sha256: legal.sha256,
      legal_hashes: legal.hashes,
    };
    const gate = new modules.gate.ReleaseSalesGate(sqlite);
    gate.acquire({ release_id: OLD_Q2_RELEASE, mode: "ROLLING", expected: { ...expected, source_commit: Q2 } });
    gate.supersedeStrandedAgentReferralsRolling({
      release_id: OLD_Q2_RELEASE, expected_old_source_commit: Q2, replacement_source_commit: Q3,
      replacement_expected: { ...expected, source_commit: Q3 }, reason_code: "SURFACE_CONTRACT_UNAVAILABLE", incident_run_id: "34027377689",
    }, () => ({ runtime_source_commit: Q3, replacement_dormant_ready: true }));

    if (terminal !== "NONE") {
      const terminalExpected = terminal === "MISMATCHED" || terminal === "Q5" ? { ...expected, source_commit: Q5 } : expected;
      const terminalReleaseId = terminal === "Q5" ? `deploy-${Q5}` : `deploy-${Q6}`;
      gate.acquire({ release_id: terminalReleaseId, mode: "ROLLING", expected: terminalExpected });
      gate.completeRolling({ release_id: terminalReleaseId, mode: "ROLLING", expected: terminalExpected }, () => true);
    }
    const domain = new modules.domain.CommerceDomain(sqlite, new modules.provider.MockProvider());
    const request = {
      activation_id: `agent-referrals-activation-${Q6}`,
      terminal_release_id: `deploy-${Q6}`,
      expected_feature_revision: modules.feature.agentReferralsFeatureState(sqlite).revision,
      expected,
    };
    const activation = (input = request, statusOverride?: Partial<ReturnType<Q6Gate["status"]>>) =>
      modules.activation.activateAgentReferralsIfReady(
        sqlite,
        () => domain.releaseRuntimeEvidence(),
        {
          status: () => ({ ...gate.status(), ...statusOverride }),
          completion: (releaseId: string) => gate.completion(releaseId),
          resolution: (releaseId: string) => gate.resolution(releaseId),
        },
        () => otpConfigured ? { configured: true, provider_id: "unisender-go" } : { configured: false, provider_id: null },
        input,
      );
    return { sqlite, gate, expected, request, activation };
  };

  it("uses only the completed deploy-Q6 identity and atomically writes the activation evidence", () => {
    const { sqlite, request, activation } = fresh();
    try {
      expect(activation()).toMatchObject({ feature_state: { state: "ACTIVE", owner_id: request.activation_id, revision: 2 }, replayed: false });
      expect(count(sqlite)).toEqual({ events: 1, manifests: 1 });
    } finally { sqlite.close(); }
  });

  it.each([
    ["legacy Q4-dormant identity", "Q6", (request: ReturnType<typeof fresh>["request"]) => ({ ...request, terminal_release_id: `agent-referrals-q4-dormant-${Q6}` }), "AGENT_REFERRALS_ACTIVATION_TERMINAL_RELEASE_INVALID"],
    ["missing Q6 completion", "NONE", (request: ReturnType<typeof fresh>["request"]) => request, "AGENT_REFERRALS_ACTIVATION_TERMINAL_RELEASE_UNPROVEN"],
    ["Q5 completion substituted for Q6", "Q5", (request: ReturnType<typeof fresh>["request"]) => request, "AGENT_REFERRALS_ACTIVATION_TERMINAL_RELEASE_UNPROVEN"],
    ["Q6 completion with mismatched expectations", "MISMATCHED", (request: ReturnType<typeof fresh>["request"]) => request, "AGENT_REFERRALS_ACTIVATION_TERMINAL_RELEASE_UNPROVEN"],
    ["wrong activation owner", "Q6", (request: ReturnType<typeof fresh>["request"]) => ({ ...request, activation_id: `agent-referrals-activation-${Q5}` }), "AGENT_REFERRALS_ACTIVATION_OWNER_INVALID"],
    ["wrong feature revision", "Q6", (request: ReturnType<typeof fresh>["request"]) => ({ ...request, expected_feature_revision: request.expected_feature_revision + 1 }), "AGENT_REFERRALS_FEATURE_REVISION_CONFLICT"],
  ] as const)("fails closed for %s without writing feature activation evidence", (_name, terminal, input, code) => {
    const { sqlite, request, activation } = fresh(terminal);
    try {
      expect(() => activation(input(request))).toThrow(code);
      expect(modules.feature.agentReferralsFeatureState(sqlite)).toMatchObject({ state: "DORMANT", owner_id: null, revision: 1 });
      expect(count(sqlite)).toEqual({ events: 0, manifests: 0 });
    } finally { sqlite.close(); }
  });

  it("retains the existing owner, sales, feature-state, and OTP fail-closed fences", () => {
    const cases = [
      { name: "foreign release owner", status: { owner_release_id: "foreign-release", owner_mode: "ROLLING", sales_paused: false }, code: "AGENT_REFERRALS_ACTIVATION_RELEASE_OWNER_PRESENT" },
      { name: "sales paused", status: { owner_release_id: null, owner_mode: null, sales_paused: true }, code: "AGENT_REFERRALS_ACTIVATION_SALES_PAUSED" },
    ] as const;
    for (const testCase of cases) {
      const { sqlite, activation } = fresh();
      try {
        expect(() => activation(undefined, testCase.status)).toThrow(testCase.code);
        expect(count(sqlite)).toEqual({ events: 0, manifests: 0 });
      } finally { sqlite.close(); }
    }
    const otp = fresh("Q6", false);
    try {
      expect(() => otp.activation()).toThrow("AGENT_REFERRALS_ACTIVATION_OTP_DELIVERY_UNAVAILABLE");
      expect(count(otp.sqlite)).toEqual({ events: 0, manifests: 0 });
    } finally { otp.sqlite.close(); }
  });

  it("does not add a completion, release-control mutation, or activation while reconstructing Q6", () => {
    const source = readFileSync(join(root, "commerce/src/agent-referrals-activation-readiness.ts"), "utf8");
    expect(source).toContain("const exactProductionReleaseId = (source: string) => `deploy-${source}`");
    expect(source).not.toContain("agent-referrals-q4-dormant-${source}");
    expect(source).not.toMatch(/\|\|.*deploy-|deploy-.*\|\|/);
    expect(source).not.toContain("completeRolling(");
    expect(source).not.toContain("releaseControl");
  });
});
