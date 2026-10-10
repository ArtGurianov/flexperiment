import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Courses } from "../collections/Courses";
import { courseCommercialEndpoints } from "../lib/course-commercial-endpoints";
import { freshPurposeSummary, requirePublishedOfferPurpose } from "../lib/offer-payment-purpose";

const endpoint = (method: string) => courseCommercialEndpoints.find(e => e.path === "/payment-purpose/:courseRef" && e.method === method)!;
const author = { id: 7, collection: "users" };
const facts = { courseRef: "course:one", offerRef: "offer:one", accessModel: "PAID", version: 3, priceKopecks: 1000, paymentPurpose: "Оплата курса 🚀" };
const request = (overrides = {}) => ({ user: author, url: "https://cms.example/api/courses/payment-purpose/course:one",
  headers: new Headers({ origin: "https://cms.example" }), routeParams: { courseRef: "course:one" },
  json: async () => ({ paymentPurpose: facts.paymentPurpose, expectedVersion: 3, actor: "forged", priceKopecks: 1 }), ...overrides });
const publish = (data = {}, context = {}) => requirePublishedOfferPurpose({ data: { _status: "published", courseRef: "course:one", ...data }, req: { context } } as never);
beforeEach(() => { vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "https://commerce.internal"); vi.stubEnv("PLATFORM_COMMERCE_SERVICE_TOKEN", "synthetic-service-only"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("merchant offer editing through Payload", () => {
  it.each([null, { id: 7, collection: "students" }])("requires author authentication for read and write", async user => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await endpoint("get").handler(request({ user }) as never)).status).toBe(401);
    expect((await endpoint("post").handler(request({ user }) as never)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, "https://foreign.example"])("rejects missing/foreign browser Origin", async origin => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await endpoint("post").handler(request({ headers: new Headers(origin ? { origin } : {}) }) as never)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reads fresh authoritative offer data without exposing the service credential", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ courses: [facts] }));
    const response = await endpoint("get").handler(request() as never);
    expect(await response.json()).toEqual({ paymentPurpose: facts.paymentPurpose, version: 3, offerRef: "offer:one" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { authorization: "Bearer synthetic-service-only" } });
  });
  it("sends only explicit purpose/version and authenticated actor; cannot edit pricing or sales", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ paymentPurpose: facts.paymentPurpose, version: 4 }));
    const response = await endpoint("post").handler(request() as never);
    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ paymentPurpose: facts.paymentPurpose, expectedVersion: 3, actor: "payload:7" });
  });
  it.each([null, "", " title ", "bad\u0080", "\ud800", "🚀".repeat(257)])("rejects invalid text before commerce write", async paymentPurpose => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect((await endpoint("post").handler(request({ json: async () => ({ paymentPurpose, expectedVersion: 3 }) }) as never)).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns a named version conflict, not an untrusted internal error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: "CATALOG_VERSION_CONFLICT", message: "secret" } }, { status: 409 }));
    expect(await (await endpoint("post").handler(request() as never)).json()).toEqual({ code: "CATALOG_VERSION_CONFLICT" });
  });
  it("does not claim success on malformed read-back or transport failure", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: 3, paymentPurpose: "different" }));
    expect((await endpoint("post").handler(request() as never)).status).toBe(503);
    fetch.mockRejectedValue(new Error("secret provider exception"));
    expect(await (await endpoint("post").handler(request() as never)).json()).toEqual({ code: "COMMERCE_UNAVAILABLE" });
  });
});
describe("paid course publication admission", () => {
  it("wires the fresh check before manifest publication and uses a UI-only field, not a second catalog", () => {
    expect(Courses.hooks?.beforeChange).toContain(requirePublishedOfferPurpose);
    expect(Courses.fields.find(field => "name" in field && field.name === "offerPaymentPurpose")).toMatchObject({ type: "ui" });
  });
  it.each([null, "", " leading", "bad\u0080"])("refuses paid publication without valid explicit merchant facts", async paymentPurpose => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ courses: [{ ...facts, paymentPurpose }] }));
    await expect(publish()).rejects.toThrow("PAYMENT_PURPOSE_REQUIRED");
  });
  it("preserves combining/astral text and admits a configured paid offer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ courses: [{ ...facts, paymentPurpose: "Cafe\u0301 🚀" }] }));
    expect((await freshPurposeSummary("course:one"))?.paymentPurpose).toBe("Cafe\u0301 🚀");
    await expect(publish()).resolves.toMatchObject({ _status: "published" });
  });
  it("does not require bank data for drafts or free content", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ courses: [{ ...facts, accessModel: "FREE", paymentPurpose: null }] }));
    await publish({ _status: "draft" }); await publish({}, { __lmsDraftOperation: true }); expect(fetch).not.toHaveBeenCalled();
    await expect(publish()).resolves.toMatchObject({ _status: "published" });
  });
  it("fails closed when fresh commercial facts cannot be obtained or are ambiguous", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ courses: [facts, facts] }));
    await expect(publish()).rejects.toThrow("COMMERCE_SUMMARY_INVALID");
    fetch.mockResolvedValue(Response.json({}, { status: 503 })); await expect(publish()).rejects.toThrow("COMMERCE_SUMMARY_UNAVAILABLE");
  });
});
