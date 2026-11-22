import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { createAuthRuntime } from "../src/auth";
import { migrateV2 } from "../src/db";
import { activateLegalRelease } from "../src/legal-control";
import { loadMyIdentityConfig, sameSite } from "../src/my-session";
import { createMyOtp } from "../src/my-session-otp";
import { verificationSubjectEmail } from "../src/my-session-storage";
import { loadCommerceOrigins } from "../src/origins";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { stageALegalManifest } from "./fixtures/legal";

// FLEX-120: real Better Auth 1.7.6 emailOTP, SQLite and the Commerce Hono app; fake mail only.
const environment = {
  NODE_ENV: "test", BETTER_AUTH_SECRET: "isolated-my-identity-auth-secret-32-chars",
  PLATFORM_ORIGIN: "https://flexperiment.test", LAB_ORIGIN: "https://lab.flexperiment.test",
  ADMIN_ORIGIN: "https://admin.flexperiment.test", API_ORIGIN: "https://api.flexperiment.test",
  MY_ORIGIN: "https://my.flexperiment.test", MY_IDENTITY_MODE: "on",
};
const MY = "my.flexperiment.test";
const LMS = "flexperiment.test";
const consent = {
  personalDataConsent: true, accountTermsAccepted: true, marketingConsent: false,
  personalDataVersion: "personal_data-v1", personalDataSha256: "a".repeat(64),
  accountTermsVersion: "account_terms-v1", accountTermsSha256: "a".repeat(64),
  marketingDocumentVersion: "marketing_consent-v1", marketingDocumentSha256: "a".repeat(64),
};

let db: Database.Database;
let mail: Array<{ email: string; code: string }>;
let logs: string[];
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateV2(db);
  activateLegalRelease(db, { storefront: "COURSES", version: "isolated-fixture-only", manifest: stageALegalManifest, actor: "isolated-test" });
  mail = []; logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  }
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

function build(overrides: Record<string, string> = {}, options: { legal?: boolean; now?: () => Date } = {}) {
  const env = { ...environment, ...overrides };
  const origins = loadCommerceOrigins(env);
  const myIdentity = loadMyIdentityConfig(env, origins);
  const runtime = createAuthRuntime({ db, environment: env, myIdentity, sendMagicLinkEmail: async () => undefined,
    sendMyOtpEmail: async (message) => { mail.push(message); } });
  const app = createCommerceV2App({ db, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service",
    config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" }), origins, myIdentity,
    authHandler: runtime.auth.handler, authenticateCustomer: runtime.authenticateCustomer, resolveSession: runtime.resolveSession,
    myOtp: createMyOtp({ db, api: runtime.auth.api, accountLegalStorefront: options.legal === false ? undefined : "COURSES", now: options.now }),
    signOutMySession: (headers) => runtime.auth.api.signOut({ headers, asResponse: true }) });
  return { app, runtime };
}
type App = ReturnType<typeof build>["app"];
let ip = 0;
const call = (app: App, host: string, path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {}) =>
  app.request(path, { method: init.method ?? (init.body ? "POST" : "GET"), headers: {
    "x-forwarded-host": host, "x-forwarded-for": `10.0.${Math.floor(ip / 250)}.${(ip++ % 250) + 1}`, "content-type": "application/json",
    ...(init.origin === null ? {} : { origin: init.origin ?? `https://${host}` }), ...(init.cookie ? { cookie: init.cookie } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined });
const cookieOf = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
async function signIn(app: App, email: string, cookie?: string) {
  expect((await call(app, MY, "/v1/my/otp/send", { body: { email, ...consent } })).status).toBe(202);
  const code = mail.filter((message) => message.email === email.toLowerCase()).at(-1)!.code;
  const response = await call(app, MY, "/v1/my/otp/verify", { body: { email, otp: code, next: "/orders" }, cookie });
  expect(response.status).toBe(200);
  return { response, cookie: cookieOf(response), body: await response.json() as { accountCreated: boolean; next: string } };
}

describe("FLEX-120 MY OTP sign-in", () => {
  it("first sign-in creates the account, sets a host-only MY cookie and never returns the session token", async () => {
    const { app } = build();
    const { response, cookie, body } = await signIn(app, "Buyer@Example.test");
    expect(body).toEqual({ accountCreated: true, next: "/orders" });
    const [setCookie] = response.headers.getSetCookie();
    expect(setCookie).toMatch(/HttpOnly/i); expect(setCookie).toMatch(/Secure/i); expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(JSON.stringify(body)).not.toMatch(/token/i);
    expect(db.prepare('SELECT audience FROM "session"').all()).toEqual([{ audience: "MY" }]);
    const session = await call(app, MY, "/v1/my/session", { cookie });
    expect(await session.json()).toEqual({ signedIn: true, emailMasked: "b***@e***.test", consentRequired: true });
    expect(db.prepare("SELECT state FROM my_otp_outbox").all()).toEqual([{ state: "SENT" }]);
  });

  it("a returning sign-in reuses the confirmed customer_id and revokes the previous MY session in this browser", async () => {
    const { app } = build();
    const first = await signIn(app, "buyer@example.test");
    const customers = db.prepare("SELECT id FROM customers").all();
    db.prepare("UPDATE my_otp_outbox SET created_at=datetime('now','-1 hour')").run();
    const second = await signIn(app, "buyer@example.test", first.cookie);
    expect(second.body.accountCreated).toBe(false);
    expect(db.prepare("SELECT id FROM customers").all()).toEqual(customers);
    expect(db.prepare('SELECT COUNT(*) n FROM "session"').get()).toEqual({ n: 1 });
    expect(await (await call(app, MY, "/v1/my/session", { cookie: first.cookie })).json()).toEqual({ signedIn: false });
  });

  it("switching account in the same browser leaves no access to the previous account", async () => {
    const { app } = build();
    const first = await signIn(app, "first@example.test");
    const second = await signIn(app, "second@example.test", first.cookie);
    expect(await (await call(app, MY, "/v1/my/session", { cookie: first.cookie })).json()).toEqual({ signedIn: false });
    const profile = await (await call(app, MY, "/v1/my/profile", { cookie: second.cookie })).json() as { email: string };
    expect(profile.email).toBe("second@example.test");
  });

  it("answers identically for new, existing and throttled addresses; cooldown and windows hold", async () => {
    const { app } = build();
    await signIn(app, "known@example.test");
    const answers = [];
    for (const email of ["new@example.test", "known@example.test", "known@example.test"]) {
      const response = await call(app, MY, "/v1/my/otp/send", { body: { email, ...consent } });
      answers.push([response.status, await response.json()]);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(mail.filter((message) => message.email === "known@example.test")).toHaveLength(1);
    expect(mail.filter((message) => message.email === "new@example.test")).toHaveLength(1);
  });

  it("burns a code after five wrong attempts and refuses a replayed code", async () => {
    const { app } = build();
    expect((await call(app, MY, "/v1/my/otp/send", { body: { email: "buyer@example.test", ...consent } })).status).toBe(202);
    const { code } = mail[0];
    const wrong = code === "000000" ? "111111" : "000000";
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await call(app, MY, "/v1/my/otp/verify", { body: { email: "buyer@example.test", otp: wrong } });
      expect([response.status, await response.json()]).toEqual([400, { code: "OTP_INVALID_OR_EXPIRED" }]);
    }
    const burned = await call(app, MY, "/v1/my/otp/verify", { body: { email: "buyer@example.test", otp: code } });
    expect([burned.status, await burned.json()]).toEqual([403, { code: "TOO_MANY_ATTEMPTS" }]);
    expect(db.prepare('SELECT COUNT(*) n FROM "session"').get()).toEqual({ n: 0 });
    db.prepare("UPDATE my_otp_outbox SET created_at=datetime('now','-1 hour')").run();
    const fresh = await signIn(app, "buyer@example.test");
    const replay = await call(app, MY, "/v1/my/otp/verify", { body: { email: "buyer@example.test", otp: mail.at(-1)!.code }, cookie: fresh.cookie });
    expect(replay.status).toBe(400);
  });

  it("an expired code fails safely and stores only the classified hash shape", async () => {
    const { app } = build();
    await call(app, MY, "/v1/my/otp/send", { body: { email: "buyer@example.test", ...consent } });
    const row = db.prepare("SELECT identifier,value FROM verification").get() as { identifier: string; value: string };
    expect(verificationSubjectEmail(row)).toBe("buyer@example.test");
    expect(row.value).not.toContain(mail[0].code);
    db.prepare("UPDATE verification SET expires_at=?").run(new Date(Date.now() - 1000).toISOString());
    const response = await call(app, MY, "/v1/my/otp/verify", { body: { email: "buyer@example.test", otp: mail[0].code } });
    expect([response.status, await response.json()]).toEqual([400, { code: "OTP_INVALID_OR_EXPIRED" }]);
  });

  it("refuses before any persistence: missing consent, missing legal edition, wrong Origin", async () => {
    const { app } = build({}, { legal: true });
    const missing = await call(app, MY, "/v1/my/otp/send", { body: { email: "a@example.test", ...consent, personalDataConsent: false } });
    expect([missing.status, await missing.json()]).toEqual([422, { code: "PERSONAL_DATA_CONSENT_REQUIRED" }]);
    expect((await call(app, MY, "/v1/my/otp/send", { body: { email: "a@example.test", ...consent }, origin: null })).status).toBe(403);
    expect((await call(app, MY, "/v1/my/otp/send", { body: { email: "a@example.test", ...consent }, origin: "https://flexperiment.test" })).status).toBe(403);
    const blocked = build({}, { legal: false }).app;
    const legal = await call(blocked, MY, "/v1/my/otp/send", { body: { email: "a@example.test", ...consent } });
    expect([legal.status, await legal.json()]).toEqual([503, { code: "LEGAL_RELEASE_NOT_FOUND" }]);
    for (const table of ["customers", "account_consents", "verification", "my_otp_outbox"]) {
      expect([table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()]).toEqual([table, { n: 0 }]);
    }
    expect(mail).toEqual([]);
  });

  it("serves the governing account edition to the sign-in form, or nothing while FLEX-125 is open", async () => {
    const { app } = build();
    const legal = await call(app, MY, "/v1/my/legal");
    expect(legal.status).toBe(200);
    expect((await legal.json() as { version: string }).version).toBe("isolated-fixture-only");
    expect((await call(build({}, { legal: false }).app, MY, "/v1/my/legal")).status).toBe(404);
    expect((await call(app, LMS, "/v1/my/legal")).status).toBe(404);
  });

  it("/v1/my/legal is exactly the edition OTP send enforces; a stale edition is refused before persistence", async () => {
    const { app } = build();
    const legal = await (await call(app, MY, "/v1/my/legal")).json() as { version: string; manifestSha256: string;
      manifest: { documents: Array<{ kind: string; version: string; sha256: string }> } };
    const byKind = Object.fromEntries(legal.manifest.documents.map((document) => [document.kind, document]));
    expect([byKind.personal_data.version, byKind.account_terms.version, byKind.marketing_consent.version])
      .toEqual([consent.personalDataVersion, consent.accountTermsVersion, consent.marketingDocumentVersion]);
    expect(legal.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const stale = await call(app, MY, "/v1/my/otp/send", { body: { email: "a@example.test", ...consent, accountTermsVersion: "account_terms-v0" } });
    expect([stale.status, await stale.json()]).toEqual([422, { code: "LEGAL_RELEASE_STALE" }]);
    for (const table of ["customers", "account_consents", "verification", "my_otp_outbox"]) {
      expect([table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()]).toEqual([table, { n: 0 }]);
    }
  });

  it("records the user's exact choices as an authenticated consent action; never a UI flag", async () => {
    const { app } = build();
    const { cookie } = await signIn(app, "buyer@example.test");
    expect((await (await call(app, MY, "/v1/my/session", { cookie })).json() as { consentRequired: boolean }).consentRequired).toBe(true);
    expect(db.prepare("SELECT DISTINCT evidence_status FROM account_consents").all()).toEqual([{ evidence_status: "UNVERIFIED_INTENT" }]);
    const legal = await (await call(app, MY, "/v1/my/legal")).json() as { version: string; manifestSha256: string };
    const status = await (await call(app, MY, "/v1/my/consents", { cookie })).json() as { actionSequence: number };
    const action = { releaseVersion: legal.version, manifestSha256: legal.manifestSha256, actionKey: "my-sign-in-action-0001",
      expectedActionSequence: status.actionSequence, personalDataConsent: true, accountTermsAccepted: true, marketingConsent: true };
    expect((await call(app, MY, "/v1/my/consents", { body: action, cookie, origin: "https://flexperiment.test" })).status).toBe(403);
    expect((await call(app, MY, "/v1/my/consents", { body: { ...action, expectedActionSequence: undefined }, cookie })).status).toBe(422);
    const stale = await call(app, MY, "/v1/my/consents", { body: { ...action, manifestSha256: "f".repeat(64) }, cookie });
    expect([stale.status, await stale.json()]).toEqual([409, { code: "LEGAL_RELEASE_STALE" }]);
    expect((await call(app, MY, "/v1/my/consents", { body: action, cookie })).status).toBe(200);
    expect(db.prepare(`SELECT e.kind,e.granted FROM authenticated_consent_events e JOIN authenticated_consent_actions a ON a.id=e.action_id
      WHERE a.action_key=? ORDER BY e.kind`).all(action.actionKey)).toEqual([
      { kind: "account_terms", granted: 1 }, { kind: "marketing_consent", granted: 1 }, { kind: "personal_data", granted: 1 }]);
    expect(await (await call(app, MY, "/v1/my/session", { cookie })).json()).toMatchObject({ consentRequired: false });
    expect(await (await call(app, MY, "/v1/my/profile", { cookie })).json()).toMatchObject({ marketing: true, consentRequired: false });
    expect((await call(app, MY, "/v1/my/consents", { body: action })).status).toBe(401);
  });

  it("binds the MY session to the confirmed customer: a rebound or unverified account resolves to nothing", async () => {
    const { app } = build();
    const { cookie } = await signIn(app, "buyer@example.test");
    expect((await call(app, MY, "/v1/my/profile", { cookie })).status).toBe(200);
    db.prepare('UPDATE "user" SET email_verified=0').run();
    expect((await call(app, MY, "/v1/my/profile", { cookie })).status).toBe(401);
    db.prepare('UPDATE "user" SET email_verified=1, email=\'other@example.test\'').run();
    expect((await call(app, MY, "/v1/my/profile", { cookie })).status).toBe(401);
  });

  it("sign-out revokes the MY session on the server", async () => {
    const { app } = build();
    const { cookie } = await signIn(app, "buyer@example.test");
    expect((await call(app, MY, "/v1/my/sign-out", { method: "POST", cookie })).status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) n FROM "session"').get()).toEqual({ n: 0 });
    expect(await (await call(app, MY, "/v1/my/session", { cookie })).json()).toEqual({ signedIn: false });
  });

  it("never logs the e-mail, the code or the session cookie", async () => {
    const { app } = build();
    const { cookie } = await signIn(app, "secret-buyer@example.test");
    await call(app, MY, "/v1/my/otp/verify", { body: { email: "secret-buyer@example.test", otp: "999999" } });
    const text = logs.join("\n");
    for (const secret of ["secret-buyer", mail[0].code, cookie.split("=")[1]!]) expect(text).not.toContain(secret);
  });
});

describe("FLEX-120 session audience isolation (mode on)", () => {
  it("a MY session is refused on LMS routes and route groups refuse the other surface", async () => {
    const { app } = build();
    const { cookie } = await signIn(app, "buyer@example.test");
    expect((await call(app, LMS, "/v1/me/course-library", { cookie })).status).toBe(401);
    expect((await call(app, LMS, "/v1/lessons/x/playback", { method: "POST", cookie })).status).toBe(401);
    const checkout = await call(app, LMS, "/v1/checkout", { body: {}, cookie });
    expect([checkout.status, await checkout.json()]).toEqual([403, { code: "SESSION_AUDIENCE_FORBIDDEN" }]);
    const lesson = await call(app, MY, "/v1/lessons/x/playback", { method: "POST", cookie });
    expect([lesson.status, await lesson.json()]).toEqual([403, { code: "SESSION_AUDIENCE_FORBIDDEN" }]);
  });

  it("a LEGACY session is never promoted to MY", async () => {
    const { app } = build();
    const { cookie } = await signIn(app, "buyer@example.test");
    db.prepare('UPDATE "session" SET audience=NULL').run();
    expect(await (await call(app, MY, "/v1/my/session", { cookie })).json()).toEqual({ signedIn: false });
    expect((await call(app, MY, "/v1/my/profile", { cookie })).status).toBe(401);
  });

  it("the OTP plugin and every Better Auth path are closed on the public auth router", async () => {
    const { app } = build();
    for (const path of ["/v1/auth/email-otp/send-verification-otp", "/v1/auth/sign-in/email-otp", "/v1/auth/email-otp/request-password-reset"]) {
      for (const host of [MY, LMS]) expect([host, path, (await call(app, host, path, { body: { email: "a@example.test", type: "sign-in" } })).status]).toEqual([host, path, 404]);
    }
    expect((await call(app, LMS, "/v1/auth/sign-in/magic-link", { body: {} })).status).toBe(410);
    expect((await call(app, LMS, "/v1/my/session")).status).toBe(404);
    expect((await call(app, MY, "/v1/auth/get-session")).status).toBe(404);
  });
});

describe("FLEX-120 mode off is today's behaviour", () => {
  it("keeps Stage A /account sign-in (magic link) working on the LMS until the MY cutover", async () => {
    const { app } = build({ MY_IDENTITY_MODE: "off" });
    const response = await call(app, LMS, "/v1/auth/sign-in/magic-link", { body: { email: "stage-a@example.test",
      callbackURL: "https://flexperiment.test/account", metadata: { storefront: "COURSES" }, storefront: "COURSES", ...consent } });
    expect(response.status).toBe(200);
    expect(db.prepare('SELECT audience FROM "session"').all()).toEqual([]);
    expect((await call(build().app, LMS, "/v1/auth/sign-in/magic-link", { body: {} })).status).toBe(410);
  });

  it("hides /v1/my and the OTP plugin", async () => {
    const { app } = build({ MY_IDENTITY_MODE: "off" });
    expect((await call(app, MY, "/v1/my/otp/send", { body: { email: "a@example.test", ...consent } })).status).toBe(404);
    expect((await call(app, LMS, "/v1/auth/email-otp/send-verification-otp", { body: { email: "a@example.test", type: "sign-in" } })).status).toBe(404);
    expect(mail).toEqual([]);
  });

  it("resolves exactly like today's authenticateCustomer, route by route, for MY and LEGACY sessions", async () => {
    const { app: onApp } = build();
    const { cookie } = await signIn(onApp, "buyer@example.test");
    const off = build({ MY_IDENTITY_MODE: "off" });
    const reference = createCommerceV2App({ db, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service",
      config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" }), origins: loadCommerceOrigins(environment),
      authHandler: off.runtime.auth.handler, authenticateCustomer: off.runtime.legacyAuthenticateCustomer });
    const routes: Array<[string, string]> = [["GET", "/v1/me"], ["GET", "/v1/me/consents?storefront=COURSES&actionKey=abcdefghijklmnop"],
      ["GET", "/v1/me/course-library"], ["GET", "/v1/me/courses/x"], ["GET", "/v1/me/courses/x/lessons/y"], ["GET", "/v1/library"],
      ["GET", "/v1/me/orders"], ["GET", "/v1/refunds"], ["POST", "/v1/lessons/x/playback"], ["PUT", "/v1/lessons/x/resume"]];
    for (const audience of ["MY", null]) {
      db.prepare('UPDATE "session" SET audience=?').run(audience);
      for (const host of [LMS, "lab.flexperiment.test"]) {
        const headers = new Headers({ "x-forwarded-host": host, cookie });
        expect(await off.runtime.authenticateCustomer(headers)).toBe(await off.runtime.legacyAuthenticateCustomer(headers));
        for (const [method, path] of routes) {
          const [actual, expected] = await Promise.all([off.app, reference].map(async (candidate) => {
            const response = await call(candidate, host, path, { method, cookie, body: method === "GET" ? undefined : {} });
            return [response.status, await response.text()];
          }));
          expect([audience, host, method, path, actual]).toEqual([audience, host, method, path, expected]);
        }
      }
    }
  });
});

describe("FLEX-121 same-site invariant", () => {
  it("refuses to start mode on with a cross-site or missing MY origin", () => {
    const fixture = JSON.parse(readFileSync(join(__dirname, "../../docs/plans/fixtures/my-identity/surfaces.json"), "utf8")) as
      { sameSite: { pairs: Array<{ my: string; platform: string; accept: boolean }> } };
    for (const pair of fixture.sameSite.pairs) expect([pair.my, sameSite(pair.my, pair.platform)]).toEqual([pair.my, pair.accept]);
    const origins = loadCommerceOrigins({ ...environment, MY_ORIGIN: "https://my.flexperiment.com" });
    expect(() => loadMyIdentityConfig({ MY_IDENTITY_MODE: "on" }, origins)).toThrow("MY_ORIGIN_NOT_SAME_SITE");
    expect(() => loadMyIdentityConfig({ MY_IDENTITY_MODE: "on" }, loadCommerceOrigins({ ...environment, MY_ORIGIN: "" }))).toThrow("MY_ORIGIN_REQUIRED");
    expect(() => loadMyIdentityConfig({ MY_IDENTITY_MODE: "maybe" }, origins)).toThrow("MY_IDENTITY_MODE_INVALID");
    expect(() => loadCommerceOrigins({ ...environment, MY_ORIGIN: environment.PLATFORM_ORIGIN })).toThrow("MY_ORIGIN_INVALID");
    expect(loadCommerceOrigins({ ...environment, MY_ORIGIN: undefined })).not.toHaveProperty("my");
  });
});
