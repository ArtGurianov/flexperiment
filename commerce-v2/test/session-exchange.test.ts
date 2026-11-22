import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { createAuthRuntime } from "../src/auth";
import { migrateV2 } from "../src/db";
import { activateLegalRelease } from "../src/legal-control";
import { loadMyIdentityConfig } from "../src/my-session";
import { createMyOtp } from "../src/my-session-otp";
import { loadCommerceOrigins } from "../src/origins";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { createSessionExchange, EXCHANGE_STATE_PREFIX } from "../src/session-exchange";
import { stageALegalManifest } from "./fixtures/legal";

// FLEX-121: real Better Auth MY sessions + Commerce exchange + Hono app (fixture exchange.json).
const environment = {
  NODE_ENV: "test", BETTER_AUTH_SECRET: "isolated-my-exchange-auth-secret-32-chars",
  PLATFORM_ORIGIN: "https://flexperiment.test", LAB_ORIGIN: "https://lab.flexperiment.test",
  ADMIN_ORIGIN: "https://admin.flexperiment.test", API_ORIGIN: "https://api.flexperiment.test",
  MY_ORIGIN: "https://my.flexperiment.test", MY_IDENTITY_MODE: "on",
};
const MY = "my.flexperiment.test"; const LMS = "flexperiment.test";
const MY_ORIGIN = "https://my.flexperiment.test"; const LMS_ORIGIN = "https://flexperiment.test";
const consent = {
  personalDataConsent: true, accountTermsAccepted: true, marketingConsent: false,
  personalDataVersion: "personal_data-v1", personalDataSha256: "a".repeat(64),
  accountTermsVersion: "account_terms-v1", accountTermsSha256: "a".repeat(64),
  marketingDocumentVersion: "marketing_consent-v1", marketingDocumentSha256: "a".repeat(64),
};

let db: Database.Database; let mail: Array<{ email: string; code: string }>; let clock: Date;
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  activateLegalRelease(db, { storefront: "COURSES", version: "isolated-fixture-only", manifest: stageALegalManifest, actor: "isolated-test" });
  mail = []; clock = new Date();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function build() {
  const origins = loadCommerceOrigins(environment);
  const myIdentity = loadMyIdentityConfig(environment, origins);
  const runtime = createAuthRuntime({ db, environment, myIdentity, sendMagicLinkEmail: async () => undefined,
    sendMyOtpEmail: async (message) => { mail.push(message); } });
  const exchange = createSessionExchange({ db, now: () => clock });
  return createCommerceV2App({ db, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service",
    config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" }), origins, myIdentity,
    authHandler: runtime.auth.handler, authenticateCustomer: runtime.authenticateCustomer, resolveSession: runtime.resolveSession,
    myOtp: createMyOtp({ db, api: runtime.auth.api, accountLegalStorefront: "COURSES" }),
    signOutMySession: (headers) => runtime.auth.api.signOut({ headers, asResponse: true }), sessionExchange: exchange });
}
type App = ReturnType<typeof build>;
let ip = 0;
const call = (app: App, host: string, path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {}) =>
  app.request(path, { method: init.method ?? (init.body !== undefined ? "POST" : "GET"), headers: {
    "x-forwarded-host": host, "x-forwarded-for": `10.1.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, "content-type": "application/json",
    ...(init.origin === null || init.origin === undefined ? {} : { origin: init.origin }), ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
const pairs = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
const jar = (...cookies: Array<string | undefined>) => cookies.filter(Boolean).join("; ");

/** A browser: one cookie string per host. */
class Browser {
  my = ""; lms = "";
  constructor(readonly app: App) {}
  private merge(current: string, response: Response) {
    const map = new Map(current.split("; ").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair] as const));
    for (const pair of pairs(response)) {
      const name = pair.slice(0, pair.indexOf("="));
      if (pair.endsWith("=")) map.delete(name); else map.set(name, pair);
    }
    return [...map.values()].join("; ");
  }
  async signIn(email: string) {
    await call(this.app, MY, "/v1/my/otp/send", { body: { email, ...consent }, origin: MY_ORIGIN });
    const code = mail.filter((message) => message.email === email).at(-1)!.code;
    const response = await call(this.app, MY, "/v1/my/otp/verify", { body: { email, otp: code }, origin: MY_ORIGIN, cookie: this.my });
    expect(response.status).toBe(200);
    this.my = this.merge(this.my, response);
    db.prepare("UPDATE my_otp_outbox SET created_at=datetime('now','-1 hour')").run();
  }
  async start(next = "/courses/flex-basics/lessons/intro") {
    const response = await call(this.app, LMS, "/v1/lms/exchange/start", { body: { next }, cookie: this.lms });
    const body = await response.json() as { location?: string; code?: string };
    if (response.ok) this.lms = this.merge(this.lms, response);
    return { status: response.status, body, tx: body.location ? new URL(body.location).searchParams.get("tx")! : "" };
  }
  async issue(tx: string) {
    const response = await call(this.app, MY, `/v1/my/exchange/${tx}/issue`, { method: "POST", origin: MY_ORIGIN, cookie: this.my });
    return { status: response.status, body: await response.json() as { code?: string; redeemUrl?: string } };
  }
  async redeem(tx: string, code: string, origin: string | null = MY_ORIGIN, cookie = this.lms) {
    const response = await call(this.app, LMS, "/v1/lms/exchange/redeem", { body: { tx, code }, origin, cookie });
    const body = await response.json() as { location?: string; code?: string };
    if (response.ok) this.lms = this.merge(this.lms, response);
    return { status: response.status, body, cookies: response.headers.getSetCookie() };
  }
  library() { return call(this.app, LMS, "/v1/me/course-library", { cookie: this.lms }); }
}
const status = (tx: string) => (db.prepare("SELECT status FROM session_exchanges WHERE id=?").get(tx) as { status: string } | undefined)?.status;

describe("FLEX-121 exchange happy path and session shape", () => {
  it("creates a separate host-only LMS session for the confirmed customer without a second e-mail", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const started = await browser.start();
    expect(started.status).toBe(200);
    expect(started.body.location).toBe(`${MY_ORIGIN}/continue?tx=${started.tx}`);
    expect(browser.lms).toContain(`${EXCHANGE_STATE_PREFIX}${started.tx}=`);
    const described = await (await call(app, MY, `/v1/my/exchange/${started.tx}`, { cookie: browser.my })).json();
    expect(described).toEqual({ status: "STARTED", target: { surface: "LMS", path: "/courses/flex-basics/lessons/intro" }, signedIn: true });
    const issued = await browser.issue(started.tx);
    expect(issued.body.redeemUrl).toBe(`${LMS_ORIGIN}/auth/lms/redeem`);
    expect(mail).toHaveLength(1);
    const redeemed = await browser.redeem(started.tx, issued.body.code!);
    expect(redeemed).toMatchObject({ status: 200, body: { location: "/courses/flex-basics/lessons/intro" } });
    const lmsCookie = redeemed.cookies.find((cookie) => cookie.startsWith("__Host-flx-lms="))!;
    expect(lmsCookie).toMatch(/Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
    expect(lmsCookie).not.toMatch(/Domain/i);
    expect(redeemed.cookies).toContain(`${EXCHANGE_STATE_PREFIX}${started.tx}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    expect(status(started.tx)).toBe("REDEEMED");
    expect((await browser.library()).status).not.toBe(401);
    // The LMS credential gives no access to my or checkout; the MY credential none to the LMS.
    expect(await (await call(app, MY, "/v1/my/session", { cookie: browser.lms })).json()).toEqual({ signedIn: false });
    expect((await call(app, MY, "/v1/me/orders", { cookie: browser.lms })).status).toBe(401);
    expect((await call(app, LMS, "/v1/me/course-library", { cookie: browser.my })).status).toBe(401);
    const stored = db.prepare("SELECT token_sha256,parent_session_id FROM lms_sessions").get() as { token_sha256: string; parent_session_id: string };
    expect(stored.token_sha256).not.toBe(lmsCookie.split(";")[0].split("=")[1]);
    expect(db.prepare('SELECT audience FROM "session" WHERE id=?').get(stored.parent_session_id)).toEqual({ audience: "MY" });
  });
});

describe("FLEX-121 refusals (fixture exchange.json)", () => {
  it("missing or wrong browser state refuses without burning; the right browser still succeeds", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const { tx } = await browser.start();
    const { body: { code } } = await browser.issue(tx);
    // Attacker knows tx (from history), forges Origin, has no state.
    expect((await browser.redeem(tx, code!, MY_ORIGIN, "")).body).toEqual({ code: "EXCHANGE_STATE_MISSING" });
    const other = new Browser(app); await other.start();
    expect((await browser.redeem(tx, code!, MY_ORIGIN, other.lms.replace(/__Host-flx-lms-x-[A-Za-z0-9_-]{22}/, `${EXCHANGE_STATE_PREFIX}${tx}`))).body)
      .toEqual({ code: "EXCHANGE_STATE_MISMATCH" });
    expect(status(tx)).toBe("ISSUED");
    expect((await browser.redeem(tx, code!)).status).toBe(200);
  });

  it("with the right state, a wrong or expired code burns the exchange; a replay is closed", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const first = await browser.start();
    await browser.issue(first.tx);
    expect((await browser.redeem(first.tx, "x".repeat(43))).body).toEqual({ code: "EXCHANGE_CODE_MISMATCH" });
    expect(status(first.tx)).toBe("FAILED");
    clock = new Date(clock.getTime() + 31_000);
    const second = await browser.start();
    const { body: { code } } = await browser.issue(second.tx);
    clock = new Date(clock.getTime() + 61_000);
    expect((await browser.redeem(second.tx, code!)).body).toEqual({ code: "EXCHANGE_CODE_EXPIRED" });
    clock = new Date(clock.getTime() + 31_000);
    const third = await browser.start();
    const issued = await browser.issue(third.tx);
    expect((await browser.redeem(third.tx, issued.body.code!)).status).toBe(200);
    expect((await browser.redeem(third.tx, issued.body.code!)).body).toEqual({ code: "EXCHANGE_STATE_MISSING" });
    const stateless = await call(app, LMS, "/v1/lms/exchange/redeem", { body: { tx: third.tx, code: issued.body.code },
      origin: MY_ORIGIN, cookie: `${EXCHANGE_STATE_PREFIX}${third.tx}=${"A".repeat(43)}` });
    expect(await stateless.json()).toEqual({ code: "EXCHANGE_STATE_MISMATCH" });
  });

  it("an exchange expires after 600 s; Origin and surface are exact", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const { tx } = await browser.start();
    const { body: { code } } = await browser.issue(tx);
    expect((await browser.redeem(tx, code!, LMS_ORIGIN)).body).toEqual({ code: "ORIGIN_FORBIDDEN" });
    expect((await browser.redeem(tx, code!, null)).body).toEqual({ code: "ORIGIN_REQUIRED" });
    expect((await call(app, MY, "/v1/lms/exchange/redeem", { body: { tx, code }, origin: MY_ORIGIN, cookie: browser.lms })).status).toBe(404);
    expect((await call(app, LMS, `/v1/my/exchange/${tx}/issue`, { method: "POST", origin: MY_ORIGIN, cookie: browser.my })).status).toBe(404);
    expect(status(tx)).toBe("ISSUED");
    clock = new Date(clock.getTime() + 601_000);
    expect((await browser.issue(tx)).body).toEqual({ code: "EXCHANGE_EXPIRED" });
    expect((await browser.redeem(tx, code!)).body).toEqual({ code: "EXCHANGE_EXPIRED" });
  });

  it("issue needs a MY session; the anti-loop asks for a manual retry after a failure", async () => {
    const app = build(); const browser = new Browser(app);
    const { tx } = await browser.start();
    expect(await browser.issue(tx)).toEqual({ status: 401, body: { code: "SIGN_IN_REQUIRED" } });
    expect(await (await call(app, MY, `/v1/my/exchange/${tx}`)).json()).toMatchObject({ status: "STARTED", signedIn: false });
    await browser.signIn("buyer@example.test");
    await browser.issue(tx);
    await browser.redeem(tx, "y".repeat(43));
    expect(await browser.start()).toMatchObject({ status: 409, body: { code: "EXCHANGE_RECENTLY_FAILED" } });
    clock = new Date(clock.getTime() + 31_000);
    expect((await browser.start()).status).toBe(200);
  });

  it("cancel on my closes the exchange", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const { tx } = await browser.start();
    expect((await call(app, MY, `/v1/my/exchange/${tx}/cancel`, { method: "POST", origin: MY_ORIGIN })).status).toBe(204);
    expect(await browser.issue(tx)).toEqual({ status: 409, body: { code: "EXCHANGE_CLOSED" } });
  });
});

describe("FLEX-121 concurrency and account boundaries", () => {
  it("two tabs in one browser both finish; a forced start never overwrites a state; a fourth start evicts the oldest", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const a = await browser.start("/courses/a"); const b = await browser.start("/courses/b");
    const codeA = (await browser.issue(a.tx)).body.code!; const codeB = (await browser.issue(b.tx)).body.code!;
    expect((await browser.redeem(b.tx, codeB)).body).toEqual({ location: "/courses/b" });
    expect((await browser.redeem(a.tx, codeA)).body).toEqual({ location: "/courses/a" });
    expect(db.prepare("SELECT COUNT(*) n FROM lms_sessions").get()).toEqual({ n: 1 });
    const one = await browser.start("/courses/one"); await browser.start("/courses/two"); await browser.start("/courses/three");
    const response = await call(app, LMS, "/v1/lms/exchange/start", { body: { next: "/courses/four" }, cookie: browser.lms });
    expect(response.headers.getSetCookie()).toContain(`${EXCHANGE_STATE_PREFIX}${one.tx}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  });

  it("parallel double redeem: exactly one LMS session", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const { tx } = await browser.start();
    const { body: { code } } = await browser.issue(tx);
    const results = await Promise.all([browser.redeem(tx, code!), browser.redeem(tx, code!)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(db.prepare("SELECT COUNT(*) n FROM lms_sessions").get()).toEqual({ n: 1 });
  });

  it("account switch: before issue re-binds, after issue the old exchange dies; no rights of the previous account", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("first@example.test");
    const early = await browser.start();
    await browser.signIn("second@example.test");
    const earlyCode = (await browser.issue(early.tx)).body.code!;
    expect((await browser.redeem(early.tx, earlyCode)).status).toBe(200);
    const second = db.prepare("SELECT id FROM customers WHERE email_normalized='second@example.test'").pluck().get();
    expect(db.prepare("SELECT customer_id FROM lms_sessions").pluck().get()).toBe(second);
    clock = new Date(clock.getTime() + 1000);
    const late = await browser.start();
    const lateCode = (await browser.issue(late.tx)).body.code!;
    await browser.signIn("first@example.test");
    expect((await browser.redeem(late.tx, lateCode)).body).toEqual({ code: "EXCHANGE_NOT_FOUND" });
    expect((await browser.library()).status).toBe(401);
  });

  it("MY sign-out or expiry revokes derived LMS sessions; LMS sign-out ends my; single revocation keeps MY", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const exchange = createSessionExchange({ db, now: () => clock });
    const redeemOnce = async () => { const { tx } = await browser.start(); const { body: { code } } = await browser.issue(tx); await browser.redeem(tx, code!); };
    await redeemOnce();
    expect((await browser.library()).status).not.toBe(401);
    db.prepare(`UPDATE "session" SET expires_at=?`).run(new Date(Date.now() - 1000).toISOString());
    expect((await browser.library()).status).toBe(401);
    await browser.signIn("buyer@example.test"); await redeemOnce();
    const lmsId = db.prepare("SELECT id FROM lms_sessions").pluck().get() as string;
    expect(exchange.revokeLmsSession(lmsId)).toBe(true);
    expect((await browser.library()).status).toBe(401);
    expect(await (await call(app, MY, "/v1/my/session", { cookie: browser.my })).json()).toMatchObject({ signedIn: true });
    await redeemOnce();
    expect((await call(app, LMS, "/v1/lms/sign-out", { method: "POST", origin: MY_ORIGIN, cookie: browser.lms })).status).toBe(403);
    const out = await call(app, LMS, "/v1/lms/sign-out", { method: "POST", origin: LMS_ORIGIN, cookie: browser.lms });
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toContain("__Host-flx-lms=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    expect((await browser.library()).status).toBe(401);
    expect(await (await call(app, MY, "/v1/my/session", { cookie: browser.my })).json()).toEqual({ signedIn: false });
    await browser.signIn("buyer@example.test"); await redeemOnce();
    expect((await call(app, MY, "/v1/my/sign-out", { method: "POST", origin: MY_ORIGIN, cookie: browser.my })).status).toBe(204);
    expect((await browser.library()).status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) n FROM lms_sessions").get()).toEqual({ n: 0 });
  });

  it("the LMS session never outlives the MY session that issued it", async () => {
    const app = build(); const browser = new Browser(app);
    await browser.signIn("buyer@example.test");
    const soon = new Date(clock.getTime() + 3_600_000).toISOString();
    const { tx } = await browser.start(); const { body: { code } } = await browser.issue(tx);
    db.prepare('UPDATE "session" SET expires_at=?').run(soon);
    const redeemed = await browser.redeem(tx, code!);
    expect(redeemed.cookies.find((cookie) => cookie.startsWith("__Host-flx-lms="))).toMatch(/Max-Age=3600$/);
    expect(db.prepare("SELECT expires_at FROM lms_sessions").pluck().get()).toBe(soon);
    expect(jar()).toBe("");
  });
});
