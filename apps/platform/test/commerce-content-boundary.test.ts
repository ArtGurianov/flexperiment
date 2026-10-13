import { afterEach, describe, expect, it, vi } from "vitest";
import { publicCourse, publicCourses, publicLesson } from "../lib/content/public";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Payload-free storefront transport", () => {
  it("reads the committed Commerce model without caching or a local fallback", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch").mockResolvedValueOnce(Response.json({ courses: [] }))
      .mockResolvedValueOnce(Response.json({ course: { slug: "course", version: 3 } }))
      .mockResolvedValueOnce(Response.json({ lesson: { lessonRef: "lesson" } }));
    expect(await publicCourses()).toEqual([]);
    expect(await publicCourse("course")).toMatchObject({ course: { version: 3 } });
    expect(await publicLesson("course", "lesson")).toMatchObject({ lesson: { lessonRef: "lesson" } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://isolated-commerce:3002/v1/courses",
      "http://isolated-commerce:3002/v1/courses/course",
      "http://isolated-commerce:3002/v1/courses/course/lessons/lesson",
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
  });

  it("maps an absent or unlisted course to null and refuses backend failure", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch").mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(await publicCourse("unlisted")).toBeNull();
    await expect(publicCourse("listed")).rejects.toThrow("COMMERCE_CONTENT_UNAVAILABLE");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
