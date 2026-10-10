import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRuntime, decryptAuthEmailPayload } from "../src/auth";
import { createMagicLinkEmailDelivery } from "../src/auth-email-delivery";
import { migrateV2 } from "../src/db";

const environment = {
  NODE_ENV: "test", DEPLOY_ENV: "production",
  AUTH_EMAIL_PROVIDER: "notisend",
  BETTER_AUTH_SECRET: "synthetic-auth-secret-that-is-not-used-in-production",
  AUTH_EMAIL_OUTBOX_KEY: Buffer.alloc(32, 7).toString("base64"),
  PLATFORM_ORIGIN: "https://flexperiment.test", LAB_ORIGIN: "https://lab.flexperiment.test",
  ADMIN_ORIGIN: "https://admin.flexperiment.test", API_ORIGIN: "https://api.flexperiment.test",
  NOTISEND_API_KEY: "synthetic-provider-key", NOTISEND_FROM_EMAIL: "noreply@flexperiment.test",
  NOTISEND_FROM_NAME: "Flexperiment", NOTISEND_REPLY_TO: "support@flexperiment.test",
};
const email = "student@example.test";
const url = "https://flexperiment.test/v1/auth/magic-link/verify?token=synthetic-secret&callbackURL=https%3A%2F%2Fflexperiment.test%2Faccount";
const success = () => Response.json({ status: "queued", id: 4711 });
const requestMock = (response = success()) => vi.fn<typeof fetch>().mockResolvedValue(response);

describe("Better Auth transactional email transport", () => {
  it("uses the fixed NotiSend API, escaped HTML and correlation only without a relay", async () => {
    const request = requestMock();
    const delivery = createMagicLinkEmailDelivery(environment, request);
    expect(delivery.configured).toBe(true);
    await delivery.send({ email, url });
    expect(request).toHaveBeenCalledOnce();
    const [endpoint, options] = request.mock.calls[0];
    expect(endpoint).toBe("https://api.notisend.ru/v1/email/messages");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${environment.NOTISEND_API_KEY}` } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(String(options?.body));
    expect(payload).toMatchObject({ to: email, from_email: environment.NOTISEND_FROM_EMAIL,
      from_name: "Flexperiment", smtp_headers: { "Reply-To": environment.NOTISEND_REPLY_TO } });
    expect(payload.smtp_headers["X-Flexperiment-Auth-Key"]).toMatch(/^[a-f0-9]{64}$/);
    expect(payload).not.toHaveProperty("idempotence_key");
    expect(payload.text).toContain(url);
    expect(payload.html).toContain("&amp;callbackURL=");
    expect(payload).not.toHaveProperty("skip_unsubscribe");
    expect(payload).not.toHaveProperty("force_send");
    expect(payload).not.toHaveProperty("global_metadata");
  });

  it("supports the independent LAB authority", async () => {
    const request = requestMock();
    await createMagicLinkEmailDelivery(environment, request).send({ email, url: url.replace("https://flexperiment.test/", "https://lab.flexperiment.test/") });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([
    "https://foreign.test/v1/auth/magic-link/verify?token=x",
    "https://user:password@flexperiment.test/v1/auth/magic-link/verify?token=x",
    "https://flexperiment.test/not-auth?token=x",
    "https://flexperiment.test/v1/auth/magic-link/verify",
    `${url}#secret`, `${url}\n`, `${url}${"x".repeat(8_192)}`,
  ])("refuses an invalid link before external dispatch (%#)", async (badUrl) => {
    const request = requestMock();
    await expect(createMagicLinkEmailDelivery(environment, request).send({ email, url: badUrl })).rejects.toThrow("AUTH_EMAIL_INPUT_INVALID");
    expect(request).not.toHaveBeenCalled();
  });

  it("requires production credentials and valid sender configuration", () => {
    expect(() => createMagicLinkEmailDelivery({ ...environment, NOTISEND_API_KEY: undefined })).toThrow("NOTISEND_API_KEY_REQUIRED");
    expect(() => createMagicLinkEmailDelivery({ ...environment, NOTISEND_FROM_EMAIL: undefined })).toThrow("NOTISEND_FROM_EMAIL_REQUIRED");
    expect(() => createMagicLinkEmailDelivery({ ...environment, AUTH_EMAIL_PROVIDER: "pretend" })).toThrow("AUTH_EMAIL_PROVIDER_INVALID");
    expect(() => createMagicLinkEmailDelivery({ ...environment, AUTH_EMAIL_PROVIDER: "unisender-go" })).toThrow("AUTH_EMAIL_PROVIDER_INVALID");
    expect(() => createMagicLinkEmailDelivery({ ...environment, NOTISEND_REPLY_TO: undefined })).toThrow("NOTISEND_REPLY_TO_REQUIRED");
    expect(() => createMagicLinkEmailDelivery({ ...environment, NOTISEND_FROM_EMAIL: "not-an-email" })).toThrow("NOTISEND_SENDER_INVALID");
    expect(() => createMagicLinkEmailDelivery({ ...environment, NOTISEND_FROM_NAME: "name\r\nInjected" })).toThrow("NOTISEND_FROM_NAME_INVALID");
  });

  it.each(["queued", "sent", "delivered"])("accepts only documented acceptance states (%s)", async (status) => {
    const request = requestMock(Response.json({ id: "4711", status }));
    await createMagicLinkEmailDelivery(environment, request).send({ email, url });
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps staging image boot possible but does not pretend it can send", async () => {
    const delivery = createMagicLinkEmailDelivery({ DEPLOY_ENV: "staging" });
    expect(delivery.configured).toBe(false);
    await expect(delivery.send({ email, url })).rejects.toThrow("AUTH_EMAIL_NOT_CONFIGURED");
  });

  it.each([
    [408, { errors: [] }, "AUTH_EMAIL_AMBIGUOUS"],
    [500, { errors: [] }, "AUTH_EMAIL_AMBIGUOUS"],
    [429, { errors: [{ detail: url }] }, "AUTH_EMAIL_REJECTED"],
    [400, { errors: [{ detail: email }] }, "AUTH_EMAIL_REJECTED"],
    [200, { errors: [{ detail: environment.NOTISEND_API_KEY }], id: 1, status: "queued" }, "AUTH_EMAIL_REJECTED"],
    [200, { id: 1, status: "skipped" }, "AUTH_EMAIL_REJECTED"],
    [200, { id: 1, status: "hard_bounced" }, "AUTH_EMAIL_REJECTED"],
    [200, { status: "queued" }, "AUTH_EMAIL_AMBIGUOUS"],
    [200, { id: 1, status: "paused" }, "AUTH_EMAIL_AMBIGUOUS"],
    [200, { status: "queued", id: `${url}\n` }, "AUTH_EMAIL_AMBIGUOUS"],
    [200, { status: "queued", id: -1 }, "AUTH_EMAIL_AMBIGUOUS"],
  ])("records only safe refusal, never retries HTTP %s (%#)", async (status, body, code) => {
    const request = requestMock(Response.json(body, { status: Number(status) }));
    const send = createMagicLinkEmailDelivery(environment, request).send;
    await expect(send({ email, url })).rejects.toThrow(String(code));
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["not-json", "x".repeat(16_385), JSON.stringify(["success"]),
    JSON.stringify({ id: 1, status: "queued", padding: "x".repeat(16_384) })])("bounds and rejects unusable provider bodies (%#)", async (body) => {
    const request = requestMock(new Response(body));
    await expect(createMagicLinkEmailDelivery(environment, request).send({ email, url })).rejects.toThrow("AUTH_EMAIL_AMBIGUOUS");
    expect(request).toHaveBeenCalledOnce();
  });

  it("sanitizes reflected transport errors without a second send", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${email} ${url} ${environment.NOTISEND_API_KEY}`));
    await expect(createMagicLinkEmailDelivery(environment, request).send({ email, url })).rejects.toThrow(/^AUTH_EMAIL_AMBIGUOUS$/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("retains explicit HTTP relay compatibility with sanitized failures", async () => {
    const request = requestMock();
    const delivery = createMagicLinkEmailDelivery({ ...environment, AUTH_EMAIL_PROVIDER: "http-relay",
      AUTH_EMAIL_DELIVERY_ENDPOINT: "https://relay.test/auth", AUTH_EMAIL_DELIVERY_TOKEN: "synthetic-relay-key" }, request);
    await delivery.send({ email, url });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({ type: "MAGIC_LINK", recipientEmail: email, url });
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer synthetic-relay-key" });
    expect(() => createMagicLinkEmailDelivery({ ...environment, AUTH_EMAIL_PROVIDER: "http-relay",
      AUTH_EMAIL_DELIVERY_ENDPOINT: "http://relay.test" })).toThrow("AUTH_EMAIL_DELIVERY_ENDPOINT_INVALID");
  });
});

describe("real Better Auth callback + encrypted outbox", () => {
  let db: Database.Database | undefined;
  afterEach(() => { db?.close(); vi.restoreAllMocks(); });

  it.each([true, false])("uses transport inside the plugin and persists the safe outcome (accepted=%s)", async (accepted) => {
    db = new Database(":memory:");
    db.pragma("foreign_keys=ON"); migrateV2(db);
    const request = accepted ? requestMock() : vi.fn<typeof fetch>().mockRejectedValue(new Error(`${email} ${url} ${environment.NOTISEND_API_KEY}`));
    const runtime = createAuthRuntime({ db, environment, sendMagicLinkEmail: createMagicLinkEmailDelivery(environment, request).send });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await runtime.auth.handler(new Request("https://api.flexperiment.test/v1/auth/sign-in/magic-link", {
      method: "POST", headers: { "content-type": "application/json", origin: "https://flexperiment.test" },
      body: JSON.stringify({ email, callbackURL: "https://flexperiment.test/account", metadata: { storefront: "COURSES" } }),
    }));
    expect(response.status).toBe(accepted ? 200 : 500);
    expect(request).toHaveBeenCalledOnce();
    const row = db.prepare("SELECT state,attempt_count,last_error,encrypted_payload FROM auth_email_outbox").get() as {
      state: string; attempt_count: number; last_error: string | null; encrypted_payload: string;
    };
    expect(row).toMatchObject({ state: accepted ? "SENT" : "FAILED", attempt_count: 1,
      last_error: accepted ? null : "AUTH_EMAIL_AMBIGUOUS" });
    expect(row.encrypted_payload).not.toContain(email);
    const message = decryptAuthEmailPayload(row.encrypted_payload, runtime.outboxKey);
    expect(message.email).toBe(email);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(environment.NOTISEND_API_KEY);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("synthetic-secret");
    if (accepted) {
      const verified = await runtime.auth.handler(new Request(message.url, { redirect: "manual" }));
      expect([200, 302]).toContain(verified.status);
      expect(db.prepare('SELECT email_verified FROM "user" WHERE email=?').get(email)).toEqual({ email_verified: 1 });
    }
  });
});
