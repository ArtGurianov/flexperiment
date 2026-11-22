import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  cabinetLinks, createNavbarSession, parseNavbarSession, safeLmsReturnPath, signInHref,
  type NavbarConfig, type NavbarState,
} from "../../../lib/navbar/navbar-core";
import fixtures from "./fixtures/navbar-sessions.json";

const here = path.dirname(fileURLToPath(import.meta.url));
const LMS = fixtures.config.LMS as NavbarConfig;
const LAB = fixtures.config.LAB as NavbarConfig;
const LAB_LATER = fixtures.config.LAB_ATTACHED_LATER as NavbarConfig;
const json = (body: unknown, status = 200) => Response.json(body, { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("FLEX-123 Navbar core", () => {
  it("narrows both profile answers to the closed view", () => {
    expect(parseNavbarSession(fixtures.answers.lmsNamed)).toEqual({ kind: "signed-in",
      profile: { displayName: "Курсант", emailMasked: "b***@e***.test" } });
    expect(parseNavbarSession(fixtures.answers.labUnnamed)).toEqual({ kind: "signed-in",
      profile: { displayName: null, emailMasked: "l***@e***.test" } });
    expect(parseNavbarSession(fixtures.answers.signedOut)).toEqual({ kind: "guest" });
  });

  it("never surfaces a full e-mail, customer id or legacy /v1/me shape", () => {
    expect(parseNavbarSession(fixtures.answers.leakyLegacy)).toBeNull();
    const unmasked = parseNavbarSession(fixtures.answers.unmaskedEmail);
    expect(unmasked).toEqual({ kind: "signed-in", profile: { displayName: null, emailMasked: null } });
    expect(JSON.stringify(unmasked)).not.toContain("buyer@example.test");
    expect(JSON.stringify(unmasked)).not.toContain("cus_fixture");
    expect(parseNavbarSession({ signedIn: true, displayName: "buyer@example.test" }))
      .toEqual({ kind: "signed-in", profile: { displayName: null, emailMasked: null } });
  });

  it("links to concrete my pages without recipient or e-mail", () => {
    const links = cabinetLinks("https://my.flexperiment.test");
    expect(links.map((link) => [link.label, link.href])).toEqual([
      ["Личный кабинет", "https://my.flexperiment.test/"],
      ["Мои курсы", "https://my.flexperiment.test/courses"],
      ["Мои билеты", "https://my.flexperiment.test/tickets"],
    ]);
    for (const link of links) expect(new URL(link.href).search).toBe("");
  });

  it("keeps only allowlisted LMS return paths for the guest action", () => {
    expect(signInHref(LMS, "/courses/flex-basics/lessons/intro")).toBe("/auth/lms/start?next=%2Fcourses%2Fflex-basics%2Flessons%2Fintro");
    expect(signInHref(LMS, "/")).toBe("/auth/lms/start");
    for (const bad of ["//evil.test", "/courses/../v1", "/auth/lms/start", "/courses/a?x=1", "/v1/me", "/courses/A%2f"]) {
      expect(safeLmsReturnPath(bad)).toBeNull();
    }
    expect(signInHref(LAB, "/ticket/abc")).toBe("https://my.flexperiment.test/sign-in");
  });

  it("does not let a late answer restore the e-mail after sign-out", async () => {
    const states: NavbarState[] = [];
    const late = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "POST") return new Response(null, { status: 204 });
      return url && fetcher.mock.calls.length === 1 ? json(fixtures.answers.lmsNamed) : late.promise;
    });
    const session = createNavbarSession(LMS, { fetcher, pageOrigin: "https://flexperiment.test", onChange: (s) => states.push(s) });
    await session.check();
    expect(session.current().kind).toBe("signed-in");
    const pending = session.check(); // e.g. focus re-check still in flight
    await expect(session.signOut()).resolves.toBe(true);
    late.resolve(json(fixtures.answers.lmsNamed));
    await pending;
    expect(session.current()).toEqual({ kind: "guest" });
    expect(states.at(-1)).toEqual({ kind: "guest" });
  });

  it("drops the profile when a re-check finds the session revoked or the check fails", async () => {
    let answer: () => Promise<Response> = async () => json(fixtures.answers.labUnnamed);
    const session = createNavbarSession(LAB_LATER, { fetcher: () => answer(), pageOrigin: "https://lab.flexperiment.test", onChange: () => {} });
    await session.check();
    expect(session.current().kind).toBe("signed-in");
    answer = async () => json({ code: "SIGN_IN_REQUIRED" }, 401);
    await session.check();
    expect(session.current()).toEqual({ kind: "guest" });
    answer = async () => json(fixtures.answers.labUnnamed);
    await session.check();
    answer = async () => { throw new TypeError("network"); };
    await session.check();
    expect(session.current()).toEqual({ kind: "unavailable" });
  });

  it("LMS stays same-origin: no cross-origin credentials, no extra headers", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST" ? new Response(null, { status: 204 }) : json(fixtures.answers.lmsNamed));
    const lms = createNavbarSession(LMS, { fetcher, pageOrigin: "https://flexperiment.test", onChange: () => {} });
    await lms.check(); await lms.signOut();
    expect(fetcher.mock.calls.map(([url, init]) => [url, init.method, init.credentials])).toEqual([
      ["/v1/me", "GET", "same-origin"], ["/v1/lms/sign-out", "POST", "same-origin"]]);
    expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({ cache: "no-store" }));
    expect(fetcher.mock.calls[1][1].headers).toEqual({});
  });

  it("LAB guest-only mode makes no request and offers no sign-out", async () => {
    const fetcher = vi.fn();
    const lab = createNavbarSession(LAB, { fetcher, pageOrigin: "https://lab.flexperiment.test", onChange: () => {} });
    await lab.check();
    expect(lab.current()).toEqual({ kind: "guest" });
    await expect(lab.signOut()).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a failed sign-out without showing the old profile", async () => {
    const session = createNavbarSession(LMS, {
      fetcher: async (_u, init) => init.method === "POST" ? json({ code: "ORIGIN_FORBIDDEN" }, 403) : json(fixtures.answers.lmsNamed),
      pageOrigin: "https://flexperiment.test", onChange: () => {},
    });
    await session.check();
    await expect(session.signOut()).resolves.toBe(false);
    expect(session.current()).toEqual({ kind: "unavailable" });
  });

  it("never persists or logs profile data", () => {
    for (const file of ["../../../lib/navbar/navbar-core.ts", "../../../lib/navbar/NavbarProfile.tsx",
      "../components/navbar/Navbar.tsx", "../../lab-v2/components/navbar/Navbar.tsx"]) {
      const source = readFileSync(path.join(here, file), "utf8");
      expect(source).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\.|sendBeacon|ym\(|dataLayer|indexedDB/);
    }
  });

  it("shared core never binds to one app's Next.js instance", () => {
    for (const file of ["navbar-core.ts", "NavbarProfile.tsx"]) {
      expect(readFileSync(path.join(here, "../../../lib/navbar", file), "utf8")).not.toMatch(/from "next\//);
    }
  });
});
