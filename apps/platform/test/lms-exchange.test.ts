import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as start } from "../app/auth/lms/start/route";
import { POST as redeem } from "../app/auth/lms/redeem/route";
import { GET as failed } from "../app/auth/lms/failed/route";
import { proxyCommerce } from "../lib/commerce-proxy";

const LMS = "https://flexperiment.ru";
const MY = "https://my.flexperiment.ru";
const COMMERCE = "http://commerce-v2:3002";
const tx = "a".repeat(22);
const code = "b".repeat(43);
const state = `__Host-flx-lms-x-${tx}=${"c".repeat(43)}`;
const lesson = "/courses/flexing-basics/lessons/one";
const requestStart = () => new Request(`${LMS}/auth/lms/start?next=${encodeURIComponent(lesson)}`, { headers: { host: "flexperiment.ru" } });
const requestRedeem = (origin = MY) => new Request(`${LMS}/auth/lms/redeem`, {
  method: "POST", headers: { host: "flexperiment.ru", origin, cookie: state }, body: new URLSearchParams({ tx, code }),
});

beforeEach(() => {
  vi.stubEnv("MY_IDENTITY_MODE", "on");
  vi.stubEnv("MY_ORIGIN", MY);
  vi.stubEnv("PLATFORM_ORIGIN", LMS);
  vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", COMMERCE);
  vi.stubEnv("PLATFORM_V2_CANARY", "false");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Platform MY → LMS browser bridge", () => {
  it("keeps the legacy surface when the cutover flag is off", async () => {
    vi.stubEnv("MY_IDENTITY_MODE", "off");
    const fetch = vi.spyOn(globalThis, "fetch");
    const path = ["lms", "sign-out"];
    const signOut = new Request(`${LMS}/v1/lms/sign-out`, { method: "POST" });
    expect((await start(requestStart())).status).toBe(404);
    expect((await redeem(requestRedeem())).status).toBe(404);
    expect(failed().status).toBe(404);
    expect((await proxyCommerce(signOut, path)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("starts on LMS and forwards the browser-bound state cookie and exact MY destination", async () => {
    const cookie = `${state}; Path=/; HttpOnly; Secure; SameSite=Lax`;
    const target = `${MY}/continue?tx=${tx}`;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ location: target }, { headers: { "Set-Cookie": cookie } }));
    const result = await start(requestStart());
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${COMMERCE}/v1/lms/exchange/start`);
    expect(JSON.parse(String(init?.body))).toEqual({ next: lesson });
    expect(new Headers(init?.headers).has("origin")).toBe(false);
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(target);
    expect(result.headers.getSetCookie()).toEqual([cookie]);
  });

  it("redeems through Commerce with origin and state and keeps the code out of the redirect", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", `__Host-flx-lms=${"d".repeat(43)}; Path=/; HttpOnly; Secure; SameSite=Lax`);
    headers.append("Set-Cookie", `${state.split("=")[0]}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ location: lesson }, { headers }));
    const result = await redeem(requestRedeem());
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${COMMERCE}/v1/lms/exchange/redeem`);
    expect(JSON.parse(String(init?.body))).toEqual({ tx, code });
    expect(new Headers(init?.headers).get("origin")).toBe(MY);
    expect(new Headers(init?.headers).get("cookie")).toBe(state);
    expect(result.headers.get("location")).toBe(lesson);
    expect(result.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });

  it("refuses off-origin forms and cookie or location expansion", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await redeem(requestRedeem("https://other.example"))).headers.get("location")).toBe("/auth/lms/failed");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ location: "//other.example/" }));
    fetch.mockResolvedValueOnce(Response.json({ location: lesson }, { headers: { "Set-Cookie": `${state}; Domain=flexperiment.ru` } }));
    for (let i = 0; i < 2; i++) {
      const response = await redeem(requestRedeem());
      expect(response.headers.get("location")).toBe("/auth/lms/failed");
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  });
});

it("returns to a scoped LMS path through MY sign-in without allocating an exchange", async () => {
  vi.stubEnv("MY_SESSION_COOKIE_DOMAIN", "flexperiment.ru");
  const fetch = vi.spyOn(globalThis, "fetch");
  const response = await start(requestStart());
  expect(response.status).toBe(303);
  const location = new URL(response.headers.get("Location")!);
  expect(location.origin).toBe(MY);
  expect(location.pathname).toBe("/sign-in");
  expect(location.searchParams.get("lmsNext")).toBe(lesson);
  const foreign = await start(new Request(`${LMS}/auth/lms/start?next=%2F%2Fevil.example`));
  expect(new URL(foreign.headers.get("Location")!).searchParams.get("lmsNext")).toBe("/courses");
  expect((await redeem(requestRedeem())).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
});
