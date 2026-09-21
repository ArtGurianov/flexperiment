import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CoolifyClient, CoolifyError } from "../../src/release/coolify";

/**
 * A real HTTP server, not a stubbed `fetch`. The client's job is to be right
 * about an HTTP API, and a fake that answers in objects cannot be wrong about
 * status codes, empty bodies or malformed JSON - which is where this kind of
 * client actually fails.
 */

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);

type Handler = (method: string, path: string, body: string) => { status: number; body: string };

let server: Server | undefined;
const listen = async (handler: Handler): Promise<string> => {
  server = createServer((request, response) => {
    let payload = "";
    request.on("data", (chunk) => { payload += String(chunk); });
    request.on("end", () => {
      const { status, body } = handler(request.method ?? "", request.url ?? "", payload);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server!.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;
};
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const client = (apiUrl: string, over: Partial<ConstructorParameters<typeof CoolifyClient>[0]> = {}) =>
  new CoolifyClient({ apiUrl, token: "probe-token", pollIntervalMs: 1, sleep: async () => {}, ...over });

describe("the Coolify client", () => {
  it("reads an application", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({ uuid: "app-1", name: "commerce", build_pack: "dockercompose", git_branch: "production-deploy", git_commit_sha: null, settings: { docker_images_to_keep: 2 } }) }));
    expect(await client(url).application("app-1")).toEqual({
      uuid: "app-1", name: "commerce", buildPack: "dockercompose", gitBranch: "production-deploy", gitCommitSha: null, dockerImagesToKeep: 2,
    });
  });

  it("reads server retention and rejects a malformed cleanup policy", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({ disable_application_image_retention: false }) }));
    await expect(client(url).serverDockerCleanup("server-1")).resolves.toEqual({ applicationImageRetentionDisabled: false });
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const malformed = await listen(() => ({ status: 200, body: JSON.stringify({}) }));
    await expect(client(malformed).serverDockerCleanup("server-1")).rejects.toMatchObject({ code: "COOLIFY_SERVER_CLEANUP_MALFORMED" });
  });

  it("returns only terminally-unsettled deployments as an active queue", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({
      count: 3,
      deployments: [
        { status: "finished", deployment_uuid: "done" },
        { status: "queued", deployment_uuid: "queued" },
        { status: "in_progress", deployment_uuid: "running" },
      ],
    }) }));
    await expect(client(url).activeDeploymentQueue("app-1")).resolves.toEqual(["queued", "running"]);
  });

  it("refuses a pin the API accepted but did not store", async () => {
    // The failure this read-back exists for: a 200 that changed nothing leaves
    // the next deploy taking whatever the branch points at, silently.
    const url = await listen((method) => method === "PATCH"
      ? { status: 200, body: "{}" }
      : { status: 200, body: JSON.stringify({ uuid: "app-1", git_commit_sha: "HEAD" }) });
    await expect(client(url).pinCommit("app-1", COMMIT)).rejects.toThrow("COOLIFY_COMMIT_PIN_NOT_STORED");
  });

  it("accepts a pin the API stored", async () => {
    let stored: string | null = "HEAD";
    const url = await listen((method, _path, body) => {
      if (method === "PATCH") { stored = (JSON.parse(body) as { git_commit_sha: string }).git_commit_sha; return { status: 200, body: "{}" }; }
      return { status: 200, body: JSON.stringify({ uuid: "app-1", git_commit_sha: stored }) };
    });
    expect((await client(url).pinCommit("app-1", COMMIT)).gitCommitSha).toBe(COMMIT);
  });

  it("follows a deployment to a terminal state rather than trusting the POST", async () => {
    // Acceptance is not convergence: the POST returns long before anything is
    // serving, and treating it as proof is the defect this whole path avoids.
    let polls = 0;
    const url = await listen((method, path) => {
      if (method === "POST" && path.startsWith("/api/v1/deploy")) return { status: 200, body: JSON.stringify({ deployments: [{ deployment_uuid: "dep-1" }] }) };
      polls += 1;
      return { status: 200, body: JSON.stringify({ deployment_uuid: "dep-1", status: polls < 3 ? "in_progress" : "finished", commit: COMMIT }) };
    });
    const coolify = client(url);
    const deployment = await coolify.awaitDeployment(await coolify.startDeployment("app-1"));
    expect(deployment).toEqual({ uuid: "dep-1", status: "finished", commit: COMMIT });
    expect(polls).toBe(3);
  });

  it("reports a failed deployment as failed and a slow one as a timeout", async () => {
    // They are different facts. A deployment still running when we stopped
    // watching may yet succeed, and recording it as failed would invite a
    // caller to act as though production had not moved.
    const failing = await listen(() => ({ status: 200, body: JSON.stringify({ status: "failed", commit: COMMIT }) }));
    expect((await client(failing).awaitDeployment("dep-1")).status).toBe("failed");
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    let clock = 0;
    const slow = await listen(() => ({ status: 200, body: JSON.stringify({ status: "in_progress" }) }));
    await expect(client(slow, { clock: () => (clock += 60_000), deploymentTimeoutMs: 120_000 }).awaitDeployment("dep-1"))
      .rejects.toThrow("COOLIFY_DEPLOYMENT_TIMED_OUT");
  });

  it("does not mistake a deployment of the wrong commit for success", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({ status: "finished", commit: OTHER }) }));
    // The client reports what happened; the caller compares. What matters here
    // is that the commit actually travels, rather than being assumed.
    expect((await client(url).awaitDeployment("dep-1")).commit).toBe(OTHER);
  });

  it("lists the images a rollback could still restore", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({ images: [{ tag: COMMIT }, { tag: OTHER }] }) }));
    expect(await client(url).rollbackImages("app-1")).toEqual([COMMIT, OTHER]);

    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const empty = await listen(() => ({ status: 200, body: JSON.stringify({ images: [] }) }));
    // Empty is the answer that stops a cutover, so it must be reportable.
    expect(await client(empty).rollbackImages("app-1")).toEqual([]);
  });

  it("names the path but never the token when a request fails", async () => {
    const url = await listen(() => ({ status: 403, body: "" }));
    const error = await client(url).application("app-1").catch((caught: CoolifyError) => caught);
    expect(String(error)).toContain("/applications/app-1");
    expect(String(error)).not.toContain("probe-token");
  });

  it("refuses a malformed response rather than reading absent fields as null", async () => {
    const url = await listen(() => ({ status: 200, body: "<html>gateway</html>" }));
    await expect(client(url).application("app-1")).rejects.toThrow("COOLIFY_RESPONSE_MALFORMED");
  });

  it("refuses a deploy the API did not queue", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({ message: "accepted" }) }));
    await expect(client(url).startDeployment("app-1")).rejects.toThrow("COOLIFY_DEPLOYMENT_NOT_QUEUED");
  });

  it("will not be built without somewhere to talk to", () => {
    expect(() => new CoolifyClient({ apiUrl: "", token: "t" })).toThrow("COOLIFY_API_URL_MISSING");
    expect(() => new CoolifyClient({ apiUrl: "https://x", token: " " })).toThrow("COOLIFY_TOKEN_MISSING");
  });
});
