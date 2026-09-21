import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalEnvelopeSha256 } from "../../src/release/cutover-envelope";
import { bootstrapRollbackId } from "../../src/release/bootstrap-rollback";
import { buildProductionRelease } from "../../src/release/production-runner";
import type { ProductionReleaseConfig } from "../../src/release/production-config";
import { classifySchemaLineage } from "../../src/release/schema-identity";
import { readSchemaIdentity } from "../../src/db";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const now = new Date("2026-09-21T00:00:00.000Z");

describe("cross-lineage rollback through the production composition root", () => {
  it("shares one lease authority, archives launch DB, restores legacy, rolls back three apps, observes, then opens gate", async () => {
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
    writeFileSync(join(worktree, "tracked"), "predecessor\n");
    git(worktree, "add", "."); git(worktree, "commit", "-m", "predecessor");
    const predecessor = git(worktree, "rev-parse", "HEAD");
    git(worktree, "push", "origin", "HEAD:refs/heads/production-deploy");
    writeFileSync(join(worktree, "tracked"), "target\n");
    git(worktree, "commit", "-am", "target");
    const target = git(worktree, "rev-parse", "HEAD");
    git(worktree, "push", "origin", "HEAD:refs/heads/main");

    const databasePath = join(replacement, "commerce.sqlite");
    const legacy = new Database(databasePath);
    legacy.pragma("journal_mode = WAL");
    legacy.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
      INSERT INTO schema_migrations VALUES ('legacy');
      CREATE TABLE emergency_sales_gate (singleton INTEGER PRIMARY KEY, sales_paused INTEGER NOT NULL, revision INTEGER NOT NULL);
      INSERT INTO emergency_sales_gate VALUES (1, 0, 1);
      CREATE TABLE runtime_release_evidence (unit TEXT PRIMARY KEY, source_commit TEXT NOT NULL, started_at TEXT NOT NULL, observed_at TEXT NOT NULL, last_successful_sweep_at TEXT);
      INSERT INTO runtime_release_evidence VALUES ('COMMERCE', '${predecessor}', '${now.toISOString()}', '${now.toISOString()}', NULL);
      INSERT INTO runtime_release_evidence VALUES ('WORKER', '${predecessor}', '${now.toISOString()}', '${now.toISOString()}', '${now.toISOString()}');`);
    legacy.close();

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

    const resourceResponse = () => new Response(JSON.stringify([
      { id: "1", uuid: "app-frontend", type: "application" },
      { id: "2", uuid: "app-admin", type: "application" },
      { id: "3", uuid: "app-commerce", type: "application" },
    ]));
    const forwardFetch = async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/servers")) return new Response(JSON.stringify([{ uuid: "server-1" }]));
      if (url.includes("/servers/server-1/resources")) return resourceResponse();
      if (url.endsWith("/readyz")) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({ source_commit: predecessor }), { status: 200 });
    };
    const noHandles = { async assertNoOpenHandles() {} };
    const forward = buildProductionRelease(config, {
      now: () => now, fetch: forwardFetch as typeof globalThis.fetch,
      runtimeControl: {
        async capture(_binding, expectedSha) {
          return [
            { id: "1".repeat(64), service: "commerce", image: `repo/commerce:${expectedSha}`, running: true },
            { id: "2".repeat(64), service: "commerce-worker", image: `repo/worker:${expectedSha}`, running: true },
          ];
        },
        async stopAndReprove() {}, async assertStopped() {}, async startCaptured() {},
      },
      openHandles: noHandles,
    });
    const prepared = await forward.bootstrapPreparation!.prepare({ targetSha: target, expiresAt: "2026-09-21T06:00:00.000Z", cutoverId: "cutover-1" });
    forward.envelopes.markConsumed(prepared.envelope.cutoverId);
    forward.close();

    git(worktree, "push", "origin", "HEAD:refs/heads/production-deploy");
    const surface: Record<"frontend" | "admin" | "commerce", string> = { frontend: target, admin: target, commerce: target };
    const coolifyRollbacks: string[] = [];
    const rollbackFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/servers")) return new Response(JSON.stringify([{ uuid: "server-1" }]));
      if (url.includes("/servers/server-1/resources")) return resourceResponse();
      if (url.includes("/rollback-images")) return new Response(JSON.stringify([{ tag: `retained:${predecessor}` }]));
      const rollback = url.match(/\/applications\/app-(frontend|admin|commerce)\/rollback$/);
      if (method === "POST" && rollback) {
        const name = rollback[1] as keyof typeof surface;
        coolifyRollbacks.push(name);
        surface[name] = predecessor;
        return new Response(JSON.stringify({ deployment_uuid: `rollback-${name}` }));
      }
      if (url.includes("/deployments/rollback-")) return new Response(JSON.stringify({ status: "finished" }));
      if (url.endsWith("/readyz")) return new Response("{}", { status: surface.commerce === predecessor ? 200 : 503 });
      if (url.includes("frontend.invalid")) return new Response(JSON.stringify({ source_commit: surface.frontend }));
      if (url.includes("admin.invalid")) return new Response(JSON.stringify({ source_commit: surface.admin }));
      throw new Error(`UNEXPECTED_HTTP_CALL: ${method} ${url}`);
    };
    const runtimeEvents: string[] = [];
    const release = buildProductionRelease(config, {
      now: () => now, fetch: rollbackFetch as typeof globalThis.fetch,
      runtimeControl: {
        async capture(_binding, expectedSha) {
          runtimeEvents.push("capture");
          return [
            { id: "3".repeat(64), service: "commerce", image: `repo/commerce:${expectedSha}`, running: true },
            { id: "4".repeat(64), service: "commerce-worker", image: `repo/worker:${expectedSha}`, running: true },
          ];
        },
        async stopAndReprove() { runtimeEvents.push("stop"); },
        async assertStopped() { runtimeEvents.push("reprove"); },
        async startCaptured() { throw new Error("rollback must start through Coolify"); },
      },
      openHandles: { async assertNoOpenHandles() { runtimeEvents.push("handles"); } },
    });
    try {
      const session = release.sessions.acquireFenced({
        id: "successor-session", ownerId: "owner", mode: "MAINTENANCE_CUTOVER", targetSha: target,
        adoptedCutoverId: prepared.envelope.cutoverId,
        adoptedEnvelopeSha256: canonicalEnvelopeSha256(prepared.envelope),
        predecessorDatabaseRef: prepared.envelope.predecessorDatabase.ref,
        predecessorDatabaseSha256: prepared.envelope.predecessorDatabase.sha256,
      }, prepared.envelope.preDeployTopology);
      release.sessions.beginDeploying(session.id, "owner");
      const receipt = await release.bootstrapRollback!.rollback(session.id, "owner");
      expect(receipt.stage).toBe("COMPLETED");
      expect(receipt.successorDatabase?.ref).toBe(join(archive, `${bootstrapRollbackId(session.id)}.successor.sqlite`));
      expect(coolifyRollbacks).toEqual(["frontend", "admin", "commerce"]);
      expect(await release.deployRef.read()).toBe(predecessor);
      expect(existsSync(receipt.intent.predecessorDatabase.ref)).toBe(true);
      expect(runtimeEvents).toEqual(["capture", "stop", "handles", "reprove", "handles"]);

      const restored = new Database(databasePath, { readonly: true });
      try {
        expect(classifySchemaLineage(readSchemaIdentity(restored))).toBe("LEGACY");
        expect((restored.prepare("SELECT sales_paused FROM emergency_sales_gate WHERE singleton = 1").get() as { sales_paused: number }).sales_paused).toBe(0);
      } finally { restored.close(); }
    } finally { release.close(); }
  });
});
