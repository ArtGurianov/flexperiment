import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canaryOrigins, validatePlatformCanary } from "../lib/canary-config";
import { proxyCommerce } from "../lib/commerce-proxy";
import { assertCommerceReady } from "../lib/canary-readiness";
import * as transport from "../lib/canary-http";

const env = {
  ...canaryOrigins, PLATFORM_V2_CANARY: "true", COMMERCE_INTERNAL_ORIGIN: "http://xzuy7pk5y6ywjr9kh6nsk5ap-20261010T152433:3002",
  PAYMENT_MODE: "disabled", MARKETING_BROADCASTS_ENABLED: "false",
  BUILD_IDENTITY_FILE: "/app/.identity/identity.json", PLATFORM_EXPECTED_COMMERCE_SHA: "b".repeat(40), S3_BUCKET: "",
  DEPLOY_ENV: "staging",
};
const request = (headers: Record<string, string> = {}, method = "GET") => new Request(
  "http://internal-next:3001/v1/auth/magic-link/verify?token=synthetic-query", {
    method, headers: { host: "canary-platform.flexperiment.ru", ...headers },
    body: method === "POST" ? "synthetic-body" : undefined,
  });
beforeEach(() => { for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("closed Platform canary configuration", () => {
  it("admits only the explicit approved isolated configuration", () => expect(validatePlatformCanary()).toBe(true));
  it.each(Object.keys(env).filter(key => key !== "S3_BUCKET"))("missing %s refuses", key => {
    expect(() => validatePlatformCanary({ ...env, [key]: "" })).toThrow("PLATFORM_CANARY_CONFIG_INVALID");
  });
  it.each(["https://api.flexperiment.ru", "http://gzngatkipv7dv3rkpuaigjg5:3002", "http://127.0.0.1:3002", `${env.COMMERCE_INTERNAL_ORIGIN}/path`])("foreign upstream %s refuses before fetch", async upstream => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", upstream);
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await proxyCommerce(request(), ["auth", "get-session"])).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("default non-canary mode remains supported", () => expect(validatePlatformCanary({})).toBe(false));
  it("refuses configured media writes", () => expect(() => validatePlatformCanary({ ...env, S3_BUCKET: "production-media" })).toThrow());
  it.each(["PAYLOAD_DATABASE_URL", "PAYLOAD_SECRET", "PAYLOAD_JOBS_ENABLED"])("refuses retained %s from the old runtime", key => {
    expect(() => validatePlatformCanary({ ...env, [key]: "legacy-value" })).toThrow("PLATFORM_CANARY_CONFIG_INVALID");
  });
});

describe("Platform same-origin proxy", () => {
  it.each(["GET", "POST"])("forwards customer refund %s with the session and idempotency key", async method => {
    const body = JSON.stringify({ orderPublicId: "synthetic-order", reasonCode: "CUSTOMER_REQUEST" });
    const upstream = vi.spyOn(transport, "canaryCommerceRequest").mockResolvedValue(Response.json(
      method === "POST" ? { requestPublicId: "synthetic-refund", state: "REQUESTED" } : { refunds: [] },
      { status: method === "POST" ? 201 : 200 },
    ));
    const response = await proxyCommerce(new Request(`${canaryOrigins.PLATFORM_ORIGIN}/v1/refunds`, {
      method,
      headers: { host: "canary-platform.flexperiment.ru", origin: canaryOrigins.PLATFORM_ORIGIN,
        cookie: "session=synthetic", "content-type": "application/json", "idempotency-key": "synthetic-refund-request" },
      body: method === "POST" ? body : undefined,
    }), ["refunds"]);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, options] = upstream.mock.calls[0];
    expect(String(url)).toBe(new URL("/v1/refunds", env.COMMERCE_INTERNAL_ORIGIN).toString());
    expect(options).toMatchObject({ method, redirect: "manual", cache: "no-store" });
    const headers = new Headers(options?.headers);
    expect(headers.get("cookie")).toBe("session=synthetic");
    expect(headers.get("origin")).toBe(canaryOrigins.PLATFORM_ORIGIN);
    expect(headers.get("idempotency-key")).toBe("synthetic-refund-request");
    if (method === "POST") expect(await new Response(options?.body).text()).toBe(body);
    expect(response.status).toBe(method === "POST" ? 201 : 200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each([
    { path: ["refunds", "synthetic-refund", "execute"], method: "POST" },
    { path: ["refunds", "synthetic-refund", "decision"], method: "POST" },
    { path: ["refunds"], method: "DELETE" },
    { path: ["refunds"], method: "PATCH" },
  ])("does not expose refund decisions, execution or unsupported methods: %j", async ({ path, method }) => {
    const upstream = vi.spyOn(transport, "canaryCommerceRequest");
    expect((await proxyCommerce(new Request(`${canaryOrigins.PLATFORM_ORIGIN}/v1/${path.join("/")}`, {
      method, headers: { host: "canary-platform.flexperiment.ru", origin: canaryOrigins.PLATFORM_ORIGIN },
    }), path)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("preserves the customer refund authentication refusal", async () => {
    vi.spyOn(transport, "canaryCommerceRequest").mockResolvedValue(Response.json({ code: "SIGN_IN_REQUIRED" }, { status: 401 }));
    const response = await proxyCommerce(new Request(`${canaryOrigins.PLATFORM_ORIGIN}/v1/refunds`, {
      headers: { host: "canary-platform.flexperiment.ru" },
    }), ["refunds"]);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "SIGN_IN_REQUIRED" });
  });
  it.each(["foreign.example", "flexperiment.ru", "canary-lab.flexperiment.ru", "canary-platform.flexperiment.ru:443"])("foreign host %s refuses", async host => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await proxyCommerce(request({ host }), ["auth"])).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects foreign Origin even with approved Host", async () => {
    expect((await proxyCommerce(request({ origin: "https://flexperiment.ru" }), ["auth"])).status).toBe(403);
  });
  it.each([["public", "tours"], ["partner"], ["internal"], ["admin"], ["auth", ".."], ["auth", "a/b"], ["auth", "a\\b"]])("rejects foreign/legacy path %j before fetch", async (...path) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await proxyCommerce(request(), path)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves method/body/query/cookies and safe Location, overwrites forwarding and no-store", async () => {
    const fetch = vi.spyOn(transport, "canaryCommerceRequest").mockResolvedValue(new Response("accepted", { status: 302, headers: {
      location: `${canaryOrigins.PLATFORM_ORIGIN}/account`, "set-cookie": "session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax",
      "cache-control": "public, max-age=999", "access-control-allow-origin": "*",
    } }));
    const response = await proxyCommerce(request({ cookie: "session=synthetic", "x-forwarded-host": "foreign", "x-forwarded-proto": "http", "x-forwarded-for": "fake", forwarded: "host=foreign" }, "POST"), ["auth", "magic-link"]);
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toBe(new URL("/v1/auth/magic-link?token=synthetic-query", env.COMMERCE_INTERNAL_ORIGIN).toString());
    const headers = new Headers(options?.headers);
    expect(headers.get("host")).toBe("canary-platform.flexperiment.ru");
    expect(headers.get("x-forwarded-host")).toBe("canary-platform.flexperiment.ru");
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("cookie")).toBe("session=synthetic");
    expect(headers.has("forwarded")).toBe(false);
    expect(headers.has("x-forwarded-for")).toBe(false);
    expect(options).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    expect(await new Response(options?.body).text()).toBe("synthetic-body");
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
    expect(response.headers.get("location")).toBe(`${canaryOrigins.PLATFORM_ORIGIN}/account`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
  it.each(["https://flexperiment.ru/account", "//foreign.example/account"])("refuses foreign Location %s", async location => {
    vi.spyOn(transport, "canaryCommerceRequest").mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    expect((await proxyCommerce(request(), ["auth"])).status).toBe(502);
  });
  it("refuses shared-domain cookies without rewriting", async () => {
    vi.spyOn(transport, "canaryCommerceRequest").mockResolvedValue(new Response(null, { headers: { "set-cookie": "session=x; Domain=.flexperiment.ru" } }));
    expect((await proxyCommerce(request(), ["auth"])).status).toBe(502);
  });
  it("preserves upstream refusal and sanitizes transport exceptions", async () => {
    const fetch = vi.spyOn(transport, "canaryCommerceRequest").mockResolvedValue(Response.json({ code: "SIGN_IN_REQUIRED" }, { status: 401 }));
    expect((await proxyCommerce(request(), ["me", "orders"])).status).toBe(401);
    fetch.mockRejectedValue(new Error("synthetic-secret-url-token"));
    const response = await proxyCommerce(request(), ["auth"]);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-secret");
  });
});

describe("genuine read-only canary upstream readiness", () => {
  const ready = { ok: true, service: "commerce-v2", sourceCommit: env.PLATFORM_EXPECTED_COMMERCE_SHA, foundationMode: false, core: { database: "ok", paymentMode: "disabled" }, capabilities: { refref: "ready" } };
  it("checks exact expected canary SHA and payment mode with credential-free GET", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(ready));
    await expect(assertCommerceReady()).resolves.toBeUndefined();
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
    expect(fetch.mock.calls[0][1]?.headers).toBeUndefined();
  });
  it.each([{ sourceCommit: "c".repeat(40) }, { foundationMode: true }, { core: { database: "ok", paymentMode: "refref" } }, { capabilities: { refref: "unavailable" } }])("rejects wrong upstream identity/state %j", async drift => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...ready, ...drift }));
    await expect(assertCommerceReady()).rejects.toThrow("CANARY_COMMERCE_UNAVAILABLE");
  });
  it("rejects oversized response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(16385)));
    await expect(assertCommerceReady()).rejects.toThrow("CANARY_COMMERCE_UNAVAILABLE");
  });
});
