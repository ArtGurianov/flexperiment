import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CABINET_ROUTES, cabinetOrigins, cabinetSource, commerceCabinetSource, fixtureCabinetSource, fixtureName, sessionCookieHeader,
} from "../components/cabinet/data";
import { lmsEntryHref, parseCourses, parseOrders, parseProfile, parseTickets } from "../components/cabinet/model";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENV = { MY_ORIGIN: "https://my.flexperiment.test", COMMERCE_INTERNAL_ORIGIN: "http://commerce.internal:8787", NODE_ENV: "test" };
const COOKIE = "__Secure-better-auth.session_token=fixture-token.sig";
const json = (body: unknown, status = 200) => Response.json(body, { status });

describe("FLEX-123 cabinet data layer", () => {
  it("forwards only the MY session cookie and pins the MY surface", async () => {
    expect(sessionCookieHeader([
      { name: "__Secure-better-auth.session_token", value: "fixture-token.sig" },
      { name: "__Host-flx-lms", value: "lms-token" },
      { name: "_ym_uid", value: "123" },
    ])).toBe(COOKIE);
    expect(sessionCookieHeader([{ name: "_ym_uid", value: "1" }])).toBeNull();

    const send = vi.fn(async () => json({ orders: [] }));
    await commerceCabinetSource({ cookie: COOKIE, environment: ENV, send }).orders();
    const [url, init] = send.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://commerce.internal:8787/v1/me/orders");
    expect(url.search).toBe(""); // no selector: Commerce answers for the session owner only
    expect(init).toEqual(expect.objectContaining({ method: "GET", redirect: "manual", cache: "no-store" }));
    expect(init.headers).toEqual({ accept: "application/json", cookie: COOKIE,
      "x-forwarded-host": "my.flexperiment.test", "x-forwarded-proto": "https" });
  });

  it("sends nothing and treats the visitor as signed out without a session cookie", async () => {
    const send = vi.fn();
    const source = commerceCabinetSource({ cookie: null, environment: ENV, send });
    for (const read of [source.profile, source.courses, source.tickets, source.orders]) {
      await expect(read()).resolves.toEqual({ status: "signed-out" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("maps revoked sessions, wrong audience, consent and pending routes without leaking a body", async () => {
    const answer = (status: number, body: unknown) => commerceCabinetSource({ cookie: COOKIE, environment: ENV,
      send: async () => json(body, status) });
    await expect(answer(401, { code: "SIGN_IN_REQUIRED" }).profile()).resolves.toEqual({ status: "signed-out" });
    await expect(answer(403, { code: "SESSION_AUDIENCE_FORBIDDEN" }).orders()).resolves.toEqual({ status: "unavailable" });
    await expect(answer(403, { code: "CONSENT_REQUIRED" }).courses()).resolves.toEqual({ status: "consent-required" });
    await expect(answer(404, { code: "NOT_FOUND" }).courses()).resolves.toEqual({ status: "not-yet-available" });
    await expect(answer(404, { code: "NOT_FOUND" }).tickets()).resolves.toEqual({ status: "not-yet-available" });
    await expect(answer(404, { code: "NOT_FOUND" }).orders()).resolves.toEqual({ status: "unavailable" });
    await expect(answer(302, null).profile()).resolves.toEqual({ status: "unavailable" });
    await expect(commerceCabinetSource({ cookie: COOKIE, environment: ENV, send: async () => { throw new Error("down"); } })
      .orders()).resolves.toEqual({ status: "unavailable" });
    await expect(commerceCabinetSource({ cookie: COOKIE, environment: { NODE_ENV: "test" }, send: vi.fn() })
      .profile()).resolves.toEqual({ status: "unavailable" });
  });

  it("drops foreign and unexpected fields from every answer", () => {
    const profile = parseProfile({ email: "buyer@example.test", displayName: null, createdAt: "2026-11-20T10:00:00.000Z",
      consentRequired: false, marketing: false, customerId: "cus_other", authUserId: "u_other", sessionId: "s" });
    expect(Object.keys(profile!).sort()).toEqual(["consentRequired", "createdAt", "displayName", "email", "marketing"]);
    const tickets = parseTickets({ tickets: [{ orderPublicId: "ord_lab_fixture_0001", title: "LAB", startsAt: "2026-12-06T09:00:00Z",
      timezone: "Asia/Novosibirsk", status: "VALID", viewPath: "https://evil.test/ticket", qr: "QRDATA", accessToken: "secret",
      customerEmail: "other@example.test" }] });
    expect(tickets![0]).not.toHaveProperty("qr");
    expect(tickets![0]).not.toHaveProperty("accessToken");
    expect(tickets![0].viewPath).toBeNull();
    expect(JSON.stringify(tickets)).not.toMatch(/QRDATA|secret|other@example/);
    expect(parseOrders({ orders: [{ orderPublicId: "x", state: "FULFILLED" }] })).toEqual([]);
    expect(parseCourses({ courses: [{ slug: "../evil", title: "x", access: "PURCHASE" }] })).toEqual([]);
    expect(parseCourses({ code: "X" })).toBeNull();
  });

  it("builds lesson entries only through the exchange receiver and ticket links only within MY", () => {
    const [course] = parseCourses({ courses: [{ slug: "flex-basics", title: "Основы", access: "PURCHASE", started: true,
      resumeLesson: { slug: "isolation-intro", title: "Изоляции" } }] })!;
    expect(lmsEntryHref("https://flexperiment.test", course))
      .toBe("https://flexperiment.test/auth/lms/start?next=%2Fcourses%2Fflex-basics%2Flessons%2Fisolation-intro");
    const [ticket] = parseTickets({ tickets: [{ orderPublicId: "ord_lab_fixture_0001", title: "LAB", startsAt: "2026-12-06T09:00:00Z",
      timezone: "Asia/Novosibirsk", status: "VALID", viewPath: "/tickets/ord_lab_fixture_0001" }] })!;
    expect(ticket.viewPath).toBe("/tickets/ord_lab_fixture_0001");
  });

  it("uses direct LMS entry only when the shared account cookie covers the configured origins", () => {
    const [course] = parseCourses({ courses: [{ slug: "flex-basics", title: "Основы", access: "PURCHASE", started: true,
      resumeLesson: { slug: "isolation-intro", title: "Изоляции" } }] })!;
    const configured = { ...ENV, MY_SESSION_COOKIE_DOMAIN: "flexperiment.test", PLATFORM_ORIGIN: "https://flexperiment.test",
      LAB_ORIGIN: "https://lab.flexperiment.test" };
    const legacy = cabinetOrigins({ ...configured, MY_IDENTITY_MODE: "off" });
    const shared = cabinetOrigins({ ...configured, MY_IDENTITY_MODE: "on" });
    expect(lmsEntryHref(legacy.platform, course, legacy.sharedSession)).toContain("/auth/lms/start?");
    expect(lmsEntryHref(shared.platform, course, shared.sharedSession))
      .toBe("https://flexperiment.test/courses/flex-basics/lessons/isolation-intro");
    expect(() => cabinetOrigins({ ...configured, MY_IDENTITY_MODE: "on", PLATFORM_ORIGIN: "https://other.test" }))
      .toThrow("MY_SESSION_COOKIE_DOMAIN_ORIGIN_MISMATCH");
  });

  it("serves both fixture profiles through the same parsers and never in production", async () => {
    const lms = fixtureCabinetSource("lms");
    const lab = fixtureCabinetSource("lab");
    expect((await lms.courses())).toMatchObject({ status: "ok", data: [{ slug: "flex-basics" }, { slug: "musicality-free" }] });
    expect((await lms.tickets())).toEqual({ status: "ok", data: [] });
    expect((await lab.tickets())).toMatchObject({ status: "ok", data: [{ status: "VALID" }, { status: "NOT_ISSUED" }] });
    expect((await lab.courses())).toEqual({ status: "ok", data: [] });
    expect((await fixtureCabinetSource("signed-out").profile())).toEqual({ status: "signed-out" });
    expect(fixtureName({ NODE_ENV: "production", MY_CABINET_FIXTURE: "lms" })).toBeNull();
    expect(fixtureName({ NODE_ENV: "development", MY_CABINET_FIXTURE: "lab" })).toBe("lab");
    const send = vi.fn(async () => json({ code: "SIGN_IN_REQUIRED" }, 401));
    await cabinetSource({ cookie: COOKIE, environment: { ...ENV, NODE_ENV: "production", MY_CABINET_FIXTURE: "lms" }, send }).profile();
    expect(send).toHaveBeenCalledOnce();
  });

  it("reads only the agreed routes", () => {
    expect(CABINET_ROUTES).toEqual({ profile: "/v1/my/profile", courses: "/v1/my/courses", tickets: "/v1/my/tickets", orders: "/v1/me/orders" });
  });

  it("keeps cabinet code free of analytics, storage and logging", () => {
    const dir = path.join(here, "../components/cabinet");
    for (const file of readdirSync(dir)) {
      expect(readFileSync(path.join(dir, file), "utf8")).not.toMatch(/localStorage|sessionStorage|console\.|sendBeacon|ym\(|dataLayer|gtag/);
    }
  });
});
