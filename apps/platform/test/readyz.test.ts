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
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, service: "platform", error: "PLATFORM_NOT_READY" });
  });
});
