import { createHash, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q6 = "fa3b4aa5651956bb0a35f7a843e95423f057824b";
const Q7 = "ce66d23fdcea5fc84018be43cf428270ea889ee8";
const Q7_TREE = "1cbcce745d176dc0d15eb0811a34791e58ad9cdc";
const OLD_Q2_RELEASE = "agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-activation-${Q6}/certificate.json`;

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_RELEASE_CONTROL_TOKEN ??= "release-control-test-token";
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "agent-referrals-test-otp-pepper";

const headers = { Authorization: "Bearer release-control-test-token", "Content-Type": "application/json" };
const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

type Q7Gate = {
  acquire(input: unknown): unknown;
  completeRolling(input: unknown, dormantReady: () => boolean): unknown;
  supersedeStrandedAgentReferralsRolling(input: unknown, evidence: () => { runtime_source_commit: string | null; replacement_dormant_ready: boolean }): unknown;
};

type Q7Modules = {
  db: typeof import("../src/db");
  api: { createApp: typeof import("../src/api").createApp };
  provider: typeof import("../src/provider");
  runtime: typeof import("../src/runtime-release-evidence");
  expectation: typeof import("../src/release-expectation");
  gate: { ReleaseSalesGate: new (db: unknown) => Q7Gate };
  feature: typeof import("../src/agent-referrals-feature-state");
  schema: { agentReferralsActivationSchema: { safeParse(input: unknown): { success: boolean } } };
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
  const hashes = Object.fromEntries(Object.entries(LEGAL_PATHS).map(([id, path]) => [id, hash(path)])) as LegalHashes;
  const manifest = JSON.stringify({ documents: Object.fromEntries(Object.entries(hashes).map(([document_id, sha256]) => [document_id, {
    document_id, version, sha256, current_url: `https://flexperiment.ru/legal/${document_id.toLowerCase()}.md`,
    archive_url: `https://flexperiment.ru/legal/archive/${document_id.toLowerCase()}/${version}/${document_id.toLowerCase()}.md`, checkout_relevant: true,
  }])) });
  return { hashes, manifest, sha256: createHash("sha256").update(manifest).digest("hex") };
};

describe("Q7 activation HTTP terminal-identity correction", () => {
  let root: string;
  let modules: Q7Modules;
  let previousCwd: string;

  beforeAll(async () => {
    const certificate = JSON.parse(readFileSync(CERTIFICATE_PATH, "utf8")) as ControlledCandidateCertificate;
    const reconstructed = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: git("rev-parse", "HEAD") });
    expect(reconstructed).toBe(Q7);
    expect(git("rev-parse", `${reconstructed}^`)).toBe(Q6);
    expect(git("rev-parse", `${reconstructed}^{tree}`)).toBe(Q7_TREE);
    expect(git("diff", "--name-only", Q6, reconstructed)).toBe("commerce/src/release-control-schema.ts");
    root = mkdtempSync(join(tmpdir(), "q7-activation-http-schema-"));
    const added = spawnSync("git", ["worktree", "add", "--detach", root, reconstructed], { encoding: "utf8" });
    if (added.status !== 0) throw new Error(added.stderr);
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    modules = {
      db: await import(join(root, "commerce/src/db.ts")),
      api: await import(join(root, "commerce/src/api.ts")),
      provider: await import(join(root, "commerce/src/provider.ts")),
      runtime: await import(join(root, "commerce/src/runtime-release-evidence.ts")),
      expectation: await import(join(root, "commerce/src/release-expectation.ts")),
      gate: await import(join(root, "commerce/src/release-control.ts")),
      feature: await import(join(root, "commerce/src/agent-referrals-feature-state.ts")),
      schema: await import(join(root, "commerce/src/release-control-schema.ts")),
    };
  }, 60_000);

  afterAll(() => {
    spawnSync("git", ["worktree", "remove", "--force", root]);
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => { previousCwd = process.cwd(); process.chdir(root); process.env.SOURCE_COMMIT = Q7; });
  afterEach(() => { process.chdir(previousCwd); delete process.env.SOURCE_COMMIT; });

  const fresh = () => {
    const sqlite = modules.db.openDatabase(":memory:");
    modules.db.migrate(sqlite, join(root, "commerce/migrations"));
    const legal = legalManifest(root, "q7-test");
    sqlite.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, datetime('now'), ?, 1)")
      .run(randomUUID(), "q7-test", legal.manifest);
    modules.runtime.recordRuntimeStartupEvidence(sqlite, "WORKER", Q7);
    modules.runtime.recordSuccessfulWorkerSweep(sqlite, Q7);
    const migrationVersions = (sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((entry) => entry.version);
    const expected = {
      source_commit: Q7,
      migration: modules.expectation.migrationInventoryExpectation(migrationVersions),
      legal_version: "q7-test",
      legal_manifest_sha256: legal.sha256,
      legal_hashes: legal.hashes,
    };
    const gate = new modules.gate.ReleaseSalesGate(sqlite);
    gate.acquire({ release_id: OLD_Q2_RELEASE, mode: "ROLLING", expected: { ...expected, source_commit: Q2 } });
    gate.supersedeStrandedAgentReferralsRolling({
      release_id: OLD_Q2_RELEASE, expected_old_source_commit: Q2, replacement_source_commit: Q3,
      replacement_expected: { ...expected, source_commit: Q3 }, reason_code: "SURFACE_CONTRACT_UNAVAILABLE", incident_run_id: "34027377689",
    }, () => ({ runtime_source_commit: Q3, replacement_dormant_ready: true }));
    const terminalReleaseId = `deploy-${Q7}`;
    gate.acquire({ release_id: terminalReleaseId, mode: "ROLLING", expected });
    gate.completeRolling({ release_id: terminalReleaseId, mode: "ROLLING", expected }, () => true);
    const otpSender = { async send() { return "ACCEPTED" as const; }, deliveryCapability: () => ({ configured: true, provider_id: "unisender-go" as const }) };
    const app = modules.api.createApp(sqlite, new modules.provider.MockProvider(), undefined, undefined, otpSender as never);
    const request = {
      activation_id: `agent-referrals-activation-${Q7}`,
      terminal_release_id: terminalReleaseId,
      expected_feature_revision: modules.feature.agentReferralsFeatureState(sqlite).revision,
      expected,
    };
    return { sqlite, app, request };
  };

  const activate = (app: ReturnType<typeof fresh>["app"], request: ReturnType<typeof fresh>["request"]) =>
    app.request("http://x/v1/internal/release-control/agent-referrals/activate", { method: "POST", headers, body: JSON.stringify(request) });
  const evidenceCounts = (sqlite: ReturnType<typeof fresh>["sqlite"]) => ({
    events: Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get() as { n: number }).n),
    manifests: Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get() as { n: number }).n),
  });

  it("accepts deploy-Q7 through the HTTP schema and the matching runtime readiness authority", async () => {
    const { sqlite, app, request } = fresh();
    try {
      expect(modules.schema.agentReferralsActivationSchema.safeParse(request).success).toBe(true);
      expect((await activate(app, request)).status).toBe(200);
      expect(modules.feature.agentReferralsFeatureState(sqlite)).toMatchObject({ state: "ACTIVE", owner_id: request.activation_id, revision: 2 });
      expect(evidenceCounts(sqlite)).toEqual({ events: 1, manifests: 1 });
    } finally { sqlite.close(); }
  });

  it.each([
    ["legacy Q4-dormant Q7", `agent-referrals-q4-dormant-${Q7}`, 422],
    ["legacy Q4-dormant Q6", `agent-referrals-q4-dormant-${Q6}`, 422],
    ["Q6 deployment identity for Q7 source", `deploy-${Q6}`, 409],
    ["arbitrary release identity", "deploy-not-a-commit", 422],
    ["malformed SHA", "deploy-ABCDEF", 422],
  ])("fails closed for %s", async (_name, terminal_release_id, status) => {
    const { sqlite, app, request } = fresh();
    try {
      const candidate = { ...request, terminal_release_id };
      const response = await activate(app, candidate);
      expect(response.status).toBe(status);
      expect(modules.feature.agentReferralsFeatureState(sqlite)).toMatchObject({ state: "DORMANT", owner_id: null, revision: 1 });
      expect(evidenceCounts(sqlite)).toEqual({ events: 0, manifests: 0 });
    } finally { sqlite.close(); }
  });

  it("changes only the HTTP grammar and keeps the legacy grammar out of Q7", () => {
    const schema = readFileSync(join(root, "commerce/src/release-control-schema.ts"), "utf8");
    const readiness = readFileSync(join(root, "commerce/src/agent-referrals-activation-readiness.ts"), "utf8");
    expect(schema).toContain("/^deploy-[a-f0-9]{40}$/");
    expect(schema).not.toContain("agent-referrals-q4-dormant-[a-f0-9]{40}");
    expect(readiness).toContain("const exactProductionReleaseId = (source: string) => `deploy-${source}`");
    expect(readiness).not.toMatch(/\|\|.*agent-referrals-q4-dormant|agent-referrals-q4-dormant.*\|\|/);
  });
});
