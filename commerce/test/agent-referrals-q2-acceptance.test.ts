import { randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

/**
 * Q2's real wire-level acceptance contract, materialized as a detached git
 * worktree and exercised through real HTTP requests - same technique as
 * commerce/test/release-semantics-bootstrap-acceptance.test.ts. Proves the
 * ROLLING capability B2 already made reachable is genuinely inherited (not
 * re-declared), and that Q2's own ordinary CONTROLLED_CUTOVER path - the
 * path every other production release still uses - is unregressed by any of
 * Q2's own additions.
 *
 * Q2 is never assumed to already exist as a git object: it only ever
 * existed as a detached, unpublished commit built once in one developer's
 * local object database - a fresh CI checkout has none. This suite
 * reconstructs it itself from the committed certificate before
 * materializing its worktree, the same fix
 * commerce/test/release-semantics-bootstrap-acceptance.test.ts already
 * needed for the exact same reason.
 */
const B2_SHA = "f540b997d6d31a22293909ded7ce464c3f51732f";
const Q2_SHA = "2dc1a55a070a7e9e9ebcd52f46dff8d171da223e";
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

function ensureQ2Reconstructed(): string {
  const controllerSha = gitRev("rev-parse", "HEAD");
  const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;
  const reconstructed = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha });
  if (reconstructed !== Q2_SHA) throw new Error(`reconstructed Q2 (${reconstructed}) does not match the pinned Q2_SHA (${Q2_SHA})`);
  return reconstructed;
}

function materializeWorktree(sha: string): string {
  const dir = mkdtempSync(join(tmpdir(), `q2-acceptance-${sha.slice(0, 8)}-`));
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

describe("Agent Referrals Q2: real wire-level acceptance contract", () => {
  let q2Dir: string;
  let dbModule: typeof import("../src/db");
  let providerModule: typeof import("../src/provider");
  let apiModule: typeof import("../src/api");
  let originalCwd: string;

  beforeAll(async () => {
    ensureQ2Reconstructed();
    q2Dir = materializeWorktree(Q2_SHA);
    process.env.SOURCE_COMMIT = Q2_SHA;
    dbModule = await import(join(q2Dir, "commerce/src/db.ts"));
    providerModule = await import(join(q2Dir, "commerce/src/provider.ts"));
    apiModule = await import(join(q2Dir, "commerce/src/api.ts"));
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

  it("inherits B2's ROLLING wire acceptance - not re-declared, the same schema file", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const response = await app.request("http://x/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { owner_mode: string; sales_paused: boolean };
      expect(body.owner_mode).toBe("ROLLING");
      expect(body.sales_paused).toBe(false);
    } finally { sqlite.close(); }
  }, 30_000);

  it("ordinary CONTROLLED_CUTOVER acquire/pause remains unregressed by Q2's own additions", async () => {
    // reopen()'s own gate (evaluateReopenGate) independently requires exact
    // runtime source-commit/legal-hash/worker-sweep evidence matching the
    // request's `expected` object - a strict, pre-existing mechanism
    // unrelated to and untouched by Q2, already covered by this repo's own
    // existing test suites. This test's scope is narrower and Q2-specific:
    // proving Q2's additions (completeRolling, dormant-readiness) do not
    // regress the ordinary acquire/pause half of that same unrelated path.
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const acquire = await app.request("http://x/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "CONTROLLED_CUTOVER", expected: expected() }) });
      expect(acquire.status).toBe(200);
      const body = await acquire.json() as { owner_mode: string };
      expect(body.owner_mode).toBe("CONTROLLED_CUTOVER");
      const pause = await app.request("http://x/v1/internal/release-control/pause", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "CONTROLLED_CUTOVER", expected: expected() }) });
      expect(pause.status).toBe(200);
      expect((await pause.json() as { sales_paused: boolean }).sales_paused).toBe(true);
    } finally { sqlite.close(); }
  }, 30_000);

  it("Q2's own product routes are reachable (partner login endpoint exists, is not a 404)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const response = await app.request("http://x/v1/partner/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      expect(response.status).not.toBe(404);
    } finally { sqlite.close(); }
  }, 30_000);

  it("no Agent Referrals activation on a fresh deploy - feature state is DORMANT, never ACTIVE", async () => {
    // Round-9 fix: the route now requires a completeRollingSchema-shaped
    // POST body (release_id/mode/expected) - a bare GET is refused. This
    // test only asserts feature_state, so a schema-valid but otherwise
    // fabricated `expected` is enough; it never expects `.ready == true`.
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const response = await app.request("http://x/v1/internal/release-control/agent-referrals/dormant-readiness", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }) });
      expect(response.status).toBe(200);
      const body = await response.json() as { feature_state: string };
      expect(body.feature_state).toBe("DORMANT");
    } finally { sqlite.close(); }
  }, 30_000);
});
