import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoolifyClient } from "../../src/release/coolify";
import { CoolifyDeploymentDriver, CoolifyRecoveryDriver, type SurfaceApplication } from "../../src/release/coolify-deployment";
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
let calls: string[];
let deploymentStatus: string;
let buildPacks: Record<string, string>;
let queue: Record<string, readonly { status: string; deployment_uuid: string }[]>;

const listen = async (): Promise<string> => {
  server = createServer((request, response) => {
    // The request body is consumed even when unused: an unread stream can stall
    // the exchange, and a stalled exchange looks like a hung driver.
    request.resume();
    const url = request.url ?? "";
    calls.push(`${request.method} ${url.split("?")[0]}`);
    const send = (body: unknown) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (url.includes("/deployments/applications/")) {
      const uuid = url.split("/").at(-1)?.split("?")[0] ?? "";
      return send({ count: queue[uuid]?.length ?? 0, deployments: queue[uuid] ?? [] });
    }
    if (url.includes("/applications/")) {
      const uuid = url.split("/").at(-1) ?? "";
      return send({ uuid, build_pack: buildPacks[uuid] ?? "dockerfile" });
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
  buildPacks = { "app-commerce": "dockercompose" };
  queue = {};
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const drivers = async () => {
  const client = new CoolifyClient({ apiUrl: await listen(), token: "t", pollIntervalMs: 1, sleep: async () => {} });
  const refs = new ProductionDeployRefStore({ cwd: clone });
  const options = { client, refs, applications: APPLICATIONS };
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


  it("refuses when Coolify disagrees with the configured deployment kind", async () => {
    // Configuration decides which destructive path runs; Coolify's answer only
    // verifies it. A disagreement is a reconfigured application, not a branch.
    buildPacks["app-commerce"] = "dockerfile";
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toThrow("DEPLOYMENT_KIND_MISMATCH");
  });







  it("refuses a nonterminal deployment queue", async () => {
    queue["app-admin"] = [{ status: "queued", deployment_uuid: "other-controller" }];
    const { deployment } = await drivers();
    await expect(deployment.assertRecoverable(preSha)).rejects.toMatchObject({ code: "DEPLOYMENT_QUEUE_ACTIVE" });
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
    // One mechanism for all three: recovery deploys the predecessor commit the
    // pointer now names, rather than resurrecting a retained artifact.
    expect(calls.filter((call) => call.startsWith("POST /api/v1/deploy"))).toHaveLength(3);
    expect(calls.filter((call) => call.endsWith("/rollback"))).toHaveLength(0);
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
