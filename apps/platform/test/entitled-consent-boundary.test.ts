import { afterEach, describe, expect, it, vi } from "vitest";
import { getPayload } from "payload";
import { entitledCourse, listEntitledCourses } from "../lib/content/entitled";
vi.mock("payload", () => ({ getPayload: vi.fn() }));
vi.mock("@payload-config", () => ({ default: {} }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("Payload private readers require server-authoritative course consent", () => {
  it.each(["missing", "unverified", "wrong storefront", "unconfirmed", "error"])("does not read private editorial data for %s", async state => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    vi.spyOn(global, "fetch").mockImplementation(async input => String(input).includes("/consents")
      ? Response.json({ storefront: state === "wrong storefront" ? "LAB" : "COURSES", verifiedAccount: state !== "unverified",
        requiredChoicesConfirmed: state !== "unconfirmed" && state !== "missing" }, { status: state === "error" ? 503 : 200 })
      : Response.json({ customer: { id: "synthetic" }, entitlements: [{ scope: "ALL_COURSES" }] }));
    expect(await listEntitledCourses("synthetic-cookie")).toEqual([]);
    expect(await entitledCourse("synthetic-cookie", "arbitrary-course")).toBeNull();
    expect(getPayload).not.toHaveBeenCalled();
  });
  it("checks both no-store authorities before querying entitled content", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch").mockImplementation(async input => String(input).includes("/consents")
      ? Response.json({ storefront: "COURSES", verifiedAccount: true, requiredChoicesConfirmed: true })
      : Response.json({ customer: { id: "synthetic" }, entitlements: [{ scope: "ALL_COURSES" }] }));
    const find = vi.fn(async () => ({ docs: [] }));
    vi.mocked(getPayload).mockResolvedValue({ find } as never);
    expect(await listEntitledCourses("synthetic-cookie")).toEqual([]);
    expect(find).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ headers: { cookie: "synthetic-cookie" }, cache: "no-store" });
  });
});
