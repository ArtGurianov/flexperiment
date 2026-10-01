import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const lookup = vi.hoisted(() => ({ publishedCourseSlug: vi.fn(async (courseRef: string) => courseRef === "course:one" ? "one" : null) }));
vi.mock("next/cache", () => cache);
vi.mock("@/lib/content/published-course", () => lookup);

const { POST } = await import("../app/internal/revalidate/route");

const revalidate = (body: unknown) => POST(new Request("https://platform.test/internal/revalidate", {
  method: "POST",
  headers: { authorization: "Bearer revalidation-token", "content-type": "application/json" },
  body: JSON.stringify(body),
}));

describe("platform revalidation boundary", () => {
  let indexNow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv("PLATFORM_REVALIDATE_TOKEN", "revalidation-token");
    vi.stubEnv("PLATFORM_ORIGIN", "https://platform.test");
    vi.stubEnv("INDEXNOW_KEY", "indexnow-key");
    indexNow = vi.fn(async () => new Response(null, { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(indexNow as unknown as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cache.revalidatePath.mockClear();
    lookup.publishedCourseSlug.mockClear();
  });

  it("announces a commerce withdrawal to IndexNow exactly once, for the withdrawn course", async () => {
    const response = await revalidate({ mode: "immediate", courseRef: "course:one", reason: "WITHDRAWN" });
    expect(response.status).toBe(200);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/courses/one");
    expect(indexNow).toHaveBeenCalledTimes(1);
    const [url, init] = indexNow.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.indexnow.org/indexnow");
    expect(JSON.parse(String(init.body)).urlList).toEqual([
      "https://platform.test/courses",
      "https://platform.test/search-index.json",
      "https://platform.test/sitemap.xml",
      "https://platform.test/courses/one",
    ]);
  });

  it("only expires caches for commercial edits and content invalidations", async () => {
    expect((await revalidate({ mode: "swr", courseRef: "course:one" })).status).toBe(200);
    expect((await revalidate({ mode: "immediate", slug: "one" })).status).toBe(200);
    expect(cache.revalidatePath).toHaveBeenCalledWith("/courses/one");
    expect(indexNow).not.toHaveBeenCalled();
  });

  it("does not announce a withdrawal that has no public course page", async () => {
    expect((await revalidate({ mode: "immediate", courseRef: "course:never-published", reason: "WITHDRAWN" })).status).toBe(200);
    expect((await revalidate({ mode: "immediate", reason: "WITHDRAWN" })).status).toBe(200);
    expect(indexNow).not.toHaveBeenCalled();
  });

  it("rejects callers without the revalidation token", async () => {
    const response = await POST(new Request("https://platform.test/internal/revalidate", {
      method: "POST", body: JSON.stringify({ mode: "immediate", courseRef: "course:one", reason: "WITHDRAWN" }),
    }));
    expect(response.status).toBe(401);
    expect(indexNow).not.toHaveBeenCalled();
  });
});
