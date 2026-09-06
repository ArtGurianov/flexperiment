import { randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

/**
 * Round-8 P1.3 fix, negative matrix: every axis
 * commerce/src/agent-referrals-dormant-readiness.ts now checks must
 * independently block /complete-rolling - not merely be present in the
 * evidence object. Materializes the real reconstructed Q2 commit as a
 * detached git worktree (same technique as
 * commerce/test/release-semantics-bootstrap-acceptance.test.ts) and drives
 * its actual api.ts/db.ts/release-control.ts through real HTTP requests
 * against a real in-memory database - never by calling the predicate
 * function directly with hand-built fixtures, which would only prove the
 * function's own logic and not that api.ts actually wires it in.
 *
 * `process.chdir()` into the materialized worktree is required for the
 * duration of each request: releaseRuntimeEvidence() and
 * readSurfaceContract() both resolve paths from `process.cwd()`
 * (commerce/legal/production-manifest.json, release-surface-contract.json),
 * exactly like production does relative to its own deploy root.
 */
const B2_SHA = "f540b997d6d31a22293909ded7ce464c3f51732f";
const Q2_SHA = "a264ee68f597e7a40b6fe4b05359d99365be9149";
const CERTIFICATE_PATH = `.release/controlled-candidates/agent-referrals-${B2_SHA}/certificate.json`;

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_RELEASE_CONTROL_TOKEN ??= "release-control-test-token";

const releaseControlHeaders = { Authorization: "Bearer release-control-test-token", "Content-Type": "application/json" };

function gitRev(...args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// Q2 is never assumed to already exist as a git object - see
// commerce/test/agent-referrals-q2-acceptance.test.ts for why.
function ensureQ2Reconstructed(): string {
  const controllerSha = gitRev("rev-parse", "HEAD");
  const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;
  const reconstructed = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha });
  if (reconstructed !== Q2_SHA) throw new Error(`reconstructed Q2 (${reconstructed}) does not match the pinned Q2_SHA (${Q2_SHA})`);
  return reconstructed;
}

function materializeWorktree(sha: string): string {
  const dir = mkdtempSync(join(tmpdir(), `q2-dormant-matrix-${sha.slice(0, 8)}-`));
  const result = spawnSync("git", ["worktree", "add", "--detach", dir, sha], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git worktree add ${sha} failed: ${result.stderr}`);
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  return dir;
}

function removeWorktree(dir: string | undefined) {
  if (!dir) return;
  spawnSync("git", ["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
}

const expected = () => ({
  source_commit: "a".repeat(40),
  migration: "0033_runtime_release_evidence.sql",
  legal_version: "2026-08-25.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
});

describe("Q2 DORMANT completion: negative matrix (each axis independently blocks completion)", () => {
  let q2Dir: string;
  let dbModule: typeof import("../src/db");
  let providerModule: typeof import("../src/provider");
  let apiModule: typeof import("../src/api");
  let runtimeEvidenceModule: typeof import("../src/runtime-release-evidence");
  let originalCwd: string;

  beforeAll(async () => {
    ensureQ2Reconstructed();
    q2Dir = materializeWorktree(Q2_SHA);
    process.env.SOURCE_COMMIT = Q2_SHA;
    dbModule = await import(join(q2Dir, "commerce/src/db.ts"));
    providerModule = await import(join(q2Dir, "commerce/src/provider.ts"));
    apiModule = await import(join(q2Dir, "commerce/src/api.ts"));
    runtimeEvidenceModule = await import(join(q2Dir, "commerce/src/runtime-release-evidence.ts"));
  }, 60_000);

  afterAll(() => {
    delete process.env.SOURCE_COMMIT;
    removeWorktree(q2Dir);
  });

  beforeEach(() => { originalCwd = process.cwd(); process.chdir(q2Dir); });
  afterEach(() => { process.chdir(originalCwd); });

  function freshApp() {
    const sqlite = dbModule.openDatabase(":memory:");
    dbModule.migrate(sqlite, join(q2Dir, "commerce", "migrations"));
    const app = apiModule.createApp(sqlite, new providerModule.MockProvider());
    return { sqlite, app };
  }

  async function acquireRolling(app: ReturnType<typeof freshApp>["app"], releaseId: string) {
    const response = await app.request("http://x/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
    expect(response.status).toBe(200);
  }

  async function completeRolling(app: ReturnType<typeof freshApp>["app"], releaseId: string) {
    return app.request("http://x/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
  }

  function seedMatchingWorkerEvidence(sqlite: ReturnType<typeof dbModule.openDatabase>) {
    runtimeEvidenceModule.recordRuntimeStartupEvidence(sqlite, "WORKER", Q2_SHA);
    runtimeEvidenceModule.recordSuccessfulWorkerSweep(sqlite, Q2_SHA);
  }

  it("baseline: all axes healthy -> completion succeeds (proves the matrix below is testing real gates, not an already-broken baseline)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      seedMatchingWorkerEvidence(sqlite);
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(200);
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on runtime/worker source mismatch (no worker evidence at all)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      // Deliberately no seedMatchingWorkerEvidence() call.
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on worker source commit mismatch (worker reports a different commit)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      runtimeEvidenceModule.recordRuntimeStartupEvidence(sqlite, "WORKER", "9".repeat(40));
      runtimeEvidenceModule.recordSuccessfulWorkerSweep(sqlite, "9".repeat(40));
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on migration inventory incomplete (a required migration row missing)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare("DELETE FROM schema_migrations WHERE version = ?").run("0049_agent_referrals_integration_hardening.sql");
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on surface contract unavailable", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      seedMatchingWorkerEvidence(sqlite);
      const emptyDir = mkdtempSync(join(tmpdir(), "q2-no-surface-contract-"));
      process.chdir(emptyDir);
      try {
        const response = await completeRolling(app, releaseId);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
      } finally {
        process.chdir(q2Dir);
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks when feature_state != DORMANT", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare("UPDATE agent_referrals_feature_state SET state = 'SUSPENDED' WHERE singleton = 1").run();
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
    } finally { sqlite.close(); }
  }, 30_000);

  it.each([
    ["partner_identities", { id: randomUUID(), display_name: "test", status: "ACTIVE" }],
  ])("blocks when a business-fact record exists in %s (zero-count category violated)", async (table) => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      seedMatchingWorkerEvidence(sqlite);
      const columns = (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>);
      const requiredColumns = columns.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
      // Insert the minimal row this schema will actually accept - only
      // NOT NULL columns with no default, filled with an innocuous string.
      // This is a probe for the zero-count check, not a real business
      // record: it never survives past this single test's in-memory db.
      const columnNames = requiredColumns.map((c) => c.name);
      const placeholders = columnNames.map(() => "?").join(", ");
      // Foreign keys off for this one synthetic insert only: the probe row
      // has no real parent records (there are none - the whole point is an
      // empty database) and is never meant to be referentially valid, only
      // to exist long enough for the zero-count check to see it.
      sqlite.pragma("foreign_keys = OFF");
      if (columnNames.length > 0) {
        sqlite.prepare(`INSERT INTO "${table}" (${columnNames.map((n) => `"${n}"`).join(", ")}) VALUES (${placeholders})`).run(...columnNames.map(() => "probe-value"));
      } else {
        sqlite.prepare(`INSERT INTO "${table}" DEFAULT VALUES`).run();
      }
      sqlite.pragma("foreign_keys = ON");
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks when legacy flows are unhealthy (a core pre-existing table is missing)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      await acquireRolling(app, releaseId);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare("DROP TABLE refunds").run();
      const response = await completeRolling(app, releaseId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
    } finally { sqlite.close(); }
  }, 30_000);
});
