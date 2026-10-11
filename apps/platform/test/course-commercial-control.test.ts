import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { courseCommercialWrite, freshCourseCommercial } from "../lib/course-commercial-control";
import { closedEditorial } from "../lib/canary-editorial";
import { Courses } from "../collections/Courses";

const input = { accessModel: "FREE", priceKopecks: 0, expectedVersion: 0, commandKey: "synthetic-command-0001" };
const request = (overrides = {}) => ({ user: { id: 7, collection: "users" }, url: "https://cms.example/api/courses/commercial-summary/one",
  routeParams: { courseRef: "one" }, headers: new Headers({ origin: "https://cms.example" }), json: async () => input,
  payload: { find: vi.fn(async () => ({ docs: [{ courseRef: "one" }] })) }, ...overrides });
beforeEach(() => { vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "https://private-commerce.example"); vi.stubEnv("PLATFORM_COMMERCE_SERVICE_TOKEN", "synthetic-secret"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const invoke = (overrides = {}) => courseCommercialWrite.handler(request(overrides) as never);
describe("Payload author-only canonical access editor", () => {
  it.each([null, { collection: "students", id: 7 }])("refuses non-author %j", async user => {
    const fetch = vi.spyOn(globalThis, "fetch"); expect((await invoke({ user })).status).toBe(401); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, "https://foreign.example"])("refuses missing/foreign Origin %s", async origin => {
    expect((await invoke({ headers: new Headers(origin ? { origin } : {}) })).status).toBe(403);
  });
  it("requires a real saved course and enforces collection access", async () => {
    const req = request({ payload: { find: vi.fn(async () => ({ docs: [] })) } });
    expect((await courseCommercialWrite.handler(req as never)).status).toBe(409);
    expect(req.payload.find).toHaveBeenCalledWith(expect.objectContaining({ overrideAccess: false, collection: "courses", where: { courseRef: { equals: "one" } } }));
  });
  it("derives actor server-side and never sends forged sale mode, course or product identities", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ...input, version: 1, saleMode: "CLOSED", cacheRefresh: "CONFIRMED", token: "never expose" }));
    const response = await invoke({ json: async () => ({ ...input, actor: "forged", saleMode: "PUBLIC", productRef: "foreign" }) });
    expect(response.status).toBe(200); expect(await response.text()).not.toContain("never expose");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ ...input, actor: "payload:7" });
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { authorization: "Bearer synthetic-secret", "content-type": "application/json" } });
  });
  it.each([{ accessModel: "FREE", priceKopecks: 1 }, { accessModel: "PAID", priceKopecks: 0 }, { priceKopecks: "100" }, { expectedVersion: -1 }])("rejects malformed command %j", async change => {
    const fetch = vi.spyOn(globalThis, "fetch"); expect((await invoke({ json: async () => ({ ...input, ...change }) })).status).toBe(422); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps ambiguity and transport failures fail closed with no raw exception", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic-secret"));
    expect(await (await invoke()).json()).toEqual({ code: "COMMERCE_WRITE_UNCONFIRMED" });
  });
  it("reads only safe fresh canonical fields and rejects ambiguous data", async () => {
    const row = { courseRef: "one", accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", withdrawn: 0, offerRef: "offer", version: 1, token: "secret" };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ courses: [row] }));
    expect(await freshCourseCommercial("one")).not.toHaveProperty("token");
    fetch.mockResolvedValue(Response.json({ courses: [row, row] })); await expect(freshCourseCommercial("one")).rejects.toThrow("COURSE_PRODUCT_AMBIGUOUS");
  });
  it("keeps canary preparation mutations closed and data UI-only", async () => {
    const closed = closedEditorial(Courses).endpoints;
    const route = Array.isArray(closed) && closed.find(endpoint => endpoint.path === courseCommercialWrite.path && endpoint.method === "post");
    expect(route && (await route.handler(request() as never)).status).toBe(403);
    expect(Courses.fields.find(field => "name" in field && field.name === "commercialSummary")).toMatchObject({ type: "ui" });
  });
});
