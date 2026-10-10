import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateLegalRelease } from "../src/legal-control";
import { decryptAuthEmailPayload } from "../src/auth";
import { applyV2Seed, readV2Catalogue } from "../src/seed";

// Import the real server composition, replacing only its socket and external IO.
// No mock auth/session, payment rail, database, migration or application handler.
const runtime = vi.hoisted(() => ({ db: undefined as Database.Database | undefined, serve: vi.fn() }));
vi.mock("@hono/node-server", () => ({ serve: runtime.serve }));
vi.mock("../src/db", async (load) => {
  const actual = await load<typeof import("../src/db")>();
  return { ...actual, openV2Database: vi.fn(() => {
    runtime.db = actual.openV2Database(":memory:"); return runtime.db;
  }) };
});
import { openV2Database } from "../src/db";

const sha = "a".repeat(40);
const api = "https://api.synthetic.invalid";
const platform = "https://courses.synthetic.invalid";
const ops = "https://ops.refref.ru/readyz";
const canaryOps = "https://canary-ops.refref.ru/readyz";
const relay = "https://email.synthetic.invalid/send";
const serviceToken = "synthetic-service-credential-not-customer-auth";
const outboxKey = Buffer.alloc(32, 9);
const fetcher = vi.fn<typeof fetch>();
const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const options = runtime.serve.mock.calls[0]![0] as { fetch: (r: Request) => Response | Promise<Response> };
  return options.fetch(new Request(new URL(path, api), init));
};
const post = (body: unknown, extra: Record<string, string> = {}): RequestInit => ({
  method: "POST", headers: { "content-type": "application/json", origin: platform, ...extra }, body: JSON.stringify(body),
});
const db = () => runtime.db!;
const boot = async () => {
  await import("../src/server");
  // Better Auth initializes asynchronously; finish it before closing each DB.
  expect((await request("/v1/auth/get-session")).status).toBe(200);
};

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  const environment: Record<string, string | undefined> = {
    NODE_ENV: "production", DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", SOURCE_COMMIT: sha,
    COMMERCE_V2_FOUNDATION_MODE: "false", BUILD_IDENTITY_FILE: undefined,
    PLATFORM_ORIGIN: platform, LAB_ORIGIN: "https://lab.synthetic.invalid",
    ADMIN_ORIGIN: "https://admin.synthetic.invalid", API_ORIGIN: api,
    MERCHANT_PROMOTION_PREFIX: "FX-", REFREF_READINESS_URL: ops, PLATFORM_SERVICE_TOKEN: serviceToken,
    AUTH_EMAIL_DELIVERY_ENDPOINT: relay, AUTH_EMAIL_DELIVERY_TOKEN: undefined,
    BETTER_AUTH_SECRET: "synthetic-better-auth-secret-only-for-isolated-tests",
    AUTH_EMAIL_OUTBOX_KEY: outboxKey.toString("base64"),
    SMARTCAPTCHA_SERVER_KEY: "synthetic-captcha-key", COMMERCE_SESSION_SECRET: "synthetic-admin-key",
    COMMERCE_ADMIN_PASSWORD_SCRYPT: "synthetic-unused-admin-hash", CAMPAIGN_UNSUBSCRIBE_SECRET: "synthetic-unsubscribe-key",
    MARKETING_BROADCASTS_ENABLED: "false", KINESCOPE_DELIVERY_MODE: "open", KINESCOPE_API_TOKEN: undefined,
    KINESCOPE_DRM_USERNAME: undefined, KINESCOPE_DRM_PASSWORD: undefined,
    KINESCOPE_DRM_TOKEN_CURRENT_KEY: undefined, KINESCOPE_DRM_TOKEN_KEYS: undefined, KINESCOPE_DRM_TOKEN_SECRET: undefined,
    REFUND_ENVELOPE_CURRENT_KEY: undefined, REFUND_ENVELOPE_KEYS: undefined,
  };
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  fetcher.mockImplementation(async (input, options) => {
    const url = String(input);
    if ((url === ops || url === canaryOps) && options?.method === "GET") return Response.json({
      service: "refref-runtime", status: "READY", sourceCommit: sha, checks: { database: true, redis: true },
    });
    if (url === "https://smartcaptcha.cloud.yandex.ru/validate" && options?.method === "POST") return Response.json({ status: "ok" });
    if (url === relay && options?.method === "POST") return Response.json({ accepted: true });
    throw new Error("UNEXPECTED_EXTERNAL_IO");
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  runtime.db?.close(); runtime.db = undefined;
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

describe("ART-162 / ART-179 normal production server, payment disabled", () => {
  it.each([["production", ops], ["staging", canaryOps]])("boots the actual %s application and preserves the unauthenticated read-only ops probe", async (environment, url) => {
    vi.stubEnv("DEPLOY_ENV", environment);
    vi.stubEnv("REFREF_READINESS_URL", url);
    await boot();
    const identity = await request("/identity");
    expect(await identity.json()).toMatchObject({ sourceCommit: sha, service: "commerce-v2" });
    const ready = await request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ foundationMode: false, core: { database: "ok", paymentMode: "disabled" }, capabilities: { refref: "ready" } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toMatchObject([url, { method: "GET", redirect: "error", cache: "no-store", headers: { accept: "application/json" } }]);
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
  });

  it("fails normal readiness when Refref becomes unavailable, without stopping local API or leaking errors", async () => {
    await boot();
    fetcher.mockRejectedValue(new Error("synthetic-sensitive-provider-error"));
    const ready = await request("/readyz");
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ ok: false, foundationMode: false, capabilities: { refref: "unavailable" } });
    expect((await request("/identity")).status).toBe(200);
    const account = await request("/v1/me");
    expect(account.status).toBe(200);
    expect(await account.json()).toEqual({ customer: null });
    expect(account.headers.get("cache-control")).toContain("no-store");
  });

  it.each([undefined, "https://foreign.invalid/readyz"])("refuses invalid production ops configuration before database or server side effects (%s)", async (url) => {
    vi.stubEnv("REFREF_READINESS_URL", url);
    await expect(import("../src/server")).rejects.toThrow(url ? "REFREF_READINESS_URL_NOT_ALLOWED" : "REFREF_READINESS_URL_REQUIRED");
    expect(openV2Database).not.toHaveBeenCalled();
    expect(runtime.serve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["BETTER_AUTH_SECRET", "AUTH_EMAIL_OUTBOX_KEY", "COMMERCE_SESSION_SECRET"])("does not start a normal production server without %s", async (name) => {
    vi.stubEnv(name, undefined);
    await expect(import("../src/server")).rejects.toThrow(name === "COMMERCE_SESSION_SECRET" ? "CONTROL_ROOM_AUTH_CONFIGURATION_REQUIRED" : `${name}_REQUIRED`);
    expect(runtime.serve).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it("exposes authenticated catalog/order APIs with the real seed but refuses all payment entry points", async () => {
    await boot();
    const catalogue = readV2Catalogue();
    const first = applyV2Seed(db(), catalogue); const replay = applyV2Seed(db(), catalogue);
    expect(first.kind).toBe("APPLIED");
    expect(replay).toEqual({ kind: "ALREADY_APPLIED", digest: first.digest });
    expect((await request("/v1/internal/control-room/catalogue")).status).toBe(401);
    for (const path of ["/v1/internal/control-room/catalogue", "/v1/internal/control-room/orders"]) {
      const response = await request(path, { headers: { authorization: `Bearer ${serviceToken}` } });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    }
    for (const path of ["/v1/checkout/preview", "/v1/checkout"]) {
      const response = await request(path, post({ offerRef: "bundle:all-courses" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "PAYMENTS_DISABLED" });
    }
    expect((await request("/v1/checkout/handoff", post({}))).status).toBe(401);
    expect(db().prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });
    expect(db().prepare("SELECT COUNT(*) n FROM checkout_attempts").get()).toEqual({ n: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs real Better Auth consent → encrypted outbox → verification → private customer/order APIs", async () => {
    await boot();
    const hash = "b".repeat(64);
    activateLegalRelease(db(), { storefront: "COURSES", version: "synthetic-stage-a", actor: "test-owner", manifest: {
      stage: "A", documents: ["privacy", "personal_data", "account_terms", "marketing_consent"].map(kind => ({
        kind, version: `${kind}-v1`, sha256: hash, url: `${platform}/legal/${kind}`,
      })),
    } });
    const input = { email: "student@synthetic.invalid", storefront: "COURSES", callbackURL: `${platform}/account`,
      metadata: { storefront: "COURSES" }, personalDataConsent: true, personalDataVersion: "personal_data-v1",
      personalDataSha256: hash, accountTermsVersion: "account_terms-v1", accountTermsSha256: hash,
      marketingConsent: false, marketingDocumentVersion: "marketing_consent-v1", marketingDocumentSha256: hash,
    };
    expect((await request("/v1/auth/sign-in/magic-link", post(input))).status).toBe(422);
    expect(fetcher).not.toHaveBeenCalled();
    const sent = await request("/v1/auth/sign-in/magic-link", post({ ...input, captchaToken: "synthetic-captcha" }));
    expect(sent.status).toBe(200);
    const row = db().prepare("SELECT state,encrypted_payload FROM auth_email_outbox").get() as { state: string; encrypted_payload: string };
    expect(row.state).toBe("SENT"); expect(row.encrypted_payload).not.toContain(input.email);
    const message = decryptAuthEmailPayload(row.encrypted_payload, outboxKey);
    const verified = await request(message.url);
    expect([200, 302]).toContain(verified.status);
    const cookie = verified.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token=");
    for (const path of ["/v1/me", "/v1/me/orders"]) {
      const response = await request(path, { headers: { cookie } });
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
      if (path === "/v1/me") expect(await response.json()).toMatchObject({ customer: { email_normalized: input.email } });
      else expect(await response.json()).toEqual({ orders: [] });
    }
    const handoff = await request("/v1/checkout/handoff", post({}, { cookie }));
    expect(handoff.status).toBe(200); expect(await handoff.json()).toEqual({ required: false });
    const checkout = await request("/v1/checkout", post({ quoteId: "no-quote" }, { cookie }));
    expect(checkout.status).toBe(503); expect(await checkout.json()).toEqual({ code: "PAYMENTS_DISABLED" });
    expect(db().prepare("SELECT COUNT(*) n FROM orders").get()).toEqual({ n: 0 });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(["https://smartcaptcha.cloud.yandex.ru/validate", relay]);
  });
});
