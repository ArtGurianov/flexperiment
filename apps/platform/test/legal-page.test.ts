import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canaryOrigins } from "@/lib/canary-config";
import { canaryCommerceRequest } from "@/lib/canary-http";
import { proxyCommerce } from "@/lib/commerce-proxy";
import { legalEffectiveDate } from "@/lib/legal-release";
import { legalPageHeader } from "@/lib/legal-release-server";
import { proxy } from "../proxy";

vi.mock("@/lib/canary-http", () => ({ canaryCommerceRequest: vi.fn() }));

const request = (kind: string, host = "platform.example.test") => new NextRequest(`https://${host}/legal/${kind}`, {
  headers: { host, [legalPageHeader]: "untrusted-header" },
});
const event = {} as NextFetchEvent;
const effectiveAt = "2026-11-23T21:00:00.000Z";
const document = { kind: "privacy", version: "edition-3", sha256: "a".repeat(64), url: "https://docs.example.test/edition-3.md" };
const edition = { version: "release-3", effectiveAt, manifest: { stage: "A", documents: [document] } };
const canaryHost = new URL(canaryOrigins.PLATFORM_ORIGIN).host;
const apiRequest = () => new Request(`${canaryOrigins.PLATFORM_ORIGIN}/v1/legal/current?storefront=COURSES`, { headers: { host: canaryHost } });

function configureCanary() {
  for (const [name, value] of Object.entries({
    ...canaryOrigins, PLATFORM_V2_CANARY: "true", DEPLOY_ENV: "staging",
    COMMERCE_INTERNAL_ORIGIN: "http://xzuy7pk5y6ywjr9kh6nsk5ap:3002",
    PAYMENT_MODE: "disabled", MARKETING_BROADCASTS_ENABLED: "false",
    BUILD_IDENTITY_FILE: "/app/.identity/identity.json", PLATFORM_EXPECTED_COMMERCE_SHA: "a".repeat(40),
  })) vi.stubEnv(name, value);
}

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("active legal edition", () => {
  it("uses Moscow calendar days on both sides of 21:00 UTC", () => {
    expect(legalEffectiveDate("2026-11-23T20:59:59.999Z")).toBe("23 ноября 2026 г.");
    expect(legalEffectiveDate(effectiveAt)).toBe("24 ноября 2026 г.");
  });

  it("passes only the exact active edition to the server page", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(edition));
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://commerce.example.test:3002");
    const response = await proxy(request("privacy"), event);
    expect(response.headers.get("location")).toBeNull();
    const forwarded = response.headers.get(`x-middleware-request-${legalPageHeader}`);
    expect(JSON.parse(decodeURIComponent(forwarded!))).toEqual({
      title: "Политика конфиденциальности", effectiveAt, document,
    });
    expect(fetcher).toHaveBeenCalledWith(new URL("http://commerce.example.test:3002/v1/legal/current?storefront=COURSES"),
      expect.objectContaining({ cache: "no-store", redirect: "manual" }));
    const upstream = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(upstream.has(legalPageHeader)).toBe(false);
  });

  it("returns 404 for a missing release and an unknown kind", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code: "LEGAL_RELEASE_NOT_FOUND" }, { status: 404 }));
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://commerce.example.test:3002");
    expect((await proxy(request("privacy"), event)).status).toBe(404);
    expect((await proxy(request("constructor"), event)).status).toBe(404);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("uses the same admitted canary transport for SSR and API", async () => {
    configureCanary();
    const ordinaryFetch = vi.spyOn(globalThis, "fetch");
    const canary = vi.mocked(canaryCommerceRequest).mockImplementation(async () => Response.json(edition));
    const page = await proxy(request("privacy", canaryHost), event);
    const api = await proxyCommerce(apiRequest(), ["legal", "current"]);
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(await api.json()).toEqual(edition);
    expect(canary).toHaveBeenCalledTimes(2);
    for (const [target, init] of canary.mock.calls) {
      expect(target.href).toBe("http://xzuy7pk5y6ywjr9kh6nsk5ap:3002/v1/legal/current?storefront=COURSES");
      const upstream = new Headers(init.headers);
      expect(upstream.get("host")).toBe(canaryHost);
      expect(upstream.get("x-forwarded-proto")).toBe("https");
      expect(upstream.has(legalPageHeader)).toBe(false);
    }
    expect(ordinaryFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["COMMERCE_INTERNAL_ORIGIN", "http://foreign.example:3002"],
    ["MARKETING_BROADCASTS_ENABLED", "true"],
    ["PAYMENT_MODE", "mock"],
  ])("refuses invalid closed canary %s without making a request", async (key, value) => {
    configureCanary();
    vi.stubEnv(key, value);
    const ordinaryFetch = vi.spyOn(globalThis, "fetch");
    expect((await proxy(request("privacy", canaryHost), event)).status).toBe(503);
    const api = await proxyCommerce(apiRequest(), ["legal", "current"]);
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ code: "COMMERCE_NOT_CONFIGURED" });
    expect(canaryCommerceRequest).not.toHaveBeenCalled();
    expect(ordinaryFetch).not.toHaveBeenCalled();
  });
  it("refuses an untrusted host on both SSR and API", async () => {
    configureCanary();
    const host = "foreign.example";
    const api = new Request(apiRequest(), { headers: { host } });
    expect((await proxy(request("privacy", host), event)).status).toBe(403);
    expect((await proxyCommerce(api, ["legal", "current"])).status).toBe(403);
    expect(canaryCommerceRequest).not.toHaveBeenCalled();
  });
});
