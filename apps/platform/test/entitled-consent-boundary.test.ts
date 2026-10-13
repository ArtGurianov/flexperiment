import { afterEach, describe, expect, it, vi } from "vitest";
import { accountLibrary, entitledCourse, entitledLesson, viewerCourse, viewerLesson } from "../lib/content/entitled";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Commerce private content transport", () => {
  it("passes the same session to Commerce and never caches private data", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(Response.json({ courses: [{ courseRef: "course" }] }))
      .mockResolvedValueOnce(Response.json({ course: { courseRef: "course", slug: "course" } }));
    expect(await accountLibrary("synthetic-cookie")).toEqual([{ courseRef: "course" }]);
    expect(fetcher.mock.calls[0]).toMatchObject([new URL("http://isolated-commerce:3002/v1/me/course-library"),
      { headers: { cookie: "synthetic-cookie" }, cache: "no-store", redirect: "error" }]);
    expect(await entitledLesson("", "course", "lesson")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await entitledCourse("synthetic-cookie", "course")).toMatchObject({ course: { courseRef: "course" } });
    expect(fetcher.mock.calls[1]).toMatchObject([new URL("http://isolated-commerce:3002/v1/me/courses/course"),
      { headers: { cookie: "synthetic-cookie" }, cache: "no-store", redirect: "error" }]);
  });

  it("treats session and consent refusal as denial and backend failure as unavailable", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch");
    for (const status of [401, 403, 404]) {
      fetcher.mockResolvedValueOnce(new Response(null, { status }));
      expect(await entitledLesson("synthetic-cookie", "course", "lesson")).toBeNull();
    }
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(entitledLesson("synthetic-cookie", "course", "lesson")).rejects.toThrow("COMMERCE_CONTENT_UNAVAILABLE");
  });

  it("uses the entitled SSR read for an unlisted owner without calling the public endpoint", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(Response.json({ course: { slug: "unlisted" }, outline: { lessons: [] } }))
      .mockResolvedValueOnce(Response.json({ lesson: { slug: "hidden", description: { private: true } } }));
    expect(await viewerCourse("owner-cookie", "unlisted")).toMatchObject({ course: { slug: "unlisted" } });
    expect(await viewerLesson("owner-cookie", "unlisted", "hidden"))
      .toMatchObject({ lesson: { description: { private: true } } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://isolated-commerce:3002/v1/me/courses/unlisted",
      "http://isolated-commerce:3002/v1/me/courses/unlisted/lessons/hidden",
    ]);
  });

  it("falls back only to the public listed read when private access is denied", async () => {
    vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://isolated-commerce:3002");
    const fetcher = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ lesson: { slug: "listed", description: null } }));
    expect(await viewerCourse("revoked-cookie", "unlisted")).toBeNull();
    expect(await viewerLesson("visitor-cookie", "listed", "listed"))
      .toMatchObject({ lesson: { slug: "listed", description: null } });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://isolated-commerce:3002/v1/me/courses/unlisted",
      "http://isolated-commerce:3002/v1/courses/unlisted",
      "http://isolated-commerce:3002/v1/me/courses/listed/lessons/listed",
      "http://isolated-commerce:3002/v1/courses/listed/lessons/listed",
    ]);
  });
});
