import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import sitemap from "../app/sitemap";
import { GET as robots } from "../app/robots.txt/route";
import { GET as searchIndex } from "../app/search-index.json/route";
import { generateMetadata as courseMetadata } from "../app/(frontend)/courses/[slug]/page";
import { generateMetadata as lessonMetadata } from "../app/(frontend)/courses/[slug]/lessons/[lessonSlug]/page";
import { courseJsonLd, jsonLdScript, lessonJsonLd, robotsTxt } from "../lib/seo";

const { connection } = vi.hoisted(() => ({ connection: vi.fn(async () => {}) }));
// Outside Next there is no request scope; the stub records that each route opts into request-time rendering.
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), connection }));

const privateVideoId = "kinescope-private-7f3a";
const commercial = (courseRef: string) => ({ courseRef, offerRef: null, accessModel: "FREE", saleMode: "CLOSED",
  priceKopecks: null, withdrawn: false, activeVideoId: privateVideoId });
// Commerce never sends video bindings; the extra fields prove the platform output is an allowlist anyway.
const course = (slug: string, version: number, updatedAt: string) => ({
  courseRef: `course-${slug}`, version, title: `Курс ${slug}`, slug, summary: `Описание ${slug}`, description: null,
  seo: slug === "one" ? { title: "SEO курс", description: "SEO описание" } : null,
  publicContentUpdatedAt: updatedAt, kinescopeVideoId: privateVideoId,
});
const outline = { sections: [{ sectionRef: "section", title: "Раздел", position: 0 }],
  lessons: [{ lessonRef: "lesson-ref", sectionRef: "section", title: "Урок", slug: "intro", position: 0,
    freePreview: false, videoId: privateVideoId }] };
const courseDetail = (slug: string, version = 3) => ({
  course: course(slug, version, "2026-10-17T10:00:00.000Z"), commercial: commercial(`course-${slug}`), outline,
});
const lessonDetail = (slug: string) => ({ ...courseDetail(slug), section: outline.sections[0],
  lesson: { ...outline.lessons[0], description: null, seo: null, active_video_id: privateVideoId } });

let responses: Response[];
let fetcher: MockInstance<typeof fetch>;
const commercePaths = () => fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname);

beforeEach(() => {
  vi.stubEnv("COMMERCE_INTERNAL_ORIGIN", "http://commerce.test:3002");
  vi.stubEnv("PLATFORM_ORIGIN", "https://flexperiment.ru");
  responses = [];
  fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected Commerce request");
    return next;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); connection.mockClear(); });

describe("SEO effects rendered from the committed Commerce authority", () => {
  it("drops an unlisted or withdrawn course from the next sitemap render", async () => {
    responses.push(
      Response.json({ courses: [
        { course: course("one", 3, "2026-10-17T10:00:00.000Z"), commercial: commercial("course-one") },
        { course: course("two", 1, "2026-10-16T10:00:00.000Z"), commercial: commercial("course-two") },
      ] }),
      // Commerce omits a course from its public listing once it is unlisted or its product is withdrawn.
      Response.json({ courses: [{ course: course("one", 4, "2026-10-18T09:00:00.000Z"), commercial: commercial("course-one") }] }),
    );
    expect(await sitemap()).toEqual([
      { url: "https://flexperiment.ru", changeFrequency: "weekly", priority: 1 },
      { url: "https://flexperiment.ru/courses", changeFrequency: "daily", priority: 0.9 },
      { url: "https://flexperiment.ru/courses/one", lastModified: "2026-10-17T10:00:00.000Z", changeFrequency: "weekly", priority: 0.8 },
      { url: "https://flexperiment.ru/courses/two", lastModified: "2026-10-16T10:00:00.000Z", changeFrequency: "weekly", priority: 0.8 },
    ]);
    const next = await sitemap();
    expect(next.map(({ url }) => url)).toEqual([
      "https://flexperiment.ru", "https://flexperiment.ru/courses", "https://flexperiment.ru/courses/one",
    ]);
    expect(next[2]?.lastModified).toBe("2026-10-18T09:00:00.000Z");
    expect(commercePaths()).toEqual(["/v1/courses", "/v1/courses"]);
    expect(connection).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ cache: "no-store" });
    expect(JSON.stringify(next)).not.toContain(privateVideoId);
  });

  it("fails closed instead of publishing a sitemap without the Commerce listing", async () => {
    responses.push(new Response(null, { status: 503 }));
    await expect(sitemap()).rejects.toThrow("COMMERCE_CONTENT_UNAVAILABLE");
  });

  it("derives course canonical and robots from the published version, and de-indexes it once hidden", async () => {
    responses.push(Response.json(courseDetail("one")), new Response(null, { status: 404 }));
    const params = Promise.resolve({ slug: "one" });
    const listed = await courseMetadata({ params });
    expect(listed).toMatchObject({
      title: "SEO курс", description: "SEO описание",
      alternates: { canonical: "/courses/one" }, openGraph: { url: "/courses/one" },
    });
    expect(listed.robots).toBeUndefined();
    const hidden = await courseMetadata({ params: Promise.resolve({ slug: "one" }) });
    expect(hidden).toEqual({ robots: { index: false, follow: false } });
    expect(commercePaths()).toEqual(["/v1/courses/one", "/v1/courses/one"]);
    expect(JSON.stringify(listed)).not.toContain(privateVideoId);
  });

  it("keeps public lesson pages canonical but out of the index, and de-indexes hidden lessons", async () => {
    responses.push(Response.json(lessonDetail("one")), new Response(null, { status: 404 }));
    const lesson = await lessonMetadata({ params: Promise.resolve({ slug: "one", lessonSlug: "intro" }) });
    expect(lesson).toMatchObject({
      title: "Урок", robots: { index: false, follow: true },
      alternates: { canonical: "/courses/one/lessons/intro" }, openGraph: { url: "/courses/one/lessons/intro" },
    });
    expect(await lessonMetadata({ params: Promise.resolve({ slug: "one", lessonSlug: "intro" }) }))
      .toEqual({ robots: { index: false, follow: false } });
    expect(commercePaths()).toEqual(["/v1/courses/one/lessons/intro", "/v1/courses/one/lessons/intro"]);
    expect(JSON.stringify(lesson)).not.toContain(privateVideoId);
  });

  it.each([false, true])("keeps public HTTP lesson metadata noindex with freePreview=%s", async freePreview => {
    const detail = lessonDetail("one");
    detail.lesson.freePreview = freePreview;
    responses.push(Response.json(detail));
    const metadata = await lessonMetadata({ params: Promise.resolve({ slug: "one", lessonSlug: "intro" }) });
    expect(metadata.robots).toEqual({ index: false, follow: true });
    expect(commercePaths()).toEqual(["/v1/courses/one/lessons/intro"]);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("never renders build shells as indexable pages or asks Commerce for them", async () => {
    expect(await courseMetadata({ params: Promise.resolve({ slug: "__build-shell__" }) }))
      .toEqual({ robots: { index: false, follow: false } });
    expect(await lessonMetadata({ params: Promise.resolve({ slug: "__build-shell__", lessonSlug: "__build-shell__" }) }))
      .toEqual({ robots: { index: false, follow: false } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("emits schema.org and search output from an allowlist without Kinescope identifiers", async () => {
    const detail = lessonDetail("one") as unknown as Parameters<typeof lessonJsonLd>[1];
    const structured = [...courseJsonLd("https://flexperiment.ru", detail), ...lessonJsonLd("https://flexperiment.ru", detail)];
    expect(structured.map(value => value["@type"])).toEqual(["Course", "BreadcrumbList", "LearningResource", "BreadcrumbList"]);
    expect(structured[3]).toMatchObject({ itemListElement: [{}, {}, { item: "https://flexperiment.ru/courses/one" },
      { item: "https://flexperiment.ru/courses/one/lessons/intro" }] });
    expect(structured[2]).toMatchObject({ isAccessibleForFree: true });
    responses.push(
      Response.json({ courses: [{ course: course("one", 3, "2026-10-17T10:00:00.000Z"), commercial: commercial("course-one") }] }),
      Response.json(courseDetail("one")),
    );
    const search = await (await searchIndex()).text();
    expect(JSON.parse(search)).toEqual([
      { type: "course", ref: "course-one", title: "Курс one", summary: "Описание one", url: "/courses/one" },
      { type: "lesson", ref: "lesson-ref", title: "Урок", summary: "Курс one", url: "/courses/one/lessons/intro" },
    ]);
    for (const output of [...structured.map(jsonLdScript), search]) {
      expect(output).not.toContain(privateVideoId);
      expect(output).not.toMatch(/videoId|video_id|kinescope/i);
    }
    expect(jsonLdScript({ name: "</script><script>alert(1)</script>" })).not.toContain("<");
  });

  it("publishes crawl rules only for production and never invites crawling of private surfaces", async () => {
    const production = robotsTxt("https://flexperiment.ru", "production");
    expect(production).toContain("Sitemap: https://flexperiment.ru/sitemap.xml");
    for (const path of ["/account", "/checkout/", "/v1/"]) expect(production).toContain(`Disallow: ${path}\n`);
    expect(production).not.toMatch(/Disallow: \/courses/);
    expect(robotsTxt("https://canary.flexperiment.ru", "staging")).toBe("User-agent: *\nDisallow: /\n");
    expect(robotsTxt("https://flexperiment.ru", undefined)).toBe("User-agent: *\nDisallow: /\n");

    vi.stubEnv("DEPLOY_ENV", "production");
    const response = await robots();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(production);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
