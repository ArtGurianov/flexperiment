import Database from "better-sqlite3";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";
import { scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { activatePublicSales, qualifyTestFiscalPolicies } from "./fixtures/sales";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { applyCourseManifest, withManifestHash } from "../src/manifest";
import { startVideoUpload } from "../src/kinescope";
import { checkout, MockPaymentRail } from "../src/checkout";
import { controlRoomEntitlements } from "../src/control-room";
import { testCheckoutConfig } from "./fixtures/sales";
import { enrolledTotp, testTotpKey } from "./fixtures/control-room-totp";
import type { CatalogueResponse, ControlRoomIntegrationSummary, CustomersResponse, EntitlementsResponse, OrdersResponse } from "@flexperiment/control-room-contracts";

let db: Database.Database;
const token = "service-token";
const adminPassword = "correct horse battery staple";
const adminSalt = Buffer.alloc(16, 7);
const adminPasswordScrypt = ["scrypt", "v1", "16384", "8", "1", adminSalt.toString("base64url"),
  scryptSync(adminPassword, adminSalt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");

let totpCode: () => string;
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db);
  totpCode = enrolledTotp(db, new Date("2026-09-30T12:00:00.000Z")).next;
});

type AppDependencies = Parameters<typeof createCommerceV2App>[0];

const app = (paymentMode: "disabled" | "mock" = "disabled", overrides: Partial<AppDependencies> = {}) => createCommerceV2App({
  db,
  config: loadCommerceRuntimeConfig({ DEPLOY_ENV: paymentMode === "mock" ? "test" : "production", PAYMENT_MODE: paymentMode, KINESCOPE_DELIVERY_MODE: "open", MERCHANT_PROMOTION_PREFIX: "FX-" }),
  sourceCommit: "a".repeat(40),
  serviceToken: token,
  paymentRail: paymentMode === "mock" ? new MockPaymentRail() : undefined,
  refundEnvelopeKeys: { currentKeyId: "test", keys: { test: Buffer.alloc(32, 5) } },
  authenticateCustomer: async (headers) => headers.get("authorization") === "Session customer" ? "customer" : null,
  now: () => new Date("2026-09-30T12:00:00.000Z"),
  controlRoomAuth: { origin: "https://admin.flexperiment.ru", sessionSecret: "test-control-room-secret", passwordScrypt: adminPasswordScrypt, trustedProxyIps: ["127.0.0.1"], totpKey: testTotpKey },
  controlRoomPeerAddress: () => "127.0.0.1",
  ...overrides,
});

const adminSession = async (server: ReturnType<typeof app>) => {
  const login = await server.request("/v1/admin/login", { method: "POST",
    headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
    body: JSON.stringify({ password: adminPassword, code: totpCode() }) });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie")!;
};

const adminPost = (cookie: string, body: unknown) => ({
  method: "POST",
  headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
  body: JSON.stringify(body),
});

const internal = (body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const seedPlayableLesson = () => {
  const manifest = withManifestHash({
    courseRef: "course", version: 1, visibility: "LISTED",
    sections: [{ sectionRef: "section", visibility: "LISTED" as const }],
    lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED" as const, freePreview: true }], operations: [],
  });
  applyCourseManifest(db, manifest);
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  confirmSyntheticAccount(db, "customer");
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:course','ONLINE_COURSE','PAID','course')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('o','course:course','p',100,'CLOSED')").run();
  db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('lesson','private-video','now','now')").run();
};

const seedEditorialLesson = () => {
  db.prepare(`INSERT INTO catalog_course_projection(course_ref,version,content_hash,state_hash,visibility,last_reconciled_at,applied_at,
    authoring_source,editorial_requested_visibility) VALUES ('course',1,?,?, 'UNLISTED',?,?, 'COMMERCE_EDITORIAL','UNLISTED')`)
    .run("a".repeat(64), "a".repeat(64), "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z");
  db.prepare("INSERT INTO catalog_section_projection(section_ref,course_ref,visibility,position) VALUES ('section','course','UNLISTED',0)").run();
  db.prepare(`INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position)
    VALUES ('lesson','course','section',1,'UNLISTED',0,0)`).run();
};

describe("commerce v2 boundaries", () => {
  it.each([undefined, false, "true", 1])("refuses non-explicit account terms before CAPTCHA or auth (%s)", async (choice) => {
    const verifyCaptcha = vi.fn(async () => true);
    const authHandler = vi.fn(async () => Response.json({ ok: true }));
    const prepareMagicLinkInitiation = vi.fn();
    const server = app("disabled", { verifyCaptcha, authHandler, prepareMagicLinkInitiation });
    const response = await server.request("/v1/auth/sign-in/magic-link", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ personalDataConsent: true, accountTermsAccepted: choice, captchaToken: "isolated-token" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: "ACCOUNT_TERMS_ACCEPTANCE_REQUIRED" });
    expect(verifyCaptcha).not.toHaveBeenCalled();
    expect(prepareMagicLinkInitiation).not.toHaveBeenCalled();
    expect(authHandler).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM customers").get()).toEqual({ n: 0 });
  });

  it("exposes the immutable build identity contract", async () => {
    const response = await app().request("/identity");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      schema: "flexperiment.build-identity/1",
      service: "commerce-v2",
      sourceCommit: "a".repeat(40),
    });
  });

  it("authenticates Control Room with an HttpOnly session and durable revocation", async () => {
    const server = app();
    expect((await server.request("/v1/admin/session")).status).toBe(401);
    expect((await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    })).status).toBe(403);
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect((await server.request("/v1/admin/session", { headers: { cookie } })).status).toBe(200);
    expect((await server.request("/v1/admin/v2/integration", { headers: { cookie } })).status).toBe(200);
    expect((await server.request("/v1/admin/logout", { method: "POST", headers: { cookie } })).status).toBe(200);
    expect((await server.request("/v1/admin/session", { headers: { cookie } })).status).toBe(401);
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_room_audit_log WHERE action='SESSION_CREATED'").get()).toEqual({ count: 1 });
  });

  it("keeps editorial draft and publication behind the Control Room session and origin", async () => {
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:course','ONLINE_COURSE','FREE','course')").run();
    const server = app();
    const document = { courseRef: "course", title: "Private course", slug: "private-course", summary: "Draft only",
      visibility: "UNLISTED", sections: [{ sectionRef: "section", title: "Section", position: 0, visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", title: "Lesson", slug: "lesson", position: 0,
        visibility: "LISTED", freePreview: false }] };
    const draftPath = "/v1/admin/v2/courses/course/draft";
    const write = (headers: Record<string, string>) => server.request(draftPath, { method: "PUT",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ document, expectedRevision: 0, actor: "forged-actor" }) });
    expect((await write({})).status).toBe(401);
    expect((await server.request(draftPath)).status).toBe(401);
    const login = await server.request("/v1/admin/login", { method: "POST",
      headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }) });
    const cookie = login.headers.get("set-cookie")!;
    expect((await write({ cookie, origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await write({ cookie, origin: "https://admin.flexperiment.ru" })).status).toBe(200);
    expect((await server.request("/v1/admin/v2/courses/course/published", { headers: { cookie } })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) n FROM catalog_course_projection").get()).toEqual({ n: 0 });
    const result = await server.request("/v1/admin/v2/courses/course/publish", { method: "POST",
      headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, expectedPublishedVersion: 0, idempotencyKey: "editorial-1", actor: "forged-actor" }) });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ version: 1, visibility: "UNLISTED" });
    expect(db.prepare("SELECT actor FROM audit_log WHERE action='COURSE_EDITORIAL_PUBLISHED'").get())
      .toEqual({ actor: "singleton-admin" });
    await server.request("/v1/admin/logout", { method: "POST", headers: { cookie } });
    expect((await write({ cookie })).status).toBe(401);
  });

  it("derives catalogue actors from the Control Room session and rejects stale versions", async () => {
    const server = app();
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    });
    const cookie = login.headers.get("set-cookie")!;
    const command = { productRef: "course:admin", offerRef: "course:admin", kind: "ONLINE_COURSE", courseRef: "admin",
      accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", expectedVersion: 0 };
    const created = await server.request("/v1/admin/v2/catalogue/products", {
      method: "POST", headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify({ ...command, actor: "browser-forgery" }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ productRef: "course:admin", version: 1 });
    const stale = await server.request("/v1/admin/v2/catalogue/products", {
      method: "POST", headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" }, body: JSON.stringify(command),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { code: "CATALOG_VERSION_CONFLICT" } });
    expect(db.prepare("SELECT actor FROM audit_log WHERE action='PRODUCT_CONFIGURED'").get()).toEqual({ actor: "singleton-admin" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_room_audit_log WHERE action='PRODUCT_CONFIGURED'").get()).toEqual({ count: 1 });
  });

  it("marks only a Control Room withdrawal's platform revalidation as a withdrawal", async () => {
    const invalidatePlatformCache = vi.fn(async () => {});
    const server = app("disabled", { invalidatePlatformCache });
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    });
    const headers = { cookie: login.headers.get("set-cookie")!, origin: "https://admin.flexperiment.ru", "content-type": "application/json" };
    expect((await server.request("/v1/admin/v2/catalogue/products", { method: "POST", headers, body: JSON.stringify({
      productRef: "course:withdrawn", offerRef: "course:withdrawn", kind: "ONLINE_COURSE", courseRef: "withdrawn",
      accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", expectedVersion: 0,
    }) })).status).toBe(200);
    expect((await server.request("/v1/admin/v2/catalogue/products/course:withdrawn/withdraw", { method: "POST", headers, body: JSON.stringify({
      reason: "Rights expired", termsRef: "offer-v1#withdrawal", expectedVersion: 1,
    }) })).status).toBe(200);
    expect(invalidatePlatformCache.mock.calls).toEqual([
      ["swr", "withdrawn"],
      ["immediate", "withdrawn", "WITHDRAWN"],
    ]);
  });

  it("creates and revokes idempotent manual entitlements with an atomic audit trail", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('manual-customer','manual@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('courses-legal','COURSES','stage-a-v1','{}','2026-09-30T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('manual-product','course:manual','ONLINE_COURSE','PAID','manual-course')`).run();
    const server = app();
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    });
    const cookie = login.headers.get("set-cookie")!;
    const command = {
      customerId: "manual-customer",
      scope: "COURSE" as const,
      courseRef: "manual-course",
      reason: "Teacher access",
      evidenceRef: "ART-181/manual-1",
      legalTermsRef: "manual-access-v1",
      idempotencyKey: "manual-grant-command-1",
    };
    const grant = await server.request("/v1/admin/v2/entitlements/manual", {
      method: "POST", headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(grant.status).toBe(201);
    const granted = await grant.json() as { entitlementId: string; orderPublicId: string; created: boolean };
    expect(granted).toMatchObject({ created: true, orderPublicId: expect.stringMatching(/^FX-MANUAL-/) });
    const replay = await server.request("/v1/admin/v2/entitlements/manual", {
      method: "POST", headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...granted, created: false });
    expect(db.prepare("SELECT COUNT(*) AS count FROM course_entitlements").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_room_audit_log WHERE action='ENTITLEMENT_MANUALLY_GRANTED'").get()).toEqual({ count: 1 });
    expect(controlRoomEntitlements(db).entitlements[0]).toMatchObject({
      entitlementId: granted.entitlementId,
      sourceKind: "MANUAL",
      sourceOrderPublicId: granted.orderPublicId,
    });

    const revoked = await server.request(`/v1/admin/v2/entitlements/${granted.entitlementId}/revoke`, {
      method: "POST", headers: { cookie, origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify({ reason: "Access period ended", evidenceRef: "ART-181/manual-1-close" }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ entitlementId: granted.entitlementId, revoked: true });
    expect(db.prepare("SELECT revocation_reason FROM course_entitlements WHERE id=?").get(granted.entitlementId))
      .toEqual({ revocation_reason: "Access period ended" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM control_room_audit_log WHERE action='ENTITLEMENT_MANUALLY_REVOKED'").get()).toEqual({ count: 1 });
  });

  it("reports core readiness without coupling it to live providers", async () => {
    const response = await app().request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, core: { paymentMode: "disabled" }, capabilities: { refref: "not_required" } });
  });

  it("refuses readiness when protected Kinescope is not fully configured", async () => {
    const response = await app("disabled", {
      config: loadCommerceRuntimeConfig({
        DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-",
      }),
      runtimeCapabilities: { authEmailConfigured: true, captchaConfigured: true, kinescopeApiConfigured: false },
    }).request("/readyz");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      core: { configuration: "incomplete" },
      capabilities: { kinescope: "missing", kinescopeDrm: "missing" },
    });
  });

  it("keeps the customer library and purchase history authenticated and private", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    confirmSyntheticAccount(db, "customer");
    const server = app();
    expect((await server.request("/v1/library")).status).toBe(401);
    expect((await server.request("/v1/me/orders")).status).toBe(401);
    const headers = { authorization: "Session customer" };
    const library = await server.request("/v1/library", { headers });
    expect(library.status).toBe(200);
    expect(library.headers.get("cache-control")).toBe("private, no-store");
    expect(await library.json()).toEqual({ courses: [] });
    const orders = await server.request("/v1/me/orders", { headers });
    expect(orders.status).toBe(200);
    expect(orders.headers.get("cache-control")).toBe("private, no-store");
    expect(await orders.json()).toEqual({ orders: [] });
  });

  it("returns PAYMENTS_DISABLED at payment creation", async () => {
    const response = await app().request("/v1/checkout", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PAYMENTS_DISABLED" });
  });

  it("requires a visible price review before checkout confirmation", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    const server = app("mock");
    const headers = { authorization: "Session customer", "content-type": "application/json", "idempotency-key": "preview" };
    const unactivated = await server.request("/v1/checkout/preview", {
      method: "POST", headers: { ...headers, "idempotency-key": "unactivated" }, body: JSON.stringify({ offerRef: "course:one" }),
    });
    expect(unactivated.status).toBe(409);
    expect(await unactivated.json()).toEqual({ code: "SALES_ACTIVATION_REQUIRED" });
    qualifyTestFiscalPolicies(db);
    activatePublicSales(db);
    const preview = await server.request("/v1/checkout/preview", {
      method: "POST", headers, body: JSON.stringify({ offerRef: "course:one" }),
    });
    expect(preview.status).toBe(200);
    const quote = await preview.json() as { quoteId: string; state: string; finalAmountKopecks: number };
    expect(quote).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 10000 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    const confirmed = await server.request("/v1/checkout", {
      method: "POST", headers: { ...headers, "idempotency-key": "payment" }, body: JSON.stringify({ quoteId: quote.quoteId }),
    });
    expect(confirmed.status).toBe(201);
    expect(await confirmed.json()).toMatchObject({ state: "PAID" });
    expect(db.prepare("SELECT state,total_kopecks FROM orders").get()).toEqual({ state: "FULFILLED", total_kopecks: 10000 });
  });

  it("carries the signed order identity from attribution handoff through the payment return", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    qualifyTestFiscalPolicies(db);
    activatePublicSales(db);
    const config = loadCommerceRuntimeConfig({
      DEPLOY_ENV: "test",
      PAYMENT_MODE: "refref",
      KINESCOPE_DELIVERY_MODE: "protected",
      MERCHANT_PROMOTION_PREFIX: "FX-",
      REFREF_API_KEY: "key",
      REFREF_MERCHANT_SLUG: "flexperiment",
      REFREF_MERCHANT_ID: "00000000-0000-4000-8000-000000000001",
      REFREF_API_BASE_URL: "https://api.refref.ru/v1-rc",
      REFREF_CHECKOUT_ORIGIN: "https://checkout.refref.ru",
      REFREF_HANDOFF_STATE_SECRET: "secret",
    });
    const server = app("disabled", {
      config,
      paymentRail: new MockPaymentRail(),
      origins: {
        platform: "https://flexperiment.ru",
        lab: "https://lab.flexperiment.ru",
        admin: "https://admin.flexperiment.ru",
        api: "https://api.flexperiment.ru",
      },
    });
    const headers = { authorization: "Session customer", "content-type": "application/json" };
    const issued = await server.request("/v1/checkout/handoff", {
      method: "POST", headers, body: JSON.stringify({ returnPath: "/courses/one", storefront: "COURSES" }),
    });
    const handoffUrl = new URL((await issued.json() as { url: string }).url);
    const handoffState = handoffUrl.searchParams.get("state")!;
    const orderPublicId = handoffUrl.searchParams.get("merchantOrderRef")!;
    expect(handoffUrl.searchParams.get("returnUrl")).toBe("https://flexperiment.ru/checkout/return");
    expect(await (await server.request(`/v1/checkout/handoff/return?state=${encodeURIComponent(handoffState)}`, { headers })).json())
      .toEqual({ phase: "HANDOFF", returnPath: "/courses/one", orderPublicId, storefront: "COURSES" });

    const preview = await server.request("/v1/checkout/preview", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "preview-return" },
      body: JSON.stringify({ offerRef: "course:one", handoffToken: "refref-token", state: handoffState }),
    });
    const quote = await preview.json() as { quoteId: string };
    const paid = await server.request("/v1/checkout", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "payment-return" },
      body: JSON.stringify({ quoteId: quote.quoteId, state: handoffState }),
    });
    expect(await paid.json()).toMatchObject({ state: "PAID", orderPublicId });

    const stored = db.prepare("SELECT request_payload_json FROM checkout_attempts").get() as { request_payload_json: string };
    const successUrl = new URL((JSON.parse(stored.request_payload_json) as { successUrl: string }).successUrl);
    expect(successUrl.origin).toBe("https://flexperiment.ru");
    const paymentState = successUrl.searchParams.get("state")!;
    expect(await (await server.request(`/v1/checkout/handoff/return?state=${encodeURIComponent(paymentState)}`, { headers })).json())
      .toEqual({ phase: "PAYMENT_RETURN", returnPath: "/courses/one", orderPublicId, storefront: "COURSES" });
  });

  it("registers received email only through an Admin session, atomically with the true operator audit", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    qualifyTestFiscalPolicies(db); activatePublicSales(db);
    const rail = new MockPaymentRail();
    const order = await checkout(db, rail, testCheckoutConfig, { customerId: "customer", customerEmail: "student@example.com",
      offerRef: "course:one", idempotencyKey: "mail-intake-paid-order" }, "2026-09-30T10:00:00Z");
    const server = app("mock", { paymentRail: rail });
    const body = { orderPublicId: order.orderPublicId, senderEmail: "student@example.com", evidenceRef: "mail/message-1",
      receivedAt: "2026-09-30T11:59:00.000Z", idempotencyKey: "mail-1", actor: "forged", customerId: "another-customer", outcome: "APPROVE" };
    const path = "/v1/admin/v2/refunds";
    const write = (headers: Record<string, string>) => server.request(path, { method: "POST",
      headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await write({})).status).toBe(401);
    expect((await write({ authorization: "Session customer" })).status).toBe(401);
    expect((await write({ authorization: `Bearer ${token}` })).status).toBe(401);
    const login = await server.request("/v1/admin/login", { method: "POST",
      headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" }, body: JSON.stringify({ password: adminPassword, code: totpCode() }) });
    const cookie = login.headers.get("set-cookie")!;
    expect((await write({ cookie, origin: "https://attacker.invalid" })).status).toBe(403);
    // An audit failure must not leave an unaudited request/evidence row.
    db.exec("CREATE TRIGGER reject_intake_audit BEFORE INSERT ON control_room_audit_log WHEN NEW.action='REFUND_EMAIL_REGISTERED' BEGIN SELECT RAISE(ABORT,'AUDIT_UNAVAILABLE'); END");
    expect((await write({ cookie })).status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) n FROM refund_requests").get()).toEqual({ n: 0 });
    db.exec("DROP TRIGGER reject_intake_audit");
    const result = await write({ cookie }); expect(result.status).toBe(201);
    const registered = await result.json() as { requestPublicId: string };
    expect(await (await write({ cookie })).json()).toMatchObject({ requestPublicId: registered.requestPublicId, state: "REQUESTED", created: false });
    const list = await (await server.request(path, { headers: { cookie } })).json() as { refunds: Array<{ policyFacts: { emailIntake: { registeredBy: string } } }> };
    expect(list.refunds[0].policyFacts.emailIntake.registeredBy).toBe("singleton-admin");
    expect(db.prepare("SELECT customer_id FROM refund_requests").get()).toEqual({ customer_id: "customer" });
    expect(db.prepare("SELECT admin_id FROM control_room_audit_log WHERE action='REFUND_EMAIL_REGISTERED'").all()).toEqual([{ admin_id: "singleton-admin" }]);
    expect(db.prepare("SELECT COUNT(*) n FROM refund_decisions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM refund_executions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT state FROM orders").get()).toEqual({ state: "FULFILLED" });
    expect(db.prepare("SELECT revoked_at FROM course_entitlements").get()).toEqual({ revoked_at: null });
  });

  it("requires a customer request and explicit operator decision before refund execution", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    qualifyTestFiscalPolicies(db);
    activatePublicSales(db);
    const server = app("mock");
    const customerHeaders = { authorization: "Session customer", "content-type": "application/json", "idempotency-key": "preview-refund" };
    const preview = await server.request("/v1/checkout/preview", {
      method: "POST", headers: customerHeaders, body: JSON.stringify({ offerRef: "course:one" }),
    });
    const quote = await preview.json() as { quoteId: string };
    const paid = await server.request("/v1/checkout", {
      method: "POST", headers: { ...customerHeaders, "idempotency-key": "payment-refund" }, body: JSON.stringify({ quoteId: quote.quoteId }),
    });
    const order = await paid.json() as { orderPublicId: string };

    expect((await server.request(`/v1/internal/orders/${order.orderPublicId}/refund`, internal({}))).status).toBe(404);
    const requested = await server.request("/v1/refunds", {
      method: "POST", headers: { ...customerHeaders, "idempotency-key": "request-refund" },
      body: JSON.stringify({ orderPublicId: order.orderPublicId, reasonCode: "CUSTOMER_REQUEST" }),
    });
    expect(requested.status).toBe(201);
    const refund = await requested.json() as { requestPublicId: string };
    const cookie = await adminSession(server);
    expect((await server.request(`/v1/admin/v2/refunds/${refund.requestPublicId}/execute`, adminPost(cookie, {}))).status).toBe(409);
    const decision = await server.request(`/v1/admin/v2/refunds/${refund.requestPublicId}/decision`, adminPost(cookie, {
      outcome: "APPROVE", amountKopecks: 10000, policyBasis: "course-offer-v1", rationale: "approved",
    }));
    expect(decision.status).toBe(200);
    const executed = await server.request(`/v1/admin/v2/refunds/${refund.requestPublicId}/execute`, adminPost(cookie, {}));
    expect(await executed.json()).toMatchObject({ state: "SUCCEEDED" });
  });

  it("does not expose retired Payload writer routes even to the internal service token", async () => {
    const server = app();
    const retired = [
      ["POST", "/v1/internal/course-manifests"],
      ["POST", "/v1/internal/access-overrides"],
      ["GET", "/v1/internal/access-overrides/pending"],
      ["POST", "/v1/internal/access-overrides/operation/release"],
      ["POST", "/v1/internal/catalog/products"],
      ["POST", "/v1/internal/catalog/products/course:retired/withdraw"],
      ["POST", "/v1/internal/catalog/courses/retired/commercial"],
      ["POST", "/v1/internal/catalog/payment-purpose/retired"],
      ["POST", "/v1/internal/video-uploads"],
      ["GET", "/v1/internal/video-uploads/retired-session"],
      // ART-31: service-token mutations and Control Room read duplicates. Writes are Control Room
      // actions behind the login, or owner-cli.ts over SSH; reads are /v1/admin/v2/*.
      ["POST", "/v1/internal/sales-activations"],
      ["POST", "/v1/internal/legal-releases"],
      ["GET", "/v1/internal/merchant-promotions"],
      ["POST", "/v1/internal/merchant-promotions"],
      ["POST", "/v1/internal/campaigns"],
      ["POST", "/v1/internal/campaigns/campaign/confirm"],
      ["POST", "/v1/internal/campaigns/campaign/dispatch"],
      ["GET", "/v1/internal/campaigns/campaign/status"],
      ["POST", "/v1/internal/campaigns/campaign/retry"],
      ["GET", "/v1/internal/refunds"],
      ["POST", "/v1/internal/refunds/refund/decision"],
      ["POST", "/v1/internal/refunds/refund/execute"],
      ...["catalogue", "orders", "customers", "entitlements", "cities", "lab", "attention", "integration", "email", "incidents", "audit"]
        .map((view) => ["GET", `/v1/internal/control-room/${view}`] as const),
    ] as const;
    for (const [method, path] of retired) {
      const response = await server.request(path, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    for (const table of ["catalog_course_projection", "products", "access_overrides", "audit_log", "legal_releases",
      "sales_activation", "merchant_promotion", "notification_campaigns", "refund_decisions"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
  });

  it("serves typed Control Room read models only behind the Control Room login", async () => {
    const server = app("mock");
    expect((await server.request("/v1/admin/v2/catalogue")).status).toBe(401);
    expect((await server.request("/v1/admin/v2/catalogue", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageBLegalManifestJson);
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    qualifyTestFiscalPolicies(db);
    activatePublicSales(db);
    applyCourseManifest(db, withManifestHash({
      courseRef: "course-one", version: 1, visibility: "LISTED", sections: [], lessons: [], operations: [],
    }));
    const headers = { authorization: "Session customer", "content-type": "application/json", "idempotency-key": "cr-preview" };
    const preview = await server.request("/v1/checkout/preview", { method: "POST", headers, body: JSON.stringify({ offerRef: "course:one" }) });
    const quote = await preview.json() as { quoteId: string };
    await server.request("/v1/checkout", {
      method: "POST", headers: { ...headers, "idempotency-key": "cr-payment" }, body: JSON.stringify({ quoteId: quote.quoteId }),
    });
    const auth = { headers: { cookie: await adminSession(server) } };
    const catalogue = await (await server.request("/v1/admin/v2/catalogue", auth)).json() as CatalogueResponse;
    const orders = await (await server.request("/v1/admin/v2/orders", auth)).json() as OrdersResponse;
    const customers = await (await server.request("/v1/admin/v2/customers", auth)).json() as CustomersResponse;
    const entitlements = await (await server.request("/v1/admin/v2/entitlements", auth)).json() as EntitlementsResponse;
    const integration = await (await server.request("/v1/admin/v2/integration", auth)).json() as ControlRoomIntegrationSummary;
    expect(catalogue.courses[0]).toMatchObject({ courseRef: "course-one", accessModel: "PAID", withdrawn: false, offer: { priceKopecks: 10000 } });
    expect(orders.orders[0]).toMatchObject({ customerEmail: "student@example.com", state: "FULFILLED", productKind: "ONLINE_COURSE" });
    expect(customers.customers[0]).toMatchObject({ authBound: false, orderCount: 1, activeEntitlementCount: 1 });
    expect(entitlements.entitlements[0]).toMatchObject({ scope: "COURSE", courseRef: "course-one", revokedAt: null });
    expect(integration).toMatchObject({ paymentMode: "mock", outstandingCheckoutCount: 0, processingRefundCount: 0 });
  });

  it("keeps merchant promotion administration behind the Control Room login", async () => {
    const server = app();
    expect((await server.request("/v1/admin/v2/promotions", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const cookie = await adminSession(server);
    const created = await server.request("/v1/admin/v2/promotions", adminPost(cookie, {
      code: "FX-LAUNCH",
      discountKind: "PERCENT_BPS",
      discountValue: 1000,
      expectedVersion: 0,
    }));
    expect(created.status).toBe(200);
    const listed = await server.request("/v1/admin/v2/promotions", { headers: { cookie } });
    expect(await listed.json()).toMatchObject({ reservedPrefix: "FX-", promotions: [{ code: "FX-LAUNCH", discountValue: 1000 }] });
  });

  it("grants an open playback ID only to an authenticated eligible customer", async () => {
    const manifest = withManifestHash({
      courseRef: "course", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true }], operations: [],
    });
    applyCourseManifest(db, manifest);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    confirmSyntheticAccount(db, "customer");
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:course','ONLINE_COURSE','PAID','course')").run();
    db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('o','course:course','p',100,'CLOSED')").run();
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('lesson','private-video','now','now')").run();
    const anonymous = await app().request("/v1/lessons/lesson/playback", { method: "POST" });
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await anonymous.json())).not.toContain("private-video");
    const allowed = await app().request("/v1/lessons/lesson/playback", { method: "POST", headers: { authorization: "Session customer" } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ mode: "open", videoId: "private-video", resumeAt: 0 });
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["vod", "video"])("returns a short-lived protected grant for %s callbacks without making it cacheable", async (type) => {
    const drm = { keyring: { currentKeyId: "k1", keys: { k1: "s".repeat(32) } }, username: "drm", password: "secret" };
    const server = app("disabled", {
      config: loadCommerceRuntimeConfig({
        DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-",
      }),
      kinescopeDrmAuth: drm,
    });
    seedPlayableLesson();

    const response = await server.request("/v1/lessons/lesson/playback", {
      method: "POST", headers: { authorization: "Session customer" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const grant = await response.json() as { mode: string; videoId: string; token: string; expiresAt: string; resumeAt: number };
    expect(grant).toMatchObject({
      mode: "protected", videoId: "private-video", expiresAt: "2026-09-30T12:02:00.000Z", resumeAt: 0,
    });
    expect(grant.token.split(".")).toHaveLength(3);

    const authorize = (id: string, token = grant.token, callbackType: unknown = type) => server.request("/v1/kinescope/drm/authorize", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("drm:secret").toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id, token, type: callbackType }),
    });
    expect((await server.request("/v1/kinescope/drm/authorize", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "private-video", token: grant.token, type }),
    })).status).toBe(401);
    for (const unsupported of ["live", "VOD", "", null, 1]) {
      expect((await authorize("private-video", grant.token, unsupported)).status).toBe(400);
    }
    expect((await authorize("private-video", "")).status).toBe(400);
    expect((await authorize("private-video")).status).toBe(200);
    db.prepare(`UPDATE products SET withdrawn_at='2026-09-30T12:00:30Z',withdrawn_reason='security',withdrawn_terms_ref='terms/v1'
      WHERE product_ref='course:course'`).run();
    expect((await authorize("private-video")).status).toBe(403);
    expect((await authorize("replayed-for-another-video")).status).toBe(403);
    expect(db.prepare("SELECT event_type,reason FROM playback_access_events ORDER BY id").all()).toEqual([
      { event_type: "GRANT_ALLOWED", reason: "PROTECTED" },
      { event_type: "DRM_ALLOWED", reason: "ALLOW" },
      { event_type: "DRM_DENIED", reason: "DENY" },
      { event_type: "DRM_TOKEN_INVALID", reason: "PLAYBACK_TOKEN_VIDEO_MISMATCH" },
    ]);
  });

  it("rechecks required consent at the real DRM boundary for an already minted token", async () => {
    const server = app("disabled", {
      config: loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-" }),
      kinescopeDrmAuth: { keyring: { currentKeyId: "k1", keys: { k1: "s".repeat(32) } }, username: "drm", password: "synthetic" },
    });
    seedPlayableLesson();
    const grant = await (await server.request("/v1/lessons/lesson/playback", { method: "POST", headers: { authorization: "Session customer" } })).json() as { token: string };
    const authorize = () => server.request("/v1/kinescope/drm/authorize", { method: "POST",
      headers: { authorization: `Basic ${Buffer.from("drm:synthetic").toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "private-video", token: grant.token, type: "vod" }) });
    expect((await authorize()).status).toBe(200);
    db.exec('UPDATE "user" SET email_verified=0;');
    expect((await authorize()).status).toBe(403);
    expect(db.prepare("SELECT event_type,reason FROM playback_access_events ORDER BY id DESC LIMIT 1").get())
      .toEqual({ event_type: "DRM_DENIED", reason: "CONSENT_REQUIRED" });
  });

  it("keeps video upload under Control Room and accepts only authenticated Kinescope status webhooks", async () => {
    seedEditorialLesson();
    const kinescopeClient = {
      initUpload: vi.fn(async () => ({ endpoint: "https://tus.example/upload", videoId: "new-video" })),
      getVideo: async (videoId: string) => ({ id: videoId, status: "done" as const, durationSeconds: 180 }),
    };
    const server = app("disabled", {
      kinescopeClient,
      kinescopeLessonsFolderId: "lessons-folder",
      kinescopeWebhookCredentials: { username: "webhook", password: "secret" },
    });
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    });
    const upload = { method: "POST", headers: {
      cookie: login.headers.get("set-cookie")!, origin: "https://admin.flexperiment.ru", "content-type": "application/json",
    }, body: JSON.stringify({ lessonRef: "lesson", title: "Lesson", filename: "lesson.mp4", filesize: 1_048_576 }) };
    expect((await server.request("/v1/admin/v2/video-uploads", { ...upload, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } })).status).toBe(401);
    const initialized = await server.request("/v1/admin/v2/video-uploads", upload);
    expect(initialized.status).toBe(201);
    expect(await initialized.json()).toEqual({ uploadSessionId: expect.any(String), endpoint: "https://tus.example/upload" });
    expect(kinescopeClient.initUpload).toHaveBeenCalledTimes(1);
    expect(kinescopeClient.initUpload).toHaveBeenCalledWith({
      title: "Lesson", parentId: "lessons-folder", filename: "lesson.mp4", filesize: 1_048_576,
    });

    const webhookBody = JSON.stringify({ event: "media.update.status", data: { id: "new-video", status: "done" } });
    expect((await server.request("/v1/webhooks/kinescope", {
      method: "POST", headers: { "content-type": "application/json" }, body: webhookBody,
    })).status).toBe(401);
    const webhook = await server.request("/v1/webhooks/kinescope", {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from("webhook:secret").toString("base64")}`, "content-type": "application/json" },
      body: webhookBody,
    });
    expect(webhook.status).toBe(200);
    expect(db.prepare("SELECT active_video_id,duration_seconds FROM lesson_video_bindings WHERE lesson_ref='lesson'").get())
      .toEqual({ active_video_id: "new-video", duration_seconds: 180 });
  });

  it("retired service-token video routes neither call Kinescope nor mutate sessions or bindings", async () => {
    applyCourseManifest(db, withManifestHash({
      courseRef: "legacy", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false }],
      operations: [],
    }));
    db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at)
      VALUES ('lesson','old-video','before','before')`).run();
    const kinescopeClient = {
      initUpload: vi.fn(async () => ({ endpoint: "https://tus.example/upload", videoId: "new-video" })),
      getVideo: vi.fn(async (videoId: string) => ({ id: videoId, status: "done" as const, durationSeconds: 180 })),
    };
    const pending = await startVideoUpload(db, kinescopeClient, {
      lessonRef: "lesson", title: "Legacy lesson", filename: "lesson.mp4", filesize: 1024, parentId: "folder",
    });
    kinescopeClient.initUpload.mockClear();
    const sessions = db.prepare("SELECT * FROM video_upload_sessions").all();
    const bindings = db.prepare("SELECT * FROM lesson_video_bindings").all();
    const server = app("disabled", { kinescopeClient, kinescopeLessonsFolderId: "folder" });
    const auth = { authorization: `Bearer ${token}` };
    expect((await server.request("/v1/internal/video-uploads", internal({
      lessonRef: "lesson", title: "Legacy lesson", filename: "replacement.mp4", filesize: 1024,
    }))).status).toBe(404);
    expect((await server.request(`/v1/internal/video-uploads/${pending.uploadSessionId}`, { headers: auth })).status).toBe(404);
    expect(kinescopeClient.initUpload).not.toHaveBeenCalled();
    expect(kinescopeClient.getVideo).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM video_upload_sessions").all()).toEqual(sessions);
    expect(db.prepare("SELECT * FROM lesson_video_bindings").all()).toEqual(bindings);
  });

  it("keeps Control Room upload scoped to published Commerce lessons and preserves READY binding on failure", async () => {
    seedEditorialLesson();
    db.prepare(`INSERT INTO catalog_course_projection(course_ref,version,content_hash,state_hash,visibility,last_reconciled_at,applied_at)
      VALUES ('legacy',1,?,?,'UNLISTED',?,?)`)
      .run("b".repeat(64), "b".repeat(64), "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z");
    db.prepare("INSERT INTO catalog_section_projection(section_ref,course_ref,visibility,position) VALUES ('legacy-section','legacy','UNLISTED',0)").run();
    db.prepare(`INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position)
      VALUES ('legacy-lesson','legacy','legacy-section',1,'UNLISTED',0,0)`).run();
    let nextId = 0;
    const statuses = new Map<string, "processing" | "done" | "error">();
    const kinescopeClient = {
      initUpload: vi.fn(async () => {
        const videoId = `video-${++nextId}`;
        statuses.set(videoId, "processing");
        return { endpoint: `https://tus.example/upload/${nextId}`, videoId };
      }),
      getVideo: vi.fn(async (videoId: string) => ({ id: videoId, status: statuses.get(videoId) ?? "processing", durationSeconds: 180 })),
    };
    const server = app("disabled", { kinescopeClient, kinescopeLessonsFolderId: "lessons-folder" });
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json", "x-real-ip": "203.0.113.10" },
      body: JSON.stringify({ password: adminPassword, code: totpCode() }),
    });
    const cookie = login.headers.get("set-cookie")!;
    const upload = (lessonRef: string, headers: Record<string, string> = {}) => server.request("/v1/admin/v2/video-uploads", {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ lessonRef, title: "Synthetic lesson", filename: "tour.mp4", filesize: 1024 }),
    });
    expect((await upload("lesson")).status).toBe(401);
    expect((await upload("unknown", { cookie })).status).toBe(404);
    expect((await upload("legacy-lesson", { cookie })).status).toBe(404);
    expect(kinescopeClient.initUpload).not.toHaveBeenCalled();
    const first = await upload("lesson", { cookie });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const firstBody = await first.json() as { uploadSessionId: string; endpoint: string };
    expect(firstBody).toEqual({ uploadSessionId: expect.any(String), endpoint: "https://tus.example/upload/1" });
    expect(JSON.stringify(firstBody)).not.toContain("video-1");
    expect((await server.request(`/v1/admin/v2/video-uploads/${firstBody.uploadSessionId}`)).status).toBe(401);
    const poll = (id: string) => server.request(`/v1/admin/v2/video-uploads/${id}`, { headers: { cookie } });
    expect(await (await poll(firstBody.uploadSessionId)).json()).toMatchObject({ state: "PROCESSING" });
    statuses.set("video-1", "done");
    expect(await (await poll(firstBody.uploadSessionId)).json()).toMatchObject({ state: "READY", durationSeconds: 180 });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='lesson'").get())
      .toEqual({ active_video_id: "video-1" });

    const second = await upload("lesson", { cookie });
    const secondBody = await second.json() as { uploadSessionId: string };
    expect((await server.request("/v1/admin/v2/lessons/lesson/video-upload", { headers: { cookie } })).status).toBe(200);
    expect(await (await server.request("/v1/admin/v2/lessons/lesson/video-upload", { headers: { cookie } })).json())
      .toMatchObject({ upload: { uploadSessionId: secondBody.uploadSessionId, state: "UPLOADING" }, activeBinding: true, activeDurationSeconds: 180 });
    statuses.set("video-2", "error");
    expect(await (await poll(secondBody.uploadSessionId)).json()).toMatchObject({ state: "FAILED" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='lesson'").get())
      .toEqual({ active_video_id: "video-1" });
  });

  it.each(["PUT", "POST"])("keeps %s resume ownership in the authenticated session and route", async (method) => {
    seedPlayableLesson();
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('other-customer','other@example.com')").run();
    db.prepare(`INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position)
      VALUES ('other-lesson','course','section',1,'LISTED',0,1)`).run();
    db.prepare(`INSERT INTO lesson_resume_positions(customer_id,lesson_ref,seconds,client_seq,client_ts,updated_at)
      VALUES ('other-customer','other-lesson',88,5,'2026-09-30T11:00:00Z','2026-09-30T11:00:00Z')`).run();
    const victimBefore = db.prepare("SELECT * FROM lesson_resume_positions WHERE customer_id='other-customer'").get();

    const response = await app().request("/v1/lessons/lesson/resume", {
      method, headers: { authorization: "Session customer", "content-type": "application/json" },
      body: JSON.stringify({ customerId: "other-customer", lessonRef: "other-lesson",
        seconds: 17, clientSeq: 100, clientTs: "2026-09-30T12:00:00Z" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true });
    expect(db.prepare("SELECT * FROM lesson_resume_positions WHERE customer_id='other-customer'").get()).toEqual(victimBefore);
    expect(db.prepare("SELECT customer_id,lesson_ref,seconds FROM lesson_resume_positions WHERE customer_id='customer'").get())
      .toEqual({ customer_id: "customer", lesson_ref: "lesson", seconds: 17 });
    expect(db.prepare("SELECT COUNT(*) n FROM lesson_resume_positions").get()).toEqual({ n: 2 });
  });

  it("accepts beacon-style resume writes and restarts a completed lesson", async () => {
    const manifest = withManifestHash({
      courseRef: "course", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true }], operations: [],
    });
    applyCourseManifest(db, manifest);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    confirmSyntheticAccount(db, "customer");
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:course','ONLINE_COURSE','PAID','course')").run();
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,duration_seconds,bound_at,updated_at) VALUES ('lesson','private-video',100,'now','now')").run();
    const headers = { authorization: "Session customer", "content-type": "application/json" };
    const resume = await app().request("/v1/lessons/lesson/resume", {
      method: "POST", headers, body: JSON.stringify({ seconds: 90, clientSeq: 1, clientTs: "2026-09-30T11:59:00Z" }),
    });
    expect(resume.status).toBe(200);
    const playback = await app().request("/v1/lessons/lesson/playback", { method: "POST", headers });
    expect(await playback.json()).toMatchObject({ resumeAt: 0 });
  });

  it("rate limits repeated playback grants without leaking the video ID", async () => {
    const manifest = withManifestHash({
      courseRef: "course", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true }], operations: [],
    });
    applyCourseManifest(db, manifest);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    confirmSyntheticAccount(db, "customer");
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:course','ONLINE_COURSE','PAID','course')").run();
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('lesson','private-video','now','now')").run();
    const headers = { authorization: "Session customer" };
    for (let index = 0; index < 30; index += 1) expect((await app().request("/v1/lessons/lesson/playback", { method: "POST", headers })).status).toBe(200);
    const limited = await app().request("/v1/lessons/lesson/playback", { method: "POST", headers });
    expect(limited.status).toBe(429);
    expect(JSON.stringify(await limited.json())).not.toContain("private-video");
  });
});
