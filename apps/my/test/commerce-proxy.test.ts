import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ingressClientIp, MY_PROXY_ROOTS, proxyCommerce } from "@/lib/commerce-proxy";
import { validMyReturnTarget } from "@/lib/return-targets";
import { securityHeaders } from "@/lib/security-headers";

const environment = { MY_ORIGIN: "https://my.flexperiment.ru", COMMERCE_INTERNAL_ORIGIN: "http://commerce:3002" };
const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`https://my.flexperiment.ru${path}`, { ...init, headers: { host: "my.flexperiment.ru", ...init.headers } });
const upstream = (response: Response) => vi.fn<(target: URL, init: RequestInit) => Promise<Response>>(async () => response);

describe("my same-origin Commerce proxy", () => {
  it("replaces every client forwarding header with its own host and the ingress peer", async () => {
    const send = upstream(Response.json({ ok: true }));
    const response = await proxyCommerce(request("/v1/my/session", { headers: {
      "x-forwarded-host": "flexperiment.ru", forwarded: "host=flexperiment.ru", "x-real-ip": "1.1.1.1",
      "x-forwarded-for": "6.6.6.6, 10.0.0.7", cookie: "a=b" } }), ["my", "session"], environment, send as unknown as typeof fetch);
    expect(response.status).toBe(200);
    const [target, init] = send.mock.calls[0] as [URL, RequestInit];
    expect(target.toString()).toBe("http://commerce:3002/v1/my/session");
    const headers = new Headers(init.headers);
    expect(headers.get("x-forwarded-host")).toBe("my.flexperiment.ru");
    expect(headers.get("x-forwarded-proto")).toBe("https");
    expect(headers.get("x-forwarded-for")).toBe("10.0.0.7");
    expect(headers.has("forwarded")).toBe(false);
    expect(headers.has("x-real-ip")).toBe(false);
    expect(headers.get("cookie")).toBe("a=b");
  });

  it("admits only the allowlisted roots; lms and auth are never reachable from my", async () => {
    expect([...MY_PROXY_ROOTS].sort()).toEqual(["checkout", "email", "legal", "me", "my", "refunds"]);
    for (const path of [["lms", "exchange", "redeem"], ["auth", "sign-in", "magic-link"], ["internal", "x"], ["admin"], ["my", ".."], ["my", "a\\b"]]) {
      const send = upstream(Response.json({}));
      expect((await proxyCommerce(request(`/v1/${path.join("/")}`), path, environment, send as unknown as typeof fetch)).status).toBe(404);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("refuses a foreign host or Origin before any upstream call", async () => {
    const send = upstream(Response.json({}));
    expect((await proxyCommerce(request("/v1/my/session", { headers: { host: "flexperiment.ru" } }), ["my", "session"], environment,
      send as unknown as typeof fetch)).status).toBe(403);
    expect((await proxyCommerce(request("/v1/my/otp/send", { method: "POST", headers: { origin: "https://flexperiment.ru" } }),
      ["my", "otp", "send"], environment, send as unknown as typeof fetch)).status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses Domain cookies and off-origin redirects; strips CORS headers", async () => {
    const domain = new Response(null, { headers: { "set-cookie": "s=1; Domain=flexperiment.ru; Path=/" } });
    expect((await proxyCommerce(request("/v1/my/session"), ["my", "session"], environment, upstream(domain) as unknown as typeof fetch)).status).toBe(502);
    const redirect = new Response(null, { status: 303, headers: { location: "https://evil.example/" } });
    expect((await proxyCommerce(request("/v1/my/session"), ["my", "session"], environment, upstream(redirect) as unknown as typeof fetch)).status).toBe(502);
    const cors = new Response("{}", { headers: { "access-control-allow-origin": "*", "set-cookie": "s=1; Path=/; HttpOnly; Secure" } });
    const output = await proxyCommerce(request("/v1/my/session"), ["my", "session"], environment, upstream(cors) as unknown as typeof fetch);
    expect(output.headers.has("access-control-allow-origin")).toBe(false);
    expect(output.headers.getSetCookie()).toEqual(["s=1; Path=/; HttpOnly; Secure"]);
    expect(output.headers.get("cache-control")).toBe("no-store");
  });

  it("is closed without configuration", async () => {
    expect((await proxyCommerce(request("/v1/my/session"), ["my", "session"], {})).status).toBe(503);
    expect(ingressClientIp(new Headers({ "x-forwarded-for": "not an ip" }))).toBeUndefined();
  });
});

describe("my page contract", () => {
  it("never sends a referrer and posts forms only to itself and the LMS origin", () => {
    const headers = Object.fromEntries(securityHeaders({ PLATFORM_ORIGIN: "https://flexperiment.ru" }).map(({ key, value }) => [key, value]));
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Content-Security-Policy"]).toContain("form-action 'self' https://flexperiment.ru;");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("return targets match the normative fixture", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "../../../docs/plans/fixtures/my-identity/return-targets.json"), "utf8")) as
      { MY: { cases: Array<{ input: string; result: string }> } };
    for (const sample of fixture.MY.cases) expect([sample.input, validMyReturnTarget(sample.input)]).toEqual([sample.input, sample.result]);
  });
});
