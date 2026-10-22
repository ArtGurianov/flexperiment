import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/readyz/route";

const ready = { ok: true, service: "commerce-v2", foundationMode: false, core: { database: "ok" } };

beforeEach(() => {
  vi.stubEnv("PLATFORM_V2_CANARY", "false");
  vi.stubEnv("DEPLOY_ENV", "production");
  vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://commerce.test:3002");
  vi.stubEnv("BUILD_IDENTITY_FILE", "");
  vi.stubEnv("SOURCE_COMMIT", "a".repeat(40));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("non-canary production platform readiness", () => {
  it("accepts an explicitly non-foundation Commerce runtime", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(ready));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, commerce: "ok", sourceCommit: "a".repeat(40) });
  });

  it("waits for a slow but in-budget Commerce authority read instead of a 3s cut", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(ready)), 3_500);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); });
    }));
    const response = await GET();
    expect(response.status).toBe(200);
  }, 10_000);

  it.each([true, undefined])("returns 503 when Commerce foundationMode is %s", async foundationMode => {
    const upstream = { ...ready, foundationMode };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(upstream));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: false, service: "platform", error: "PLATFORM_NOT_READY", reason: "UPSTREAM_CONTRACT" });
  });
});

describe("platform readiness failure diagnostics", () => {
  const secret = "synthetic-secret-token";
  it.each([
    ["UPSTREAM_TIMEOUT", () => Promise.reject(new DOMException(secret, "TimeoutError")), undefined],
    ["UPSTREAM_TRANSPORT", () => Promise.reject(new TypeError(`fetch failed ${secret}`)), undefined],
    ["UPSTREAM_STATUS", () => Promise.resolve(Response.json({ ok: false, secret }, { status: 503 })), 503],
    ["UPSTREAM_CONTRACT", () => Promise.resolve(new Response(`{not json ${secret}`)), undefined],
  ] as const)("reports %s with timing and no upstream text", async (reason, upstream, upstreamStatus) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(upstream);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ ok: false, service: "platform", error: "PLATFORM_NOT_READY", reason,
      elapsedMs: expect.any(Number), ...(upstreamStatus ? { upstreamStatus } : {}) });
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(JSON.parse(line)).toEqual({ event: "PLATFORM_READINESS_FAILED", reason,
      elapsedMs: body.elapsedMs, ...(upstreamStatus ? { upstreamStatus } : {}) });
    for (const leaked of [secret, "commerce.test"]) {
      expect(line).not.toContain(leaked);
      expect(JSON.stringify(body)).not.toContain(leaked);
    }
  });

  it("reports a missing Commerce origin as configuration, not an upstream outage", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(await response.json()).toMatchObject({ reason: "CONFIGURATION" });
  });
});
