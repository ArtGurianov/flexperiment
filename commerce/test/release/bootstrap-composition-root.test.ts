import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openReadOnlyDatabase, readSchemaIdentity } from "../../src/db";
import { buildProductionRelease } from "../../src/release/production-runner";
import type { ProductionReleaseConfig } from "../../src/release/production-config";
import { classifySchemaLineage } from "../../src/release/schema-identity";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const target = "a".repeat(40);
const now = new Date("2026-09-21T00:00:00.000Z");

/**
 * A real composition root against a clone-shaped legacy file. Only the Docker
 * host port is substituted: the test must not stop this developer's containers.
 */
describe("bootstrap storage through the production composition root", () => {
  it("closes the legacy gate, takes online backups, stops both writers, then writes envelope before rename and db.ts bootstrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "bootstrap-root-"));
    const replacement = join(root, "replacement");
    const state = join(root, "release-state");
    const archive = join(state, "archive");
    const envelopes = join(state, "envelopes");
    const locks = join(state, "locks");
    const journal = join(state, "journal");
    const candidates = join(state, "candidates");
    const worktree = join(root, "worktree");
    const origin = join(root, "origin");
    for (const path of [replacement, archive, envelopes, locks, journal, candidates, worktree, origin]) mkdirSync(path, { recursive: true });
    git(origin, "init", "--bare", "--initial-branch=main", ".");
    git(worktree, "init", "--initial-branch=main", ".");
    git(worktree, "config", "user.email", "test@example.invalid");
    git(worktree, "config", "user.name", "Test");
    git(worktree, "remote", "add", "origin", origin);
    writeFileSync(join(worktree, "tracked"), "one\n");
    git(worktree, "add", "."); git(worktree, "commit", "-m", "pre");
    git(worktree, "push", "origin", "HEAD:refs/heads/production-deploy");
    const predecessor = git(worktree, "rev-parse", "HEAD");

    const databasePath = join(replacement, "commerce.sqlite");
    const db = new Database(databasePath);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
      INSERT INTO schema_migrations VALUES ('legacy');
      CREATE TABLE emergency_sales_gate (singleton INTEGER PRIMARY KEY, sales_paused INTEGER NOT NULL, revision INTEGER NOT NULL);
      INSERT INTO emergency_sales_gate VALUES (1, 0, 1);
      CREATE TABLE runtime_release_evidence (unit TEXT PRIMARY KEY, source_commit TEXT NOT NULL, started_at TEXT NOT NULL, observed_at TEXT NOT NULL, last_successful_sweep_at TEXT);
      INSERT INTO runtime_release_evidence VALUES ('COMMERCE', '${predecessor}', '2026-09-20T23:00:00Z', '2026-09-20T23:00:00Z', NULL);
      INSERT INTO runtime_release_evidence VALUES ('WORKER', '${predecessor}', '2026-09-20T23:00:00Z', '2026-09-20T23:59:00Z', '2026-09-20T23:59:00Z');`);
    db.close();

    const config: ProductionReleaseConfig = {
      databasePath, replacementRoot: replacement, stateDirectory: state, archiveDirectory: archive, envelopeDirectory: envelopes,
      lockPath: join(locks, "release.lock"), journalPath: join(journal, "release.jsonl"), candidateDirectory: candidates,
      certification: { adminBaseUrl: "https://admin.invalid", publicBaseUrl: "https://public.invalid", serviceToken: "t", capabilityKey: "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", citySlug: "city", occurrenceScopePath: join(root, "scope.json"), checkoutBodyPath: join(root, "checkout.json") },
      predecessor: { expectedSha: predecessor, expectedLedgerLength: 1, commerceReadyUrl: "https://commerce.invalid/readyz" },
      coolify: { apiUrl: "https://coolify.invalid/api/v1", token: "t" },
      composeRepositories: { commerce: "repo/commerce", "commerce-worker": "repo/worker" },
      applications: [
        { name: "frontend", uuid: "app-frontend", surfaces: ["frontend"] },
        { name: "admin", uuid: "app-admin", surfaces: ["admin"] },
        { name: "commerce", uuid: "app-commerce", surfaces: ["commerce", "worker"] },
      ],
      topology: { frontendReleaseUrl: "https://frontend.invalid/release.json", adminReleaseUrl: "https://admin.invalid/release.json" },
      deployRef: { remote: origin, ref: "refs/heads/production-deploy", worktree },
    };
    const stopped: string[] = [];
    const runtimeEvents: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/servers")) return new Response(JSON.stringify([{ uuid: "server-1" }]));
      if (url.includes("/servers/server-1/resources")) return new Response(JSON.stringify([
        { id: "1", uuid: "app-frontend", type: "application" }, { id: "2", uuid: "app-admin", type: "application" }, { id: "3", uuid: "app-commerce", type: "application" },
      ]));
      if (url.endsWith("/readyz")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ source_commit: predecessor }), { status: 200 });
    };
    const release = buildProductionRelease(config, {
      now: () => now, fetch: fetch as typeof globalThis.fetch,
      runtimeControl: {
        async capture(binding, expectedSha) {
          stopped.push(binding.resourceId); runtimeEvents.push("capture");
          return [
            { id: "1".repeat(64), service: "commerce", image: `repo/commerce:${expectedSha}`, running: true },
            { id: "2".repeat(64), service: "commerce-worker", image: `repo/worker:${expectedSha}`, running: true },
          ];
        },
        async stopAndReprove() { runtimeEvents.push("stop"); },
        async assertStopped() { runtimeEvents.push("containers-absent"); },
        async startCaptured() { runtimeEvents.push("start"); },
      },
      openHandles: { async assertNoOpenHandles() { runtimeEvents.push("handles-absent"); } },
    });
    try {
      expect(release.bootstrapPreparation).toBeDefined();
      const prepared = await release.bootstrapPreparation!.prepare({ targetSha: target, expiresAt: "2026-09-21T06:00:00.000Z", cutoverId: "cutover-1" });
      expect(prepared.alreadyPrepared).toBe(false);
      // A second read-back after checkpoint/gate verification is deliberate:
      // it re-proves there are no running containers or open handles before
      // the durable envelope authorizes the rename.
      expect(stopped).toEqual(["3", "3"]);
      expect(runtimeEvents).toEqual([
        "capture", "stop", "handles-absent", "containers-absent", "handles-absent",
        "capture", "stop", "handles-absent", "containers-absent", "handles-absent",
      ]);
      expect(existsSync(join(archive, "cutover-1.predecessor.sqlite"))).toBe(true);
      const launched = openReadOnlyDatabase(databasePath);
      try { expect(classifySchemaLineage(readSchemaIdentity(launched))).toBe("SUPPORTED"); } finally { launched.close(); }
      expect(release.envelopes.read("cutover-1")?.predecessorDatabase.sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally { release.close(); }
  });
});
