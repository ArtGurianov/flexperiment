import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../../src/db";
import type { ProductionReleaseConfig } from "../../src/release/production-config";

/**
 * A whole VPS-shaped environment: a real git remote, a real SQLite file, a
 * real HTTP server for Coolify and two more for the descriptor surfaces.
 *
 * The point of running the composition root against these rather than against
 * injected doubles is that the root's job is wiring. A test that handed it
 * pre-built ports would prove the orchestrator works, which is already proved,
 * and would say nothing about whether the root can build the ports at all.
 */

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export type Harness = {
  readonly config: ProductionReleaseConfig;
  readonly db: Database.Database;
  readonly preSha: string;
  readonly targetSha: string;
  readonly calls: string[];
  /** What each descriptor surface currently answers with. */
  readonly serving: Record<"frontend" | "admin", string>;
  setDeploymentStatus(status: string): void;
  setRetained(uuid: string, tags: readonly string[]): void;
  close(): Promise<void>;
};

const APPLICATIONS = [
  { name: "frontend", uuid: "app-frontend", surfaces: ["frontend"] as const },
  { name: "admin", uuid: "app-admin", surfaces: ["admin"] as const },
  { name: "commerce", uuid: "app-commerce", surfaces: ["commerce", "worker"] as const },
];

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
};

export const harness = async (root: string): Promise<Harness> => {
  const origin = join(root, "origin");
  const worktree = join(root, "worktree");
  for (const path of [origin, worktree]) mkdirSync(path, { recursive: true });
  git(origin, "init", "--bare", "--initial-branch=main", ".");
  git(worktree, "init", "--initial-branch=main", ".");
  git(worktree, "config", "user.email", "test@example.invalid");
  git(worktree, "config", "user.name", "Test");
  git(worktree, "remote", "add", "origin", origin);
  const commit = (message: string) => {
    writeFileSync(join(worktree, "file.txt"), message);
    git(worktree, "add", "file.txt");
    git(worktree, "commit", "-m", message);
    return git(worktree, "rev-parse", "HEAD");
  };
  const preSha = commit("pre");
  const targetSha = commit("target");
  git(worktree, "push", "origin", "main");
  git(worktree, "push", "origin", `${preSha}:refs/heads/production-deploy`);

  const databasePath = join(root, "commerce.sqlite");
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  migrate(db);

  const calls: string[] = [];
  const serving: Record<"frontend" | "admin", string> = { frontend: preSha, admin: preSha };
  const retained: Record<string, readonly string[]> = Object.fromEntries(
    APPLICATIONS.map((application) => [application.uuid, [preSha, targetSha]]),
  );
  let deploymentStatus = "finished";
  const pinned: Record<string, string | null> = Object.fromEntries(APPLICATIONS.map((a) => [a.uuid, null]));

  const coolifyServer = createServer((request, response) => {
    request.resume();
    const url = request.url ?? "";
    calls.push(`${request.method} ${url.split("?")[0]}`);
    const send = (body: unknown) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const uuid = APPLICATIONS.map((a) => a.uuid).find((candidate) => url.includes(candidate));
    if (url.includes("/rollback-images")) return send({ images: (retained[uuid ?? ""] ?? []).map((tag) => ({ tag })) });
    if (url.endsWith("/rollback")) return send({ deployment_uuid: "dep-rollback" });
    // Checked before the deploy branch: `/deployments/x` also starts with `/deploy`.
    if (url.includes("/deployments/")) return send({ status: deploymentStatus, commit: targetSha });
    if (url.includes("/deploy")) return send({ deployments: [{ deployment_uuid: "dep-1" }] });
    if (request.method === "PATCH") return send({ uuid, git_commit_sha: pinned[uuid ?? ""] });
    return send({ uuid, name: uuid, build_pack: "dockercompose", git_branch: "production-deploy", git_commit_sha: pinned[uuid ?? ""] });
  });
  const descriptorServer = createServer((request, response) => {
    request.resume();
    const surface = (request.url ?? "").includes("admin") ? "admin" : "frontend";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ source_commit: serving[surface] }));
  });

  const coolifyUrl = await listen(coolifyServer);
  const descriptorUrl = await listen(descriptorServer);

  return {
    db, preSha, targetSha, calls, serving,
    setDeploymentStatus(status) { deploymentStatus = status; },
    setRetained(uuid, tags) { retained[uuid] = tags; },
    config: {
      databasePath,
      archiveDirectory: join(root, "archive"),
      envelopeDirectory: join(root, "cutover"),
      lockPath: join(root, "locks", "release.lock"),
      journalPath: join(root, "journal", "release.jsonl"),
      coolify: { apiUrl: `${coolifyUrl}/api/v1`, token: "test-token" },
      applications: APPLICATIONS.map((application) => ({ ...application, surfaces: [...application.surfaces] })),
      topology: {
        frontendReleaseUrl: `${descriptorUrl}/release.json`,
        adminReleaseUrl: `${descriptorUrl}/admin/release.json`,
      },
      deployRef: { remote: origin, ref: "refs/heads/production-deploy", worktree },
    },
    async close() {
      db.close();
      for (const server of [coolifyServer, descriptorServer]) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
};

/** Records a live instance of a unit, which is how the two non-HTTP surfaces answer. */
export const recordInstance = (
  db: Database.Database, unit: "COMMERCE" | "WORKER", id: string, commit: string, now: Date, sweep: string | null = null,
) => db.prepare(`INSERT INTO runtime_instance_evidence(instance_id, unit, source_commit, started_at, heartbeat_at, last_successful_sweep_at)
  VALUES (?, ?, ?, ?, ?, ?)`).run(id, unit, commit, new Date(now.getTime() - 60_000).toISOString(), now.toISOString(), sweep);
