import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrate } from "../../src/db";
import type { ProductionReleaseConfig } from "../../src/release/production-config";
import { TEST_CAPABILITY_KEY } from "./certification-secret";

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
  /** Makes Coolify report a different kind than configuration states. */
  setBuildPack(uuid: string, buildPack: string): void;
  /** What the control plane says the commerce application is doing. */
  applicationStatus(): string;
  setApplicationStatus(value: string): void;
  /** Runs when Coolify is asked to deploy: what production looks like once it has. */
  onDeploy(effect: (() => void) | undefined): void;
  close(): Promise<void>;
};

/**
 * The shapes production actually has. Commerce is a Docker Compose application
 * of two services; the other two are Dockerfile applications.
 *
 * This used to answer `dockerfile` for all three, which put every Compose
 * branch - and they are the destructive ones - outside this harness's reach.
 * Two production-only defects came through that gap, so the kind is modelled
 * here and the Coolify stub below reports it.
 */
const APPLICATIONS = [
  { name: "frontend", uuid: "app-frontend", surfaces: ["frontend"] as const, buildPack: "dockerfile" },
  { name: "admin", uuid: "app-admin", surfaces: ["admin"] as const, buildPack: "dockerfile" },
  { name: "commerce", uuid: "app-commerce", surfaces: ["commerce", "worker"] as const, buildPack: "dockercompose" },
];

export const COMPOSE_REPOSITORIES = ["repo/commerce", "repo/worker"] as const;

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { server.off("error", onError); server.off("listening", onListening); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
};

export const harness = async (root: string): Promise<Harness> => {
  const origin = join(root, "origin");
  const worktree = join(root, "worktree");
  const volume = join(root, "commerce-volume");
  const stateDirectory = join(root, "release-state");
  const lockDirectory = join(stateDirectory, "locks");
  const journalDirectory = join(stateDirectory, "journal");
  const candidateDirectory = join(stateDirectory, "candidates");
  for (const path of [origin, worktree, volume, lockDirectory, journalDirectory, candidateDirectory]) mkdirSync(path, { recursive: true });
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

  // The operator's own files, which the certification driver reads rather than
  // accepting over a network.
  writeFileSync(join(root, "certification-occurrence.json"), JSON.stringify({
    starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T12:00:00.000Z",
    venue_disclosure_text: "Venue announced later", venue_announce_by: "2026-09-25T00:00:00.000Z",
  }));
  writeFileSync(join(root, "certification-checkout.json"), JSON.stringify({ customer_email: "certification@example.invalid" }));

  const databasePath = join(volume, "commerce.sqlite");
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  migrate(db);

  const calls: string[] = [];
  const serving: Record<"frontend" | "admin", string> = { frontend: preSha, admin: preSha };
  const retained: Record<string, readonly string[]> = Object.fromEntries(
    APPLICATIONS.map((application) => [application.uuid, [preSha, targetSha]]),
  );
  let deploymentStatus = "finished";
  // The only runtime state the runner is now allowed to care about, and it
  // comes from the control plane rather than from a container listing.
  let applicationStatus = "running:healthy";
  let deployEffect: (() => void) | undefined;
  // Overridable so a test can make Coolify disagree with configuration.
  const buildPacks: Record<string, string> = Object.fromEntries(APPLICATIONS.map((a) => [a.uuid, a.buildPack]));
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
    if (url === "/api/v1/servers") return send([{ uuid: "server-1" }]);
    if (url.includes("/servers/server-1/resources")) return send(APPLICATIONS.map((application, index) => ({ id: String(index + 1), uuid: application.uuid, type: "application" })));
    if (url.includes("/servers/server-1/docker-cleanup")) return send({ disable_application_image_retention: false });
    if (url.includes("/deployments/applications/")) return send({ count: 0, deployments: [] });
    if (url.includes("/rollback-images")) return send({ images: (retained[uuid ?? ""] ?? []).map((tag) => ({ tag })) });
    if (url.endsWith("/rollback")) return send({ deployment_uuid: "dep-rollback" });
    // Checked before the deploy branch: `/deployments/x` also starts with `/deploy`.
    if (url.includes("/deployments/")) return send({ status: deploymentStatus, commit: targetSha });
    if (url.endsWith("/stop")) { applicationStatus = "exited:unhealthy"; return send({ message: "stopped" }); }
    if (url.includes("/deploy")) { applicationStatus = "running:healthy"; deployEffect?.(); return send({ deployments: [{ deployment_uuid: "dep-1" }] }); }
    if (request.method === "PATCH") return send({ uuid, git_commit_sha: pinned[uuid ?? ""] });
    const application = APPLICATIONS.find((entry) => entry.uuid === uuid);
    return send({
      uuid, name: uuid,
      build_pack: buildPacks[uuid ?? ""] ?? application?.buildPack ?? "dockerfile",
      status: applicationStatus,
      git_branch: "production-deploy", git_commit_sha: pinned[uuid ?? ""],
      settings: { docker_images_to_keep: 2 },
    });
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
    setBuildPack(uuid, buildPack) { buildPacks[uuid] = buildPack; },
    applicationStatus: () => applicationStatus,
    setApplicationStatus(value: string) { applicationStatus = value; },
    onDeploy(effect) { deployEffect = effect; },
    config: {
      databasePath,
      lockPath: join(lockDirectory, "release.lock"),
      journalPath: join(journalDirectory, "release.jsonl"),
      candidateDirectory,
      certification: {
        adminBaseUrl: `${coolifyUrl}`, publicBaseUrl: `${coolifyUrl}`,
        serviceToken: "certification-token", capabilityKey: TEST_CAPABILITY_KEY,
        citySlug: "test-city",
        occurrenceScopePath: join(root, "certification-occurrence.json"),
        checkoutBodyPath: join(root, "certification-checkout.json"),
      },
      coolify: { apiUrl: `${coolifyUrl}/api/v1`, token: "test-token" },
      composeRepositories: { commerce: COMPOSE_REPOSITORIES[0], "commerce-worker": COMPOSE_REPOSITORIES[1] },
      applications: APPLICATIONS.map((application) => ({
        name: application.name, uuid: application.uuid,
        deploymentKind: application.buildPack as "dockerfile" | "dockercompose",
        surfaces: [...application.surfaces],
      })),
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
