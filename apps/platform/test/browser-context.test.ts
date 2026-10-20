import { NextRequest, type NextFetchEvent } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as arrive } from "../app/arrive/route";
import { BROWSER_CONTEXT_COOKIE, touchBrowserContext } from "../lib/browser-context";
import { proxyCommerce } from "../lib/commerce-proxy";
import { config, proxy } from "../proxy";

// ART-378: the platform-origin arrival endpoint and the page-view retry hook. Commerce owns the
// context, proof and exchange; the platform forwards on its own origin and never sees a proof again.

const COMMERCE = "http://commerce-v2:3002";
const PROOF = `ar1.${"A".repeat(43)}`;
const COOKIE = `${BROWSER_CONTEXT_COOKIE}=${"c".repeat(43)}`;

beforeEach(() => { vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", COMMERCE); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("platform /arrive", () => {
  it("forwards the decorated URL to Commerce and returns its cookie and clean redirect unchanged", async () => {
    const setCookie = `${COOKIE}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 303, headers: {
      location: "https://flexperiment.ru/courses/intro", "set-cookie": setCookie, "cache-control": "no-store" } }));
    const response = await arrive(new Request(`https://flexperiment.ru/arrive?to=%2Fcourses%2Fintro&arrival=${PROOF}`, {
      headers: { host: "flexperiment.ru", cookie: "flx.session=s" } }));
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${COMMERCE}/v1/browser-context/arrive?to=%2Fcourses%2Fintro&arrival=${PROOF}`);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-forwarded-host")).toBe("flexperiment.ru");
    expect(headers.get("cookie")).toBe("flx.session=s");
    expect(init).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://flexperiment.ru/courses/intro");
    expect(response.headers.get("location")).not.toContain(PROOF);
    expect(response.headers.getSetCookie()).toEqual([setCookie]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 without detail when Commerce is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(`fetch failed ${PROOF}`));
    const response = await arrive(new Request(`https://flexperiment.ru/arrive?arrival=${PROOF}`));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(PROOF);
  });

  it("keeps the browser-context routes off the public /v1 proxy", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const path of [["browser-context", "arrive"], ["browser-context", "touch"]]) {
      expect((await proxyCommerce(new Request(`https://flexperiment.ru/v1/${path.join("/")}`), path)).status).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("page-view retry hook", () => {
  const event = () => {
    const waited: Promise<unknown>[] = [];
    return { waited, event: { waitUntil: (promise: Promise<unknown>) => { waited.push(promise); } } as unknown as NextFetchEvent };
  };

  it("retries after the response for a browser with a context, without touching the page response", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const { waited, event: fetchEvent } = event();
    const response = proxy(new NextRequest("https://flexperiment.ru/courses/intro", { headers: { cookie: COOKIE, host: "flexperiment.ru" } }), fetchEvent);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${COMMERCE}/v1/browser-context/touch`);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("cookie")).toBe(COOKIE);
  });

  it("does nothing for a browser without a context", () => {
    const { waited, event: fetchEvent } = event();
    proxy(new NextRequest("https://flexperiment.ru/courses/intro"), fetchEvent);
    expect(waited).toEqual([]);
  });

  it("swallows a failed retry", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(touchBrowserContext(new Request("https://flexperiment.ru/", { headers: { cookie: COOKIE } }))).resolves.toBeUndefined();
  });

  it("matches pages only when the context cookie is present, never prefetches, assets, the API or /arrive", () => {
    const [matcher] = config.matcher;
    expect(matcher.has).toEqual([{ type: "cookie", key: BROWSER_CONTEXT_COOKIE }]);
    expect(matcher.missing).toEqual(expect.arrayContaining([{ type: "header", key: "next-router-prefetch" }]));
    const pattern = new RegExp(`^${matcher.source}$`);
    for (const path of ["/", "/courses", "/courses/intro", "/account", "/legal/offer"]) expect(pattern.test(path), path).toBe(true);
    for (const path of ["/_next/static/x.js", "/v1/me", "/arrive", "/identity", "/readyz", "/robots.txt", "/sitemap.xml", "/search-index.json"]) {
      expect(pattern.test(path), path).toBe(false);
    }
  });
});
