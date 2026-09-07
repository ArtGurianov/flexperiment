import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

const Q4 = "e0cf268496660dade2db3fa43b189682d059c25c";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-activation-${Q4}/certificate.json`;
const ACTIVATION_ID = `agent-referrals-activation-${Q4}`;
const TERMINAL_RELEASE_ID = `agent-referrals-q4-dormant-${Q4}`;
process.env.COMMERCE_RELEASE_CONTROL_TOKEN ??= "release-control-test-token";
const MANIFEST = {
  version: "agent-referrals-activation-v1",
  activation_id: ACTIVATION_ID,
  terminal_release_id: TERMINAL_RELEASE_ID,
  source_commit: Q4,
  migration: "inventory-sha256:test",
  legal_version: "q4-terminal",
  legal_manifest_sha256: "a".repeat(64),
  otp_pepper_sha256: "b".repeat(64),
  otp_delivery_provider: "unisender-go",
};

const git = (...args: string[]) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};

describe("Q5 activation reconciliation capability", () => {
  let root: string;
  let modules: {
    db: typeof import("../src/db");
    api: { createApp: typeof import("../src/api").createApp };
    provider: typeof import("../src/provider");
  };

  beforeAll(async () => {
    const certificate = JSON.parse(readFileSync(CERTIFICATE_PATH, "utf8")) as ControlledCandidateCertificate;
    root = mkdtempSync(join(tmpdir(), "q5-activation-reconciliation-"));
    const q5 = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: git("rev-parse", "HEAD") });
    const added = spawnSync("git", ["worktree", "add", "--detach", root, q5], { encoding: "utf8" });
    if (added.status !== 0) throw new Error(added.stderr);
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    modules = {
      db: await import(join(root, "commerce/src/db.ts")),
      api: await import(join(root, "commerce/src/api.ts")),
      provider: await import(join(root, "commerce/src/provider.ts")),
    };
  }, 60_000);

  afterAll(() => {
    spawnSync("git", ["worktree", "remove", "--force", root]);
    rmSync(root, { recursive: true, force: true });
  });

  const fresh = () => {
    const sqlite = modules.db.openDatabase(":memory:");
    modules.db.migrate(sqlite, join(root, "commerce/migrations"));
    return { sqlite, app: modules.api.createApp(sqlite, new modules.provider.MockProvider()) };
  };
  const snapshot = (app: ReturnType<typeof fresh>["app"], headers: Record<string, string> = {}) =>
    app.request("http://x/v1/internal/release-control/agent-referrals/activation-state", { headers });
  const counts = (sqlite: ReturnType<typeof fresh>["sqlite"]) => ({
    events: Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_feature_state_events").get() as { n: number }).n),
    manifests: Number((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_referrals_activation_manifest").get() as { n: number }).n),
  });

  afterEach(() => { /* each test closes its own in-memory database */ });

  it("reconstructs the exact Q5 child and exposes only a bearer-gated, no-store, parameterless read snapshot", async () => {
    const certificate = JSON.parse(readFileSync(CERTIFICATE_PATH, "utf8")) as ControlledCandidateCertificate;
    const q5 = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: git("rev-parse", "HEAD") });
    expect(git("rev-parse", `${q5}^`)).toBe(Q4);
    expect(git("diff", "--name-only", Q4, q5).split("\n").sort()).toEqual([
      "commerce/src/agent-referrals-activation-reconciliation.ts",
      "commerce/src/api.ts",
    ]);

    const { sqlite, app } = fresh();
    try {
      expect((await snapshot(app)).status).toBe(401);
      const before = counts(sqlite);
      const response = await snapshot(app, { Authorization: "Bearer release-control-test-token" });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({
        feature_state: { state: "DORMANT", owner_id: null, revision: 1 },
        last_feature_state_event: null,
        activation_manifest: null,
      });
      expect(counts(sqlite)).toEqual(before);
    } finally { sqlite.close(); }
  });

  it("returns the exact sealed Q4 activation evidence and latest event without creating any state", async () => {
    const { sqlite, app } = fresh();
    try {
      const event = {
        id: randomUUID(), from_state: "DORMANT", to_state: "ACTIVE", owner_id: ACTIVATION_ID,
        reason: "AGENT_REFERRALS_ACTIVATION_V1", revision: 1, created_at: "2026-09-07 00:00:00.000",
      };
      sqlite.prepare("UPDATE agent_referrals_feature_state SET state = ?, owner_id = ?, revision = ? WHERE singleton = 1")
        .run("ACTIVE", ACTIVATION_ID, 1);
      sqlite.prepare("INSERT INTO agent_referrals_feature_state_events(id, from_state, to_state, owner_id, reason, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(event.id, event.from_state, event.to_state, event.owner_id, event.reason, event.revision, event.created_at);
      sqlite.prepare("INSERT INTO agent_referrals_activation_manifest(key, value_json, recorded_at) VALUES (?, ?, datetime('now'))")
        .run("agent-referrals-activation-v1", JSON.stringify(MANIFEST));
      const before = counts(sqlite);

      const response = await snapshot(app, { Authorization: "Bearer release-control-test-token" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        feature_state: { state: "ACTIVE", owner_id: ACTIVATION_ID, revision: 1 },
        last_feature_state_event: event,
        activation_manifest: MANIFEST,
      });
      expect(counts(sqlite)).toEqual(before);
    } finally { sqlite.close(); }
  });

  it("reads feature state, immutable event, and the closed manifest inside one deferred SQLite snapshot", () => {
    const source = readFileSync(join(root, "commerce/src/agent-referrals-activation-reconciliation.ts"), "utf8");
    expect(source).toContain("db.transaction(() => ({");
    expect(source).toContain("feature_state: agentReferralsFeatureState(db)");
    expect(source).toContain("last_feature_state_event: exactEvent(lastAgentReferralsFeatureStateEvent(db))");
    expect(source).toContain("activation_manifest: exactManifest(agentReferralsActivationEvidence(db, AGENT_REFERRALS_ACTIVATION_MANIFEST_KEY))");
    expect(source).toContain("})).deferred()");
    expect(source).not.toContain(".run(");
    expect(source).not.toContain(".exec(");
  });
});
