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
const listen = async (handler: Handler, port = 0): Promise<string> => {
  server = createServer((request, response) => {
    let payload = "";
    request.on("data", (chunk) => { payload += String(chunk); });
    request.on("end", () => {
      const { status, body } = handler(request.method ?? "", request.url ?? "", payload);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const current = server!;
    const cleanup = () => { current.off("error", onError); current.off("listening", onListening); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    current.once("error", onError);
    current.once("listening", onListening);
    current.listen(port, "127.0.0.1");
  });
  const address = server!.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/v1`;
};
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

const client = (apiUrl: string, over: Partial<ConstructorParameters<typeof CoolifyClient>[0]> = {}) =>
  new CoolifyClient({ apiUrl, token: "probe-token", pollIntervalMs: 1, sleep: async () => {}, ...over });

describe("the Coolify client", () => {
  it("rejects a listen startup error immediately instead of waiting for a test timeout", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await expect(listen(() => ({ status: 200, body: "{}" }), port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("reads an application", async () => {
    const url = await listen(() => ({ status: 200, body: JSON.stringify({ uuid: "app-1", name: "commerce", build_pack: "dockercompose", git_branch: "production-deploy", git_commit_sha: null }) }));
    expect(await client(url).application("app-1")).toEqual({
      uuid: "app-1", name: "commerce", buildPack: "dockercompose", gitBranch: "production-deploy", gitCommitSha: null,
    });
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
