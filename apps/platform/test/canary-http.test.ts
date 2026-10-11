import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { canaryCommerceRequest } from "../lib/canary-http";

async function withServer(handler: RequestListener, test: (url: URL) => Promise<void>) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_UNAVAILABLE");
  try { await test(new URL(`http://127.0.0.1:${address.port}/v1/auth?test=synthetic`)); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

describe("real canary HTTP transport", () => {
  it("preserves explicit Host, HTTPS forwarding, cookies, query and streamed POST body", async () => {
    await withServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => response.end(JSON.stringify({ host: request.headers.host,
        proto: request.headers["x-forwarded-proto"], cookie: request.headers.cookie,
        method: request.method, path: request.url, body })));
    }, async (url) => {
      const response = await canaryCommerceRequest(url, { method: "POST", headers: {
        host: "canary-platform.flexperiment.ru", "x-forwarded-proto": "https", cookie: "session=synthetic",
      }, body: new Response("synthetic-streamed-body").body, signal: AbortSignal.timeout(2000) });
      expect(await response.json()).toEqual({ host: "canary-platform.flexperiment.ru", proto: "https",
        cookie: "session=synthetic", method: "POST", path: "/v1/auth?test=synthetic", body: "synthetic-streamed-body" });
      // Negative control: replacing the transport with Node fetch loses Host.
      const wrong = await fetch(url, { headers: { host: "canary-platform.flexperiment.ru" } });
      expect((await wrong.json()).host).not.toBe("canary-platform.flexperiment.ru");
    });
  });
  it("does not follow redirects and preserves distinct Set-Cookie headers", async () => {
    let calls = 0;
    await withServer((_request, response) => {
      calls += 1;
      response.writeHead(302, { location: "https://foreign.example/never-follow",
        "set-cookie": ["one=synthetic; Path=/; Secure; HttpOnly", "two=synthetic; Path=/; Secure; HttpOnly"] });
      response.end();
    }, async (url) => {
      const response = await canaryCommerceRequest(url, { method: "GET", signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(302);
      expect(response.headers.getSetCookie()).toHaveLength(2);
      expect(response.headers.get("location")).toBe("https://foreign.example/never-follow");
      await response.text();
      expect(calls).toBe(1);
    });
  });
  it("honors bounded abort without returning an acknowledged response", async () => {
    await withServer(() => {}, async (url) => {
      await expect(canaryCommerceRequest(url, { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    });
  });
  it("preserves bodyless HTTP refusals and rejects unsupported protocols", async () => {
    await withServer((_request, response) => { response.writeHead(204); response.end(); }, async (url) => {
      const response = await canaryCommerceRequest(url, { method: "GET", signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });
    await expect(canaryCommerceRequest(new URL("https://foreign.example"), {})).rejects.toThrow("CANARY_TRANSPORT_REFUSED");
  });
});
