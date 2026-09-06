import { createHash, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconstructControlledCandidateSha, type ControlledCandidateCertificate } from "../src/controlled-candidate";

/**
 * Round-9 P1.2/P2.1 fix, negative matrix: every axis
 * commerce/src/agent-referrals-dormant-readiness.ts now checks must
 * independently block /complete-rolling, against the FULL frozen
 * completion contract (pinned `expected`, not merely runtime-vs-worker
 * self-consistency). Materializes the real reconstructed Q2 commit as a
 * detached git worktree (same technique as
 * commerce/test/release-semantics-bootstrap-acceptance.test.ts) and drives
 * its actual api.ts/db.ts/release-control.ts through real HTTP requests
 * against a real in-memory database - never by calling the predicate
 * function directly with hand-built fixtures, which would only prove the
 * function's own logic and not that api.ts actually wires it in.
 *
 * A real, matching legal release and the real, exact migration-inventory
 * expectation (via release-expectation.ts's own `migrationInventoryExpectation`
 * - never reimplemented) are seeded for the baseline, so "all axes healthy"
 * genuinely reaches 200 and every negative test below is proven against a
 * real passing baseline, not an already-failing one.
 *
 * `process.chdir()` into the materialized worktree is required for the
 * duration of each request: releaseRuntimeEvidence() and
 * readSurfaceContract() both resolve paths from `process.cwd()`.
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

const LEGAL_CURRENT_PATHS: Record<string, string> = {
  PUBLIC_OFFER: "public/legal/public-offer.md",
  PRIVACY_POLICY: "public/legal/privacy-policy.md",
  PD_CONSENT: "public/legal/personal-data-consent.md",
  CHECKOUT_DISCLOSURE: "public/legal/disclaimer.md",
};

/** Real on-disk file hashes, from the materialized worktree's own legal copies - never fabricated - so current_legal_copies_match genuinely passes. */
function realLegalHashes(q2Dir: string): Record<string, string> {
  return Object.fromEntries(Object.entries(LEGAL_CURRENT_PATHS).map(([id, path]) => [id, createHash("sha256").update(readFileSync(join(q2Dir, path))).digest("hex")]));
}

const canonicalLegalManifestJson = (hashes: Record<string, string>, version: string) => JSON.stringify({
  documents: Object.fromEntries(Object.keys(LEGAL_CURRENT_PATHS).map((id) => [id, {
    document_id: id, version, sha256: hashes[id],
    current_url: `https://flexperiment.ru/legal/${id.toLowerCase()}.md`,
    archive_url: `https://flexperiment.ru/legal/archive/${id.toLowerCase()}/${version}/${id.toLowerCase()}.md`,
    checkout_relevant: true,
  }])),
});

describe("Q2 DORMANT completion: negative matrix (each axis independently blocks completion)", () => {
  let q2Dir: string;
  let dbModule: typeof import("../src/db");
  let providerModule: typeof import("../src/provider");
  let apiModule: typeof import("../src/api");
  let runtimeEvidenceModule: typeof import("../src/runtime-release-evidence");
  let releaseExpectationModule: typeof import("../src/release-expectation");
  let originalCwd: string;
  let legalHashes: Record<string, string>;
  let legalManifestSha256: string;

  beforeAll(async () => {
    ensureQ2Reconstructed();
    q2Dir = materializeWorktree(Q2_SHA);
    process.env.SOURCE_COMMIT = Q2_SHA;
    dbModule = await import(join(q2Dir, "commerce/src/db.ts"));
    providerModule = await import(join(q2Dir, "commerce/src/provider.ts"));
    apiModule = await import(join(q2Dir, "commerce/src/api.ts"));
    runtimeEvidenceModule = await import(join(q2Dir, "commerce/src/runtime-release-evidence.ts"));
    releaseExpectationModule = await import(join(q2Dir, "commerce/src/release-expectation.ts"));
    legalHashes = realLegalHashes(q2Dir);
    legalManifestSha256 = createHash("sha256").update(canonicalLegalManifestJson(legalHashes, "test-1")).digest("hex");
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
    sqlite.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, 'test-1', datetime('now'), ?, 1)")
      .run(randomUUID(), canonicalLegalManifestJson(legalHashes, "test-1"));
    const app = apiModule.createApp(sqlite, new providerModule.MockProvider());
    return { sqlite, app };
  }

  /** The real, exact migration-inventory expectation, via release-expectation.ts's own single-source-of-truth function - never reimplemented here. */
  function realMigrationExpectation(sqlite: ReturnType<typeof dbModule.openDatabase>): string {
    const versions = (sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: string }>).map((r) => r.version);
    return releaseExpectationModule.migrationInventoryExpectation(versions);
  }

  function realExpected(sqlite: ReturnType<typeof dbModule.openDatabase>, overrides: Partial<{ source_commit: string; migration: string; legal_version: string; legal_manifest_sha256: string; legal_hashes: Record<string, string> }> = {}) {
    return {
      source_commit: Q2_SHA,
      migration: realMigrationExpectation(sqlite),
      legal_version: "test-1",
      legal_manifest_sha256: legalManifestSha256,
      legal_hashes: legalHashes,
      ...overrides,
    };
  }

  async function acquireRolling(app: ReturnType<typeof freshApp>["app"], releaseId: string, expected: ReturnType<typeof realExpected>) {
    const response = await app.request("http://x/v1/internal/release-control/acquire", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected }) });
    expect(response.status).toBe(200);
  }

  async function completeRolling(app: ReturnType<typeof freshApp>["app"], releaseId: string, expected: ReturnType<typeof realExpected>) {
    return app.request("http://x/v1/internal/release-control/complete-rolling", { method: "POST", headers: releaseControlHeaders, body: JSON.stringify({ release_id: releaseId, mode: "ROLLING", expected }) });
  }

  function seedMatchingWorkerEvidence(sqlite: ReturnType<typeof dbModule.openDatabase>, sourceCommit = Q2_SHA) {
    runtimeEvidenceModule.recordRuntimeStartupEvidence(sqlite, "WORKER", sourceCommit);
    runtimeEvidenceModule.recordSuccessfulWorkerSweep(sqlite, sourceCommit);
  }

  const expectRefused = async (response: Response) => {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "RELEASE_CONTROL_DORMANT_NOT_READY" } });
  };

  it("baseline: all axes healthy, against the REAL pinned expectation -> completion succeeds", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      const response = await completeRolling(app, releaseId, expected);
      expect(response.status).toBe(200);
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on runtime/worker source mismatch (no worker evidence at all)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks when worker source commit disagrees with runtime source commit", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite, "9".repeat(40));
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks when runtime AND worker agree with each other but both disagree with the pinned expected.source_commit - the exact fabrication the frozen contract must reject", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const fabricated = "a".repeat(40);
      const expected = realExpected(sqlite, { source_commit: fabricated });
      await acquireRolling(app, releaseId, expected);
      // Real Q2 process + real Q2 worker - genuinely self-consistent - but
      // neither equals the fabricated pinned expectation.
      seedMatchingWorkerEvidence(sqlite, Q2_SHA);
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on migration inventory incomplete (a required migration row missing)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare("DELETE FROM schema_migrations WHERE version = ?").run("0049_agent_referrals_integration_hardening.sql");
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on an extra, unexpected migration present (inventory no longer matches the pinned expectation exactly)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare("INSERT INTO schema_migrations(version) VALUES ('0050_unexpected.sql')").run();
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on surface contract unavailable", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      const emptyDir = mkdtempSync(join(tmpdir(), "q2-no-surface-contract-"));
      process.chdir(emptyDir);
      try {
        await expectRefused(await completeRolling(app, releaseId, expected));
      } finally {
        process.chdir(q2Dir);
        rmSync(emptyDir, { recursive: true, force: true });
      }
    } finally { sqlite.close(); }
  }, 30_000);

  it.each([
    ["checkout_contract_version", "wrong-checkout-v1"],
    ["admin_contract_version", "wrong-admin-v1"],
  ])("blocks on wrong %s (required exact value, not merely non-empty)", async (field, wrongValue) => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      const wrongContractDir = mkdtempSync(join(tmpdir(), "q2-wrong-surface-contract-"));
      const real = JSON.parse(readFileSync(join(q2Dir, "release-surface-contract.json"), "utf8")) as Record<string, string>;
      writeFileSync(join(wrongContractDir, "release-surface-contract.json"), JSON.stringify({ ...real, [field]: wrongValue }));
      process.chdir(wrongContractDir);
      try {
        await expectRefused(await completeRolling(app, releaseId, expected));
      } finally {
        process.chdir(q2Dir);
        rmSync(wrongContractDir, { recursive: true, force: true });
      }
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks on legal expectation drift (pinned legal_version differs from the durably active release)", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite, { legal_version: "drifted-version" });
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it("blocks when feature_state != DORMANT", async () => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare("UPDATE agent_referrals_feature_state SET state = 'SUSPENDED' WHERE singleton = 1").run();
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  const insertProbeRow = (sqlite: ReturnType<typeof dbModule.openDatabase>, table: string) => {
    const columns = (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>);
    const requiredColumns = columns.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0).map((c) => c.name);
    sqlite.pragma("foreign_keys = OFF");
    if (requiredColumns.length > 0) {
      sqlite.prepare(`INSERT INTO "${table}" (${requiredColumns.map((n) => `"${n}"`).join(", ")}) VALUES (${requiredColumns.map(() => "?").join(", ")})`).run(...requiredColumns.map(() => "probe-value"));
    } else {
      sqlite.prepare(`INSERT INTO "${table}" DEFAULT VALUES`).run();
    }
    sqlite.pragma("foreign_keys = ON");
  };

  it.each([
    ["partner onboarding", "partner_identities"],
    ["engagement", "engagements"],
    ["creative", "engagement_creative_authorizations"],
    ["distribution", "engagement_distributions"],
    ["ORD/ERID operation", "ord_provider_operations"],
    ["payout", "payout_profile_revisions"],
  ])("blocks when a business-fact record exists: %s (%s)", async (_label, table) => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      insertProbeRow(sqlite, table);
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);

  it.each([
    ["sales", "orders"],
    ["payment", "payments"],
    ["refund", "refunds"],
  ])("blocks when %s is independently unhealthy (its own core table missing)", async (_label, table) => {
    const { sqlite, app } = freshApp();
    try {
      const releaseId = randomUUID();
      const expected = realExpected(sqlite);
      await acquireRolling(app, releaseId, expected);
      seedMatchingWorkerEvidence(sqlite);
      sqlite.prepare(`DROP TABLE "${table}"`).run();
      await expectRefused(await completeRolling(app, releaseId, expected));
    } finally { sqlite.close(); }
  }, 30_000);
});
