import Database from "better-sqlite3";
import { scryptSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { migrateV2 } from "../src/db";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { withManifestHash } from "../src/manifest";
import { MockPaymentRail } from "../src/checkout";
import type { CatalogueResponse, ControlRoomIntegrationSummary, CustomersResponse, EntitlementsResponse, OrdersResponse } from "@flexperiment/control-room-contracts";

let db: Database.Database;
const token = "service-token";
const adminPassword = "correct horse battery staple";
const adminSalt = Buffer.alloc(16, 7);
const adminPasswordScrypt = ["scrypt", "v1", "16384", "8", "1", adminSalt.toString("base64url"),
  scryptSync(adminPassword, adminSalt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")].join(":");

beforeEach(() => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); migrateV2(db); });

const app = (paymentMode: "disabled" | "mock" = "disabled") => createCommerceV2App({
  db,
  config: loadCommerceRuntimeConfig({ DEPLOY_ENV: paymentMode === "mock" ? "test" : "production", PAYMENT_MODE: paymentMode, KINESCOPE_DELIVERY_MODE: "open", MERCHANT_PROMOTION_PREFIX: "FX-" }),
  sourceCommit: "a".repeat(40),
  serviceToken: token,
  paymentRail: paymentMode === "mock" ? new MockPaymentRail() : undefined,
  authenticateCustomer: async (headers) => headers.get("authorization") === "Session customer" ? "customer" : null,
  now: () => new Date("2026-09-30T12:00:00.000Z"),
  controlRoomAuth: { origin: "https://admin.flexperiment.ru", sessionSecret: "test-control-room-secret", passwordScrypt: adminPasswordScrypt },
});

const internal = (body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("commerce v2 boundaries", () => {
  it("authenticates Control Room with an HttpOnly session and durable revocation", async () => {
    const server = app();
    expect((await server.request("/v1/admin/session")).status).toBe(401);
    expect((await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
    })).status).toBe(403);
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
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

  it("derives catalogue actors from the Control Room session and rejects stale versions", async () => {
    const server = app();
    const login = await server.request("/v1/admin/login", {
      method: "POST", headers: { origin: "https://admin.flexperiment.ru", "content-type": "application/json" },
      body: JSON.stringify({ password: adminPassword }),
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

  it("reports core readiness without coupling it to live providers", async () => {
    const response = await app().request("/readyz");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, core: { paymentMode: "disabled" }, capabilities: { refref: "not_required" } });
  });

  it("returns PAYMENTS_DISABLED at payment creation", async () => {
    const response = await app().request("/v1/checkout", { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PAYMENTS_DISABLED" });
  });

  it("requires a visible price review before checkout confirmation", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1','{}','2026-09-30T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    const server = app("mock");
    const headers = { authorization: "Session customer", "content-type": "application/json", "idempotency-key": "preview" };
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

  it("requires a customer request and explicit operator decision before refund execution", async () => {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1','{}','2026-09-30T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
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
    expect((await server.request(`/v1/internal/refunds/${refund.requestPublicId}/execute`, internal({}))).status).toBe(409);
    const decision = await server.request(`/v1/internal/refunds/${refund.requestPublicId}/decision`, internal({
      outcome: "APPROVE", amountKopecks: 10000, policyBasis: "course-offer-v1", rationale: "approved", actor: "operator",
    }));
    expect(decision.status).toBe(200);
    const executed = await server.request(`/v1/internal/refunds/${refund.requestPublicId}/execute`, internal({}));
    expect(await executed.json()).toMatchObject({ state: "SUCCEEDED" });
  });

  it("authenticates internal manifest writes", async () => {
    const manifest = withManifestHash({ courseRef: "course", version: 1, visibility: "LISTED", sections: [], lessons: [], operations: [] });
    expect((await app().request("/v1/internal/course-manifests", { method: "POST" })).status).toBe(401);
    expect((await app().request("/v1/internal/course-manifests", internal(manifest))).status).toBe(200);
  });

  it("serves typed Control Room read models only through the internal boundary", async () => {
    const server = app("mock");
    expect((await server.request("/v1/internal/control-room/catalogue")).status).toBe(401);
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
      VALUES ('legal','COURSES','stage-b-v1','{}','2026-09-30T00:00:00Z',1)`).run();
    db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
      VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')`).run();
    db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
      VALUES ('offer','course:one','product',10000,'PUBLIC')`).run();
    await server.request("/v1/internal/course-manifests", internal(withManifestHash({
      courseRef: "course-one", version: 1, visibility: "LISTED", sections: [], lessons: [], operations: [],
    })));
    const headers = { authorization: "Session customer", "content-type": "application/json", "idempotency-key": "cr-preview" };
    const preview = await server.request("/v1/checkout/preview", { method: "POST", headers, body: JSON.stringify({ offerRef: "course:one" }) });
    const quote = await preview.json() as { quoteId: string };
    await server.request("/v1/checkout", {
      method: "POST", headers: { ...headers, "idempotency-key": "cr-payment" }, body: JSON.stringify({ quoteId: quote.quoteId }),
    });
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const catalogue = await (await server.request("/v1/internal/control-room/catalogue", auth)).json() as CatalogueResponse;
    const orders = await (await server.request("/v1/internal/control-room/orders", auth)).json() as OrdersResponse;
    const customers = await (await server.request("/v1/internal/control-room/customers", auth)).json() as CustomersResponse;
    const entitlements = await (await server.request("/v1/internal/control-room/entitlements", auth)).json() as EntitlementsResponse;
    const integration = await (await server.request("/v1/internal/control-room/integration", auth)).json() as ControlRoomIntegrationSummary;
    expect(catalogue.courses[0]).toMatchObject({ courseRef: "course-one", accessModel: "PAID", withdrawn: false, offer: { priceKopecks: 10000 } });
    expect(orders.orders[0]).toMatchObject({ customerEmail: "student@example.com", state: "FULFILLED", productKind: "ONLINE_COURSE" });
    expect(customers.customers[0]).toMatchObject({ authBound: false, orderCount: 1, activeEntitlementCount: 1 });
    expect(entitlements.entitlements[0]).toMatchObject({ scope: "COURSE", courseRef: "course-one", revokedAt: null });
    expect(integration).toMatchObject({ paymentMode: "mock", outstandingCheckoutCount: 0, processingRefundCount: 0 });
  });

  it("keeps merchant promotion administration behind the internal boundary", async () => {
    expect((await app().request("/v1/internal/merchant-promotions")).status).toBe(401);
    const created = await app().request("/v1/internal/merchant-promotions", internal({
      code: "FX-LAUNCH",
      discountKind: "PERCENT_BPS",
      discountValue: 1000,
      actor: "operator",
      expectedVersion: 0,
    }));
    expect(created.status).toBe(200);
    const listed = await app().request("/v1/internal/merchant-promotions", { headers: { authorization: `Bearer ${token}` } });
    expect(await listed.json()).toMatchObject({ reservedPrefix: "FX-", promotions: [{ code: "FX-LAUNCH", discountValue: 1000 }] });
  });

  it("grants an open playback ID only to an authenticated eligible customer", async () => {
    const manifest = withManifestHash({
      courseRef: "course", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true }], operations: [],
    });
    await app().request("/v1/internal/course-manifests", internal(manifest));
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
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

  it("accepts beacon-style resume writes and restarts a completed lesson", async () => {
    const manifest = withManifestHash({
      courseRef: "course", version: 1, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: true }], operations: [],
    });
    await app().request("/v1/internal/course-manifests", internal(manifest));
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
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
    await app().request("/v1/internal/course-manifests", internal(manifest));
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('p','course:course','ONLINE_COURSE','PAID','course')").run();
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('lesson','private-video','now','now')").run();
    const headers = { authorization: "Session customer" };
    for (let index = 0; index < 30; index += 1) expect((await app().request("/v1/lessons/lesson/playback", { method: "POST", headers })).status).toBe(200);
    const limited = await app().request("/v1/lessons/lesson/playback", { method: "POST", headers });
    expect(limited.status).toBe(429);
    expect(JSON.stringify(await limited.json())).not.toContain("private-video");
  });
});
