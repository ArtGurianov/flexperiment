import { createHash, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

const Q2 = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
const Q3 = "f317c836635bfe3a86735ecda6a050c51d4dc924";
const Q4 = "5085eaf541391a6986ff524b1febe4eb20af6cba";
const OLD_Q2_RELEASE = "agent-referrals-f540b997d6d31a22293909ded7ce464c3f51732f";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-activation-${Q3}/certificate.json`;

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

type Q4Modules = {
  db: typeof import("../src/db");
  api: { createApp: typeof import("../src/api").createApp };
  provider: typeof import("../src/provider");
  runtime: typeof import("../src/runtime-release-evidence");
  expectation: typeof import("../src/release-expectation");
  gate: { ReleaseSalesGate: typeof import("../src/release-control").ReleaseSalesGate };
  feature: typeof import("../src/agent-referrals-feature-state");
};

const LEGAL_PATHS = {
  PUBLIC_OFFER: "public/legal/public-offer.md",
  PRIVACY_POLICY: "public/legal/privacy-policy.md",
  PD_CONSENT: "public/legal/personal-data-consent.md",
  CHECKOUT_DISCLOSURE: "public/legal/disclaimer.md",
} as const;

const legalManifest = (root: string, version: string) => {
  const hashes = Object.fromEntries(Object.entries(LEGAL_PATHS).map(([key, path]) => [key, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]));
  const manifest = JSON.stringify({ documents: Object.fromEntries(Object.entries(hashes).map(([document_id, sha256]) => [document_id, {
    document_id, version, sha256,
    current_url: `https://flexperiment.ru/legal/${document_id.toLowerCase()}.md`,
    archive_url: `https://flexperiment.ru/legal/archive/${document_id.toLowerCase()}/${version}/${document_id.toLowerCase()}.md`,
    checkout_relevant: true,
  }])) });
  return { hashes, manifest, sha256: createHash("sha256").update(manifest).digest("hex") };
};

describe("Q4 activation capability: atomic DORMANT to ACTIVE authority", () => {
  let root: string;
  let modules: Q4Modules;
  let previousCwd: string;
  let controllerSha: string;

  beforeAll(async () => {
    controllerSha = git("rev-parse", "HEAD");
    const certificate = JSON.parse(readFileSync(CERTIFICATE_PATH, "utf8")) as ControlledCandidateCertificate;
    const reconstructed = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: git("rev-parse", "HEAD") });
    expect(reconstructed).toBe(Q4);
    root = mkdtempSync(join(tmpdir(), "q4-activation-capability-"));
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
    };
  }, 60_000);

  afterAll(() => {
    spawnSync("git", ["worktree", "remove", "--force", root]);
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => { previousCwd = process.cwd(); process.chdir(root); process.env.SOURCE_COMMIT = Q4; });
  afterEach(() => { process.chdir(previousCwd); delete process.env.SOURCE_COMMIT; });

  function fresh() {
    const sqlite = modules.db.openDatabase(":memory:");
    modules.db.migrate(sqlite, join(root, "commerce/migrations"));
    const legal = legalManifest(root, "q4-test");
    sqlite.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, ?, datetime('now'), ?, 1)")
      .run(randomUUID(), "q4-test", legal.manifest);
    modules.runtime.recordRuntimeStartupEvidence(sqlite, "WORKER", Q4);
    modules.runtime.recordSuccessfulWorkerSweep(sqlite, Q4);
    const migrationVersions = (sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((entry) => entry.version);
    const expected = {
      source_commit: Q4,
      migration: modules.expectation.migrationInventoryExpectation(migrationVersions),
      legal_version: "q4-test",
      legal_manifest_sha256: legal.sha256,
      legal_hashes: legal.hashes,
    };
    const gate = new modules.gate.ReleaseSalesGate(sqlite);
    gate.acquire({ release_id: OLD_Q2_RELEASE, mode: "ROLLING", expected: { ...expected, source_commit: Q2 } });
    gate.supersedeStrandedAgentReferralsRolling({
      release_id: OLD_Q2_RELEASE, expected_old_source_commit: Q2, replacement_source_commit: Q3,
      replacement_expected: { ...expected, source_commit: Q3 }, reason_code: "SURFACE_CONTRACT_UNAVAILABLE", incident_run_id: "34027377689",
    }, () => ({ runtime_source_commit: Q3, replacement_dormant_ready: true }));
    const terminal_release_id = `agent-referrals-q4-dormant-${Q4}`;
    gate.acquire({ release_id: terminal_release_id, mode: "ROLLING", expected });
    gate.completeRolling({ release_id: terminal_release_id, mode: "ROLLING", expected }, () => true);
    const app = modules.api.createApp(sqlite, new modules.provider.MockProvider());
    const request = {
      activation_id: `agent-referrals-activation-${Q4}`,
      terminal_release_id,
      expected_feature_revision: modules.feature.agentReferralsFeatureState(sqlite).revision,
      expected,
    };
    return { sqlite, app, request };
  }

  const activate = (app: ReturnType<typeof fresh>["app"], request: ReturnType<typeof fresh>["request"], auth = headers) =>
    app.request("http://x/v1/internal/release-control/agent-referrals/activate", { method: "POST", headers: auth, body: JSON.stringify(request) });
  const eventCount = (sqlite: ReturnType<typeof fresh>["sqlite"]) => Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get() as { n: number }).n);
  const manifestCount = (sqlite: ReturnType<typeof fresh>["sqlite"]) => Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get() as { n: number }).n);

  it("is bearer-only, starts Q4 DORMANT, and atomically records the closed manifest with the one DORMANT to ACTIVE event", async () => {
    const { sqlite, app, request } = fresh();
    try {
      expect(modules.feature.agentReferralsFeatureState(sqlite)).toMatchObject({ state: "DORMANT", owner_id: null });
      expect((await activate(app, request, { "Content-Type": "application/json" })).status).toBe(401);
      const response = await activate(app, request);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ feature_state: { state: "ACTIVE", owner_id: request.activation_id, revision: request.expected_feature_revision + 1 }, replayed: false });
      expect(eventCount(sqlite)).toBe(1);
      expect(manifestCount(sqlite)).toBe(1);
    } finally { sqlite.close(); }
  });

  it("is exactly idempotent for the same owner and refuses stale revision before an atomic mutation", async () => {
    const { sqlite, app, request } = fresh();
    try {
      expect((await activate(app, request)).status).toBe(200);
      const replay = await activate(app, request);
      expect(replay.status, await replay.text()).toBe(200);
      expect(modules.feature.agentReferralsFeatureState(sqlite)).toMatchObject({ state: "ACTIVE", owner_id: request.activation_id, revision: request.expected_feature_revision + 1 });
      expect(eventCount(sqlite)).toBe(1);

      const second = fresh();
      try {
        const response = await activate(second.app, { ...second.request, expected_feature_revision: second.request.expected_feature_revision + 1 });
        expect(response.status).toBe(409);
        expect(modules.feature.agentReferralsFeatureState(second.sqlite)).toMatchObject({ state: "DORMANT", owner_id: null, revision: second.request.expected_feature_revision });
        expect(eventCount(second.sqlite)).toBe(0);
        expect(manifestCount(second.sqlite)).toBe(0);
      } finally { second.sqlite.close(); }
    } finally { sqlite.close(); }
  });

  it.each([
    ["foreign feature owner", (sqlite: ReturnType<typeof fresh>["sqlite"]) => modules.feature.activateAgentReferrals(sqlite, { expected_revision: modules.feature.agentReferralsFeatureState(sqlite).revision, owner_id: "foreign-owner", reason: "test" })],
    ["missing schema guard", (sqlite: ReturnType<typeof fresh>["sqlite"]) => sqlite.exec("DROP TRIGGER agent_referrals_legal_profile_revisions_immutable_guard")],
    ["legacy payments unhealthy", (sqlite: ReturnType<typeof fresh>["sqlite"]) => sqlite.exec("DROP TABLE payments")],
    ["unexpected business fact", (sqlite: ReturnType<typeof fresh>["sqlite"]) => {
      const agentId = randomUUID();
      sqlite.prepare("INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value) VALUES (?, ?, ?, ?, ?, 'SELF_EMPLOYED', ?, ?, 'PERCENT', 10)")
        .run(agentId, `agent-${agentId}`, "Agent", "Agent", "agent@example.test", "123456789012", "test-contract");
      sqlite.prepare("INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run(randomUUID(), agentId, "partner@example.test", "partner-email-hash", "admin-test");
    }],
    ["manifest mismatch", (sqlite: ReturnType<typeof fresh>["sqlite"]) => sqlite.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json, recorded_at) VALUES (?, ?, datetime('now'))").run("agent-referrals-activation-v1", JSON.stringify({ wrong: true }))],
    ["wrong runtime source", () => { process.env.SOURCE_COMMIT = "a".repeat(40); }],
  ])("refuses %s with no partial feature, event, or manifest mutation", async (_name, mutate) => {
    const { sqlite, app, request } = fresh();
    try {
      mutate(sqlite);
      const response = await activate(app, request);
      expect(response.status).toBe(409);
      expect(modules.feature.agentReferralsFeatureState(sqlite)).not.toMatchObject({ state: "ACTIVE", owner_id: request.activation_id });
      expect(manifestCount(sqlite)).toBe(_name === "manifest mismatch" ? 1 : 0);
      expect(eventCount(sqlite)).toBe(_name === "foreign feature owner" ? 1 : 0);
    } finally { sqlite.close(); }
  });

  it("has no Q3 bootstrap dependency or executable activation workflow", () => {
    expect(git("show", `${Q3}:commerce/src/api.ts`)).not.toContain("/agent-referrals/activate");
    expect(git("show", `${Q3}:commerce/src/agent-referrals-feature-state.ts`)).toContain("deliberately not wired to any HTTP route");
    const controllerDiff = git("diff", "--name-only", "040d8dbdb93af5a33cb5bdd33a1215890796215d", controllerSha);
    expect(controllerDiff).not.toContain(".github/workflows/controlled-agent-referrals-activation.yml");
    expect(controllerDiff.split("\n").some((path) => path.startsWith(".github/workflows/"))).toBe(false);
  });
});
