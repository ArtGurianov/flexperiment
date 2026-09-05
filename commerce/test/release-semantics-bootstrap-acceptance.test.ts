import { randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

/**
 * P1 #3(a): the real acceptance contract for the release-semantics
 * bootstrap, proven against the ACTUAL reconstructed runtimes rather than by
 * static inspection of the certificate/patches. Materializes both P and B2
 * as real detached git worktrees (each with the current worktree's own
 * node_modules symlinked in - Node's module resolution walks up parent
 * directories, so this makes every shared dependency, including native
 * modules like better-sqlite3, resolve exactly as it does for the rest of
 * this test suite) and dynamically imports each one's own api.ts/db.ts,
 * proving the wire-level behavior directly through real HTTP requests
 * against a real in-memory database - never by grepping source text.
 *
 * B2 is never assumed to already exist as a git object: unlike P (a real
 * historical commit reachable once production-deploy is fetched), B2 only
 * ever existed as a detached, unpublished commit built once in one
 * developer's local object database - a fresh CI checkout has no such
 * object. This suite reconstructs it itself, the same way any real
 * controller would, from the committed certificate.
 */

const P_SHA = "24a382929740a7ead6fb0bb49f5ffc77e063c77a";
const B2_SHA = "f540b997d6d31a22293909ded7ce464c3f51732f";
const CERTIFICATE_PATH = `.release/controlled-candidates/release-semantics-bootstrap-${P_SHA}/certificate.json`;

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_RELEASE_CONTROL_TOKEN ??= "release-control-test-token";

const releaseControlHeaders = { Authorization: "Bearer release-control-test-token", "Content-Type": "application/json" };

function gitRev(...args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Reconstructs B2 into THIS repository's own object database (a plain
 * `git commit-tree` write, exactly like reconstructControlledCandidateSha
 * always does) so a subsequent `git worktree add <B2 sha>` has a real object
 * to check out - never relying on it already being present.
 */
function ensureB2Reconstructed(): string {
  const controllerSha = gitRev("rev-parse", "HEAD");
  const certificate = JSON.parse(readFileSync(resolve(CERTIFICATE_PATH), "utf8")) as ControlledCandidateCertificate;
  const reconstructed = reconstructControlledCandidateSha(certificate, { trusted_patch_source_sha: controllerSha });
  if (reconstructed !== B2_SHA) throw new Error(`reconstructed B2 (${reconstructed}) does not match the pinned B2_SHA (${B2_SHA})`);
  return reconstructed;
}

function materializeWorktree(sha: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bootstrap-acceptance-${sha.slice(0, 8)}-`));
  const result = spawnSync("git", ["worktree", "add", "--detach", dir, sha], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git worktree add ${sha} failed: ${result.stderr}`);
  // Node module resolution walks up from the importing file's directory
  // looking for node_modules at every level - this symlink is enough for
  // every shared dependency (hono, zod, better-sqlite3, ...) to resolve
  // exactly as it does for the rest of this suite, with no separate install.
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"));
  return dir;
}

function removeWorktree(dir: string | undefined) {
  if (!dir) return;
  spawnSync("git", ["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
}

async function loadRuntime(dir: string) {
  const dbModule = await import(join(dir, "commerce/src/db.ts")) as typeof import("../src/db");
  const providerModule = await import(join(dir, "commerce/src/provider.ts")) as typeof import("../src/provider");
  const apiModule = await import(join(dir, "commerce/src/api.ts")) as typeof import("../src/api");
  const sqlite = dbModule.openDatabase(":memory:");
  dbModule.migrate(sqlite, join(dir, "commerce", "migrations"));
  const app = apiModule.createApp(sqlite, new providerModule.MockProvider());
  return { sqlite, app };
}

const expected = () => ({
  source_commit: "a".repeat(40),
  migration: "0033_runtime_release_evidence.sql",
  legal_version: "2026-08-25.1",
  legal_manifest_sha256: "b".repeat(64),
  legal_hashes: { PUBLIC_OFFER: "c".repeat(64), PRIVACY_POLICY: "d".repeat(64), PD_CONSENT: "e".repeat(64), CHECKOUT_DISCLOSURE: "f".repeat(64) },
});

describe("release-semantics bootstrap: real wire-level acceptance contract", () => {
  let pDir: string | undefined;
  let b2Dir: string | undefined;

  beforeAll(() => {
    pDir = materializeWorktree(P_SHA);
    ensureB2Reconstructed();
    b2Dir = materializeWorktree(B2_SHA);
  }, 60_000);

  afterAll(() => {
    removeWorktree(pDir);
    removeWorktree(b2Dir);
  });

  it("P rejects mode=ROLLING at the wire boundary, before any domain logic runs", async () => {
    const { sqlite, app } = await loadRuntime(pDir!);
    try {
      const releaseId = randomUUID();
      const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", {
        method: "POST",
        headers: releaseControlHeaders,
        body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: { code: "VALIDATION_ERROR" } });
      // Refused before any state was written - never a partial acquire.
      const status = await app.request("http://api.flexperiment.ru/v1/internal/release-control/status", { headers: releaseControlHeaders });
      expect((await status.json() as { owner_release_id: string | null }).owner_release_id).toBeNull();
    } finally { sqlite.close(); }
  }, 30_000);

  it("B2 accepts mode=ROLLING, sets owner_mode=ROLLING, and leaves sales_paused=false", async () => {
    const { sqlite, app } = await loadRuntime(b2Dir!);
    try {
      const releaseId = randomUUID();
      const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", {
        method: "POST",
        headers: releaseControlHeaders,
        body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { owner_release_id: string; owner_mode: string; sales_paused: boolean };
      expect(body.owner_release_id).toBe(releaseId);
      expect(body.owner_mode).toBe("ROLLING");
      expect(body.sales_paused).toBe(false);
      const status = await app.request("http://api.flexperiment.ru/v1/internal/release-control/status", { headers: releaseControlHeaders });
      expect((await status.json() as { sales_paused: boolean }).sales_paused).toBe(false);
    } finally { sqlite.close(); }
  }, 30_000);

  it("B2's ordinary CONTROLLED_CUTOVER acquire behavior is unchanged from P's", async () => {
    const { sqlite, app } = await loadRuntime(b2Dir!);
    try {
      const releaseId = randomUUID();
      const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", {
        method: "POST",
        headers: releaseControlHeaders,
        body: JSON.stringify({ release_id: releaseId, mode: "CONTROLLED_CUTOVER", expected: expected() }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as { owner_mode: string };
      expect(body.owner_mode).toBe("CONTROLLED_CUTOVER");
    } finally { sqlite.close(); }
  }, 30_000);

  it("B2 exposes no /complete-rolling route - the bootstrap grants acquisition only, never completion", async () => {
    const { sqlite, app } = await loadRuntime(b2Dir!);
    try {
      const releaseId = randomUUID();
      await app.request("http://api.flexperiment.ru/v1/internal/release-control/acquire", {
        method: "POST",
        headers: releaseControlHeaders,
        body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }),
      });
      const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", {
        method: "POST",
        headers: releaseControlHeaders,
        body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected: expected() }),
      });
      expect(response.status).toBe(404);
    } finally { sqlite.close(); }
  }, 30_000);

  it("P also exposes no /complete-rolling route - confirms the route is genuinely new capability, not something B2 accidentally removed", async () => {
    const { sqlite, app } = await loadRuntime(pDir!);
    try {
      const response = await app.request("http://api.flexperiment.ru/v1/internal/release-control/complete-rolling", {
        method: "POST",
        headers: releaseControlHeaders,
        body: JSON.stringify({ release_id: randomUUID(), mode: "ROLLING", expected: expected() }),
      });
      expect(response.status).toBe(404);
    } finally { sqlite.close(); }
  }, 30_000);
});
