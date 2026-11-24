import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legalEffectiveDate } from "@/lib/legal-release";
import { legalPageHeader } from "@/lib/legal-release-server";
import { proxy } from "../proxy";

const request = (kind: string) => new NextRequest(`https://platform.example.test/legal/${kind}`, {
  headers: { [legalPageHeader]: "untrusted-header" },
});
const event = {} as NextFetchEvent;
const effectiveAt = "2026-11-23T21:00:00.000Z";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("active legal edition", () => {
  it("uses Moscow calendar days on both sides of 21:00 UTC", () => {
    expect(legalEffectiveDate("2026-11-23T20:59:59.999Z")).toBe("23 ноября 2026 г.");
    expect(legalEffectiveDate(effectiveAt)).toBe("24 ноября 2026 г.");
  });

  it("passes only the exact active edition to the server page", async () => {
    const document = { kind: "privacy", version: "edition-3", sha256: "a".repeat(64), url: "https://docs.example.test/edition-3.md" };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      version: "release-3", effectiveAt, manifest: { stage: "A", documents: [document] },
    }));
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://commerce.example.test:3002");
    const response = await proxy(request("privacy"), event);
    expect(response.headers.get("location")).toBeNull();
    const forwarded = response.headers.get(`x-middleware-request-${legalPageHeader}`);
    expect(JSON.parse(decodeURIComponent(forwarded!))).toEqual({
      title: "Политика конфиденциальности", effectiveAt, document,
    });
    expect(fetcher).toHaveBeenCalledWith(new URL("http://commerce.example.test:3002/v1/legal/current?storefront=COURSES"),
      expect.objectContaining({ cache: "no-store", redirect: "error" }));
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).keys().toArray()).toEqual([]);
  });

  it("returns 404 for a missing release and an unknown kind", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code: "LEGAL_RELEASE_NOT_FOUND" }, { status: 404 }));
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://commerce.example.test:3002");
    expect((await proxy(request("privacy"), event)).status).toBe(404);
    expect((await proxy(request("constructor"), event)).status).toBe(404);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
