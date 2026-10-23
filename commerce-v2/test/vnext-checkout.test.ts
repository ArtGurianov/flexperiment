import { saveEditorialDraft, publishEditorialDraft } from "../src/course-editorial";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCommerceV2App } from "../src/app";
import { BrowserContexts } from "../src/browser-context";
import { MockPaymentRail, type PaymentResolveInput } from "../src/checkout";
import { RefrefPaymentRail } from "../src/refref-payment-rail";
import { resolutionInputHash } from "../src/refref-contract/shared-checkout-snapshot";
import { migrateV2 } from "../src/db";
import { stageBLegalManifestJson } from "./fixtures/legal";
import { testCheckoutConfig, qualifyTestFiscalPolicies } from "./fixtures/sales";
import { labLegalReview } from "../src/lab-tickets";
import type { CommerceRuntimeConfig } from "../src/payment-mode";

const T0 = new Date("2026-10-23T04:00:00.000Z");
const merchantId = "00000000-0000-4000-8000-000000000001";
const origins = { platform: "https://platform.test", lab: "https://lab.test", admin: "https://admin.test", api: "https://api.test" };
let db: Database.Database;
let rail: MockPaymentRail;
let app: ReturnType<typeof createCommerceV2App>;
let lost = false;
let corruptResponse: ((value: Record<string, unknown>) => void) | undefined;
const resolveRequests: PaymentResolveInput[] = [];
function build(storefronts: ("COURSES" | "LAB")[] = ["COURSES", "LAB"]) {
  const config: CommerceRuntimeConfig = { ...testCheckoutConfig, paymentMode: "refref", refref: { apiKey: "synthetic", merchantId,
    merchantSlug: "flexperiment", handoffStateSecret: "synthetic-secret", apiBaseUrl: "https://api.refref.test/v1-rc", checkoutOrigin: "https://checkout.refref.test",
    vnextApiBaseUrl: "https://api.refref.test/v1-vnext", vnextCheckoutStorefronts: storefronts } };
  const browserContexts = new BrowserContexts({ db, origins, config: { maxAgeSeconds: { COURSES: 2592000, LAB: 2592000 } },
    now: () => T0, schedule: () => {} });
  app = createCommerceV2App({ db, config, paymentRail: rail, browserContexts, origins, serviceToken: "synthetic", sourceCommit: "a".repeat(40),
    now: () => T0, authenticateCustomer: async headers => headers.get("x-test-customer"),
    labGuestTrustedProxyIps: ["10.0.5.4"], labGuestPeerAddress: () => "10.0.5.4" });
}
const headers = (storefront: "COURSES" | "LAB", key: string, token?: string) => ({ "content-type": "application/json", "idempotency-key": key,
  origin: storefront === "COURSES" ? origins.platform : origins.lab, "x-forwarded-host": storefront === "COURSES" ? "platform.test" : "lab.test",
  ...(token ? { authorization: `Bearer ${token}`, "x-real-ip": "203.0.113.1" } : { "x-test-customer": "customer" }) });
const post = (path: string, body: unknown, key: string, storefront: "COURSES" | "LAB" = "COURSES", token?: string) =>
  app.request(path, { method: "POST", headers: headers(storefront, key, token), body: JSON.stringify(body) });

beforeEach(() => {
  db = new Database(":memory:"); migrateV2(db); rail = new MockPaymentRail(); lost = false; corruptResponse = undefined; resolveRequests.length = 0;
  db.exec("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.test')");
  for (const storefront of ["COURSES", "LAB"]) db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES (?,?,?,?,'2026-10-20',1)")
    .run(storefront, storefront, `${storefront}-b`, stageBLegalManifestJson);
  db.exec("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('course','course:one','ONLINE_COURSE','PAID','one')");
  db.exec("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('course','course:one','course',10001,'PUBLIC')");
  db.exec("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')");
  db.exec(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
    VALUES ('lab','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Адрес')`);
  db.exec("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab','lab:one','LAB','PAID','lab:one')");
  db.exec("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('lab','lab:one','lab',10001,'PUBLIC')");
  saveEditorialDraft(db, { expectedRevision: 0, actor: "author", document: {
    courseRef: "one", title: "Course", slug: "published-course-slug", summary: "Summary", visibility: "LISTED",
    sections: [{ sectionRef: "section", title: "Section", position: 0, visibility: "LISTED" }],
    lessons: [{ lessonRef: "lesson", sectionRef: "section", title: "Lesson", slug: "lesson", position: 0, visibility: "LISTED", freePreview: false }],
  } }, T0.toISOString());
  publishEditorialDraft(db, { courseRef: "one", expectedRevision: 1, expectedPublishedVersion: 0, idempotencyKey: "publish", actor: "author" }, T0.toISOString());
  qualifyTestFiscalPolicies(db);
  vi.spyOn(rail, "resolve").mockImplementation(async input => {
    resolveRequests.push(structuredClone(input));
    const response = { referralResolutionId: "10000000-0000-4000-8000-000000000001", merchantOrderRef: input.request.merchantOrderRef,
      storefrontOrigin: input.request.storefrontOrigin, browserContextId: input.request.browserContextId, attributionSource: "ARRIVAL",
      campaignId: "20000000-0000-4000-8000-000000000002", termsVersionId: "30000000-0000-4000-8000-000000000003",
      checkoutCodeOutcome: "NOT_APPLIED_ARRIVAL_PRIORITY", deliveryDegraded: input.request.deliveryDegraded,
      inputHash: resolutionInputHash({ schema: "refref.referral-resolution-input/1", merchantId, merchantOrderRef: input.request.merchantOrderRef,
        currency: "RUB", lines: input.request.lines }), currency: "RUB",
      lines: [{ lineRef: input.request.lines[0].lineRef, eligible: true, referralDiscountAmountKopecks: 501 }],
      totals: { merchantOfferAmountKopecks: 10001, referralDiscountAmountKopecks: 501, payableAmountKopecks: 9500 }, expiresAt: "2026-10-23T04:15:00Z" };
    corruptResponse?.(response);
    const client = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.test/v1-rc", vnextApiBaseUrl: "https://api.refref.test/v1-vnext",
      apiKey: "synthetic", merchantId, fetch: async () => { if (lost) throw new TypeError("lost ACK"); return Response.json(response); } });
    return client.resolve(input);
  });
  build();
});
afterEach(() => db.close());

describe("ART-379 independent source E2E profiles (mock payment provider)", () => {
  it("LMS Buy → final price/docs → deliberate acceptance → one payment, reload and signed payment return", async () => {
    const create = vi.spyOn(rail, "create");
    const preview = await post("/v1/checkout/preview", { offerRef: "course:one", checkoutCode: "PARTNER20" }, "preview");
    expect(preview.status).toBe(200);
    const quote = await preview.json();
    expect(quote).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 9500, checkoutCodeOutcome: "NOT_APPLIED_ARRIVAL_PRIORITY",
      legalAcceptance: { releaseVersion: "COURSES-b", documents: expect.any(Array) } });
    expect(create).not.toHaveBeenCalled();
    expect((await post("/v1/checkout", { quoteId: quote.quoteId }, "pay")).status).toBeGreaterThanOrEqual(400);
    expect(create).not.toHaveBeenCalled();
    expect(await (await post("/v1/checkout/preview", { offerRef: "course:one", checkoutCode: "PARTNER20" }, "preview")).json()).toEqual(quote);
    const acceptance = { ...quote.legalAcceptance, accepted: true };
    const paid = await post("/v1/checkout", { quoteId: quote.quoteId, legalAcceptance: acceptance }, "pay");
    expect(await paid.json()).toMatchObject({ state: "PAID" });
    await post("/v1/checkout", { quoteId: quote.quoteId, legalAcceptance: acceptance }, "another-tab");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].quote.finalAmountKopecks).toBe(9500);
    const success = new URL(create.mock.calls[0][0].successUrl!);
    const signedBody = JSON.parse(Buffer.from(success.searchParams.get("state")!.split(".")[0], "base64url").toString());
    expect(signedBody).not.toHaveProperty("protocol");
    const navigation = await app.request(`/v1/checkout/handoff/return?state=${encodeURIComponent(success.searchParams.get("state")!)}`,
      { headers: headers("COURSES", "return") });
    expect(await navigation.json()).toMatchObject({ phase: "PAYMENT_RETURN", returnPath: "/courses/published-course-slug" });
    expect(resolveRequests[0]).toMatchObject({ protocol: "VNEXT", request: { storefrontOrigin: origins.platform } });
    expect(JSON.stringify(resolveRequests)).not.toContain("student@example.test");
    expect((await post("/v1/checkout/handoff", {}, "old-entry")).status).toBe(410);
  });
  it("unknown resolution cannot pay; exact replay recovers the same context and price", async () => {
    lost = true; const create = vi.spyOn(rail, "create");
    const pending = await (await post("/v1/checkout/preview", { offerRef: "course:one" }, "lost")).json();
    expect(pending.state).toBe("RESOLUTION_PENDING");
    const row = db.prepare("SELECT id FROM checkout_quotes").get() as { id: string };
    expect((await post("/v1/checkout", { quoteId: row.id }, "pay")).status).toBeGreaterThanOrEqual(400);
    expect(create).not.toHaveBeenCalled(); lost = false;
    expect((await post("/v1/checkout/preview", { offerRef: "course:one" }, "lost")).status).toBe(200);
    expect(resolveRequests[1]).toEqual(resolveRequests[0]);
  });
  it("LAB guest preview/hold → legal acceptance → one ticket/payment, independently of LMS", async () => {
    build(["LAB"]);
    const token = "g".repeat(43), create = vi.spyOn(rail, "create");
    const start = await post("/v1/lab/guest/start", { email: "guest@example.test", accessToken: token }, "start", "LAB", token);
    expect(start.status).toBe(201);
    const quote = await (await post("/v1/checkout/preview", { offerRef: "lab:one", checkoutCode: "PARTNER20" }, "preview", "LAB", token)).json();
    expect(quote).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 9500, occurrence: { timezone: "Asia/Novosibirsk" } });
    expect(create).not.toHaveBeenCalled();
    expect((await post("/v1/checkout", { quoteId: quote.quoteId }, "pay", "LAB", token)).status).toBe(403);
    const legal = labLegalReview(db);
    const body = { quoteId: quote.quoteId, labAcceptance: { personalDataConsent: true, termsAccepted: true, receiptContactAccepted: true,
      releaseVersion: legal.releaseVersion, manifestSha256: legal.manifestSha256 } };
    expect(await (await post("/v1/checkout", body, "pay", "LAB", token)).json()).toMatchObject({ state: "PAID" });
    await post("/v1/checkout", body, "reload", "LAB", token);
    expect(create).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT COUNT(*) AS n FROM lab_tickets").get()).toEqual({ n: 1 });
    expect(resolveRequests[0].request.storefrontOrigin).toBe(origins.lab);
    expect((await post("/v1/checkout/preview", { offerRef: "course:one" }, "not-admitted")).status).toBeGreaterThanOrEqual(400);
  });
});

 describe("second review: durable resolution refusal and quote lookup", () => {
  it.each(["binding", "line", "totals"])("commits a %s refusal once and releases the LAB hold", async kind => {
    corruptResponse = value => {
      if (kind === "binding") value.inputHash = "wrong";
      if (kind === "line") value.lines = [{ lineRef: (value.lines as Array<{lineRef:string}>)[0].lineRef, eligible: true, referralDiscountAmountKopecks: 10002 }];
      if (kind === "totals") value.totals = { merchantOfferAmountKopecks: 10001, referralDiscountAmountKopecks: 501, payableAmountKopecks: 1 };
    };
    const token = "g".repeat(43);
    await post("/v1/lab/guest/start", { email: "guest@example.test", accessToken: token }, "start", "LAB", token);
    const body = { offerRef: "lab:one" };
    const first = await post("/v1/checkout/preview", body, "preview", "LAB", token);
    expect(first.status).toBe(409); expect(await first.json()).toMatchObject({ newIntentAllowed: true });
    expect((await post("/v1/checkout/preview", body, "preview", "LAB", token)).status).toBe(409);
    expect(resolveRequests).toHaveLength(1);
    expect(db.prepare("SELECT state,consumed_at FROM checkout_quotes").get()).toEqual({ state: "REFUSED", consumed_at: null });
    expect(db.prepare("SELECT count(*) AS n FROM checkout_quotes WHERE state IN ('DRAFT','RESOLVING','CUSTOMER_ACTION_REQUIRED','REVIEW')").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM checkout_attempts").get()).toEqual({ n: 0 });
  });
  it.each(["COURSES", "LAB"] as const)("returns redacted 404 for missing/foreign %s quote without a server-failure signal", async storefront => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = "g".repeat(43);
    if (storefront === "LAB") await post("/v1/lab/guest/start", { email: "guest@example.test", accessToken: token }, "start", "LAB", token);
    const own = await (await post("/v1/checkout/preview", { offerRef: "course:one" }, "preview")).json();
    if (storefront === "COURSES") db.exec("INSERT INTO customers(id,email_normalized) VALUES ('other','other@example.test')");
    for (const quoteId of ["absent", own.quoteId]) {
      const hdr = headers(storefront, "confirm", storefront === "LAB" ? token : undefined);
      if (storefront === "COURSES") Object.assign(hdr, { "x-test-customer": "other" });
      const result = await app.request("/v1/checkout", { method: "POST", headers: hdr, body: JSON.stringify({ quoteId }) });
      expect(result.status).toBe(404); expect(await result.json()).toEqual({ code: "CHECKOUT_QUOTE_NOT_FOUND" });
    }
    expect(log).not.toHaveBeenCalled(); log.mockRestore();
  });
});
