import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoolifyClient } from "../../src/release/coolify";
import { CoolifyDeploymentDriver, CoolifyRecoveryDriver, type SurfaceApplication } from "../../src/release/coolify-deployment";
import type { ComposeRollbackEvidence } from "../../src/release/compose-rollback-evidence";
import { ProductionDeployRefStore } from "../../src/release/deploy-ref";

/**
 * A real git remote and a real HTTP server. The two failures worth catching
 * here - a pointer that did not move and a rollback image that is not there -
 * are both facts about the outside world, and a fake that agrees with the
 * driver cannot disagree with it.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const APPLICATIONS: readonly SurfaceApplication[] = [
  { surfaces: ["frontend"], uuid: "app-frontend", name: "flexperiment", deploymentKind: "dockerfile" },
  { surfaces: ["admin"], uuid: "app-admin", name: "admin-web", deploymentKind: "dockerfile" },
  // One application, two surfaces: commerce and its worker deploy together.
  { surfaces: ["commerce", "worker"], uuid: "app-commerce", name: "commerce", deploymentKind: "dockercompose" },
];

let origin: string;
let clone: string;
let preSha: string;
let targetSha: string;
let server: Server | undefined;
let retained: Record<string, string[]>;
let calls: string[];
let deploymentStatus: string;
let buildPacks: Record<string, string>;
let composeRestores: string[];
let dockerImagesToKeep: number;
let retentionDisabled: boolean;
let queue: Record<string, readonly { status: string; deployment_uuid: string }[]>;
let servers: readonly string[];
let resourcesFor: (server: string) => readonly { id: string; uuid: string; type: string }[];

const listen = async (): Promise<string> => {
  server = createServer((request, response) => {
    // The request body is consumed even when unused: an unread stream can stall
    // the exchange, and a stalled exchange looks like a hung driver.
    request.resume();
    const url = request.url ?? "";
    calls.push(`${request.method} ${url.split("?")[0]}`);
    const send = (body: unknown) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    const images = Object.entries(retained).find(([uuid]) => url.includes(uuid))?.[1] ?? [];
    if (url === "/api/v1/servers") return send(servers.map((uuid) => ({ uuid })));
    const serverMatch = url.match(/\/servers\/([^/]+)\/resources/);
    if (serverMatch) return send(resourcesFor(serverMatch[1]!));
    if (url.includes("/servers/server-1/docker-cleanup")) return send({ disable_application_image_retention: retentionDisabled });
    if (url.includes("/deployments/applications/")) {
      const uuid = url.split("/").at(-1)?.split("?")[0] ?? "";
      return send({ count: queue[uuid]?.length ?? 0, deployments: queue[uuid] ?? [] });
    }
    if (url.includes("/rollback-images")) return send({ images: images.map((tag) => ({ tag })) });
    if (url.endsWith("/rollback")) return send({ deployment_uuid: "dep-rollback" });
    if (url.includes("/applications/")) {
      const uuid = url.split("/").at(-1) ?? "";
      return send({ uuid, build_pack: buildPacks[uuid] ?? "dockerfile", settings: { docker_images_to_keep: dockerImagesToKeep } });
    }
    // Before the deploy branch: `/deployments/x` also starts with `/deploy`.
    if (url.includes("/deployments/")) return send({ status: deploymentStatus, commit: targetSha });
    if (url.startsWith("/api/v1/deploy")) return send({ deployments: [{ deployment_uuid: "dep-1" }] });
    return send({});
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;
};

beforeEach(() => {
  calls = [];
  deploymentStatus = "finished";
  origin = mkdtempSync(join(tmpdir(), "deployment-origin-"));
  clone = mkdtempSync(join(tmpdir(), "deployment-clone-"));
  git(origin, "init", "--bare", "--initial-branch=main", ".");
  git(clone, "init", "--initial-branch=main", ".");
  git(clone, "config", "user.email", "test@example.invalid");
  git(clone, "config", "user.name", "Test");
  git(clone, "remote", "add", "origin", origin);
  writeFileSync(join(clone, "a.txt"), "1\n"); git(clone, "add", "."); git(clone, "commit", "-m", "pre");
  preSha = git(clone, "rev-parse", "HEAD");
  writeFileSync(join(clone, "a.txt"), "2\n"); git(clone, "add", "."); git(clone, "commit", "-m", "target");
  targetSha = git(clone, "rev-parse", "HEAD");
  git(clone, "push", "origin", `${preSha}:refs/heads/production-deploy`);
  git(clone, "push", "origin", "main");
  retained = { "app-frontend": [preSha], "app-admin": [preSha], "app-commerce": [preSha] };
  buildPacks = { "app-commerce": "dockercompose" };
  composeRestores = [];
  dockerImagesToKeep = 2;
  retentionDisabled = false;
  queue = {};
  servers = ["server-1"];
  resourcesFor = () => APPLICATIONS.map((application, index) => ({ id: String(index + 1), uuid: application.uuid, type: "application" }));
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const drivers = async (composeRollbackEvidence?: ComposeRollbackEvidence) => {
  const client = new CoolifyClient({ apiUrl: await listen(), token: "t", pollIntervalMs: 1, sleep: async () => {} });
  const refs = new ProductionDeployRefStore({ cwd: clone });
  const options = {
    client, refs, applications: APPLICATIONS, composeRollbackEvidence,
    composeRepositories: ["repo/commerce", "repo/worker"],
    composeRestore: async (sha: string) => { composeRestores.push(sha); },
  };
  return { refs, deployment: new CoolifyDeploymentDriver(options), recovery: new CoolifyRecoveryDriver(options) };
};

describe("deploying through the pointer the applications follow", () => {
  it("moves the pointer before asking Coolify to take it", async () => {
    const { refs, deployment } = await drivers();
    await deployment.deployFrom(preSha, targetSha);

    expect(await refs.read()).toBe(targetSha);
    // Three applications, four surfaces: commerce carries its worker.
    expect(calls.filter((call) => call === "POST /api/v1/deploy")).toHaveLength(3);
  });

  it("refuses to start when a surface could not be put back", async () => {
    // Coolify's rollback needs a retained image. One that has been pruned is
    // discovered now or in the middle of a recovery, and a cutover that cannot
    // be undone must not begin.
    // A Dockerfile application, because that is the kind whose retained image
    // Coolify owns. Commerce is Compose and is proved from host evidence.
    retained["app-admin"] = [];
    const { refs, deployment } = await drivers({
      async assertPreDeployRecoverable() {},
      async assertPredecessorStillPresent() {},
      async assertRetainedArtifacts() {},
    });

    await expect(deployment.assertRecoverable(preSha)).rejects.toThrow("DEPLOYMENT_ROLLBACK_IMAGE_MISSING");
    expect(await refs.read()).toBe(preSha);
  });

  it("refuses when Coolify disagrees with the configured deployment kind", async () => {
    // Configuration decides which destructive path runs; Coolify's answer only
    // verifies it. A disagreement is a reconfigured application, not a branch.
    buildPacks["app-commerce"] = "dockerfile";
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toThrow("DEPLOYMENT_KIND_MISMATCH");
  });

  it("uses the Coolify rollback-images API for Dockerfile applications only", async () => {
    const { deployment } = await drivers({
      async assertPreDeployRecoverable() {},
      async assertPredecessorStillPresent() {},
      async assertRetainedArtifacts() {},
    });
    await deployment.assertRecoverable(preSha);
    // Two, not three: commerce is Compose and is proved from host evidence.
    expect(calls.filter((call) => call.endsWith("/rollback-images"))).toHaveLength(2);
  });

  it("proves a prepared launch from retained artifacts rather than running containers", async () => {
    // The production failure: after `prepare-bootstrap` the Compose containers
    // are stopped on purpose, so requiring them is requiring the absence of
    // what preparation just did.
    const artifacts: string[] = [];
    const { deployment } = await drivers({
      async assertPreDeployRecoverable() { throw new Error("COMPOSE_ROLLBACK_CONTAINERS_MISSING"); },
      async assertPredecessorStillPresent() {},
      async assertRetainedArtifacts(repositories, sha) { artifacts.push(`${[...repositories].join(",")}:${sha}`); },
    });
    await deployment.assertRecoverable(preSha, "PREPARED_STOPPED");
    expect(artifacts).toEqual([`repo/commerce,repo/worker:${preSha}`]);
  });

  it("uses host evidence for Compose and refuses an empty resource rollback-images list as proof", async () => {
    retained["app-commerce"] = [];
    const observed: string[] = [];
    const { deployment } = await drivers({
      async assertPreDeployRecoverable(applicationId, sha) { observed.push(`${applicationId}:${sha}`); },
      async assertPredecessorStillPresent() {},
      async assertRetainedArtifacts() {},
    });

    await deployment.assertRecoverable(preSha);

    expect(observed).toEqual([`3:${preSha}`]);
    expect(calls.filter((call) => call === "GET /api/v1/applications/app-commerce/rollback-images")).toHaveLength(0);
  });

  it("accepts one predecessor image per Compose repository when configured retention is two", async () => {
    const { deployment } = await drivers({ async assertPreDeployRecoverable() {}, async assertPredecessorStillPresent() {}, async assertRetainedArtifacts() {} });
    await expect(deployment.assertRecoverable(preSha)).resolves.toBeUndefined();
  });

  it("refuses configured retention one even if an older second tag exists", async () => {
    dockerImagesToKeep = 1;
    retained["app-commerce"] = [preSha, targetSha];
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toMatchObject({ code: "DEPLOYMENT_IMAGE_RETENTION_INSUFFICIENT" });
  });

  it("refuses when server cleanup disables application image retention", async () => {
    retentionDisabled = true;
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toMatchObject({ code: "DEPLOYMENT_APPLICATION_IMAGE_RETENTION_DISABLED" });
  });

  it("derives the server and numeric Compose resource id from the three trusted application UUIDs", async () => {
    const { deployment } = await drivers({ async assertPreDeployRecoverable() {}, async assertPredecessorStillPresent() {}, async assertRetainedArtifacts() {} });
    await expect(deployment.composeResourceId("app-commerce")).resolves.toBe("3");
  });

  it("refuses an ambiguous or incomplete server binding instead of accepting a configured server UUID", async () => {
    servers = ["server-1", "server-2"];
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toMatchObject({ code: "COOLIFY_APPLICATION_SERVER_BINDING_INVALID" });

    servers = ["server-1"];
    resourcesFor = () => APPLICATIONS.slice(0, 2).map((application, index) => ({ id: String(index + 1), uuid: application.uuid, type: "application" }));
    const incomplete = await drivers();
    await expect(incomplete.deployment.assertRecoverable(preSha)).rejects.toMatchObject({ code: "COOLIFY_APPLICATION_SERVER_BINDING_INVALID" });
  });

  it("refuses a nonnumeric Compose label id even when the server owns all three UUIDs", async () => {
    resourcesFor = () => APPLICATIONS.map((application, index) => ({ id: application.uuid === "app-commerce" ? "not-a-label" : String(index + 1), uuid: application.uuid, type: "application" }));
    const { deployment } = await drivers({ async assertPreDeployRecoverable() {}, async assertPredecessorStillPresent() {}, async assertRetainedArtifacts() {} });
    await expect(deployment.composeResourceId("app-commerce")).rejects.toMatchObject({ code: "COOLIFY_COMPOSE_RESOURCE_ID_INVALID" });
  });

  it("refuses a nonterminal deployment queue", async () => {
    queue["app-admin"] = [{ status: "queued", deployment_uuid: "other-controller" }];
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toMatchObject({ code: "DEPLOYMENT_QUEUE_ACTIVE" });
  });

  it("does not allow arming evidence when the post-target Compose predecessor disappeared", async () => {
    const { deployment } = await drivers({
      async assertPreDeployRecoverable() {},
      async assertPredecessorStillPresent() { throw Object.assign(new Error("gone"), { code: "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING" }); },
      async assertRetainedArtifacts() {},
    });
    await expect(deployment.assertPredecessorRetained(preSha)).rejects.toMatchObject({ code: "COMPOSE_ROLLBACK_PREDECESSOR_IMAGE_MISSING" });
  });

  it("does not report a failed deployment as a deploy", async () => {
    deploymentStatus = "failed";
    const { deployment } = await drivers();
    await expect(deployment.deployFrom(preSha, targetSha)).rejects.toThrow("DEPLOYMENT_FAILED");
  });

  it("will not move a pointer another controller sent somewhere else", async () => {
    writeFileSync(join(clone, "a.txt"), "3\n"); git(clone, "add", "."); git(clone, "commit", "-m", "third");
    const third = git(clone, "rev-parse", "HEAD");
    git(clone, "push", "--force", "origin", `${third}:refs/heads/production-deploy`);

    const { refs, deployment } = await drivers();
    await expect(deployment.deployFrom(preSha, targetSha)).rejects.toThrow("DEPLOY_REF_LEASE_REFUSED");
    expect(await refs.read()).toBe(third);
    expect(calls.filter((call) => call === "POST /api/v1/deploy")).toHaveLength(0);
  });

  it("treats a pointer another controller already sent to the target as moved", async () => {
    // Git reports a push to where the ref already points as up to date, so the
    // lease is never tested. That is the right outcome rather than a quirk:
    // the pointer names what this controller wanted it to name, and the deploy
    // that follows is the reconciling one.
    git(clone, "push", "--force", "origin", `${targetSha}:refs/heads/production-deploy`);
    const { refs, deployment } = await drivers();

    await deployment.deployFrom(preSha, targetSha);
    expect(await refs.read()).toBe(targetSha);
  });
});

describe("putting production back", () => {
  it("returns the pointer before restoring the images", async () => {
    // A runtime on the old commits with the ref still naming the new one is
    // not a production that was left alone: the next ordinary deploy would
    // undo the recovery without anyone asking it to.
    const { refs, recovery } = await drivers();
    await refs.compareAndSet(preSha, targetSha);

    await recovery.restorePreDeployTopology({ runtime: { frontend: preSha, admin: preSha, commerce: preSha, worker: preSha }, controlPlane: { productionDeployRefSha: preSha } });

    expect(await refs.read()).toBe(preSha);
    // Two, not three. Commerce is a Compose application: Coolify does not own
    // its images, so it is restored from its captured units instead.
    expect(calls.filter((call) => call.endsWith("/rollback"))).toHaveLength(2);
    expect(composeRestores).toEqual([preSha]);
  });

  it("refuses rather than rebuilding when the retained image is gone", async () => {
    // A rebuild is a new artifact. Recovery restores the one that was running,
    // so this stops and leaves the session in recovery with sales shut.
    retained["app-admin"] = [];
    const { refs, recovery } = await drivers();
    await refs.compareAndSet(preSha, targetSha);

    await expect(recovery.restorePreDeployTopology({ runtime: { frontend: preSha, admin: preSha, commerce: preSha, worker: preSha }, controlPlane: { productionDeployRefSha: preSha } }))
      .rejects.toThrow("RECOVERY_ROLLBACK_IMAGE_MISSING");
  });

  it("refuses a snapshot this control plane cannot restore", async () => {
    // All three applications track one ref, so a vector naming two commits is
    // not a state they can be returned to.
    const { recovery } = await drivers();
    await expect(recovery.restorePreDeployTopology({ runtime: { frontend: preSha, admin: targetSha, commerce: preSha, worker: preSha }, controlPlane: { productionDeployRefSha: preSha } }))
      .rejects.toThrow("RECOVERY_TOPOLOGY_NOT_UNIFORM");
  });

  it("does not report a failed rollback as a recovery", async () => {
    deploymentStatus = "failed";
    const { refs, recovery } = await drivers();
    await refs.compareAndSet(preSha, targetSha);
    await expect(recovery.restorePreDeployTopology({ runtime: { frontend: preSha, admin: preSha, commerce: preSha, worker: preSha }, controlPlane: { productionDeployRefSha: preSha } }))
      .rejects.toThrow("RECOVERY_ROLLBACK_FAILED");
  });
});
