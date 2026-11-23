import { describe, expect, it } from "vitest";
import { COURSE_IMAGE_MANIFEST, courseImageFor } from "../lib/public-media";
import { courseJsonLd, courseMetadata, indexNowRequest, lessonMetadata, publicSitemap, robotsTxt } from "../lib/seo";
import { analyticsConsentFromCookie, analyticsConsentSetCookie, safeAnalyticsLocation } from "../lib/analytics-consent";
import type { CourseDetail, LessonDetail } from "../lib/content/public";

const origin = "https://flexperiment.ru";
const detail = (courseRef: string, title = "Основы флексинга"): CourseDetail => ({
  course: { courseRef, version: 1, title, slug: "one", summary: "Описание", description: null,
    seo: null, publicContentUpdatedAt: "2026-11-20T10:00:00.000Z" },
  commercial: { courseRef, offerRef: null, accessModel: "FREE", saleMode: "CLOSED", priceKopecks: null, withdrawn: false },
  outline: { sections: [], lessons: [] },
} as unknown as CourseDetail);

describe("FLEX-63 Stage A static course image on public surfaces", () => {
  it("publishes the prepared WebP at its honest size with title-derived alt", () => {
    const withImage = detail("basics");
    expect(courseMetadata(withImage).openGraph).toMatchObject({
      images: [{ url: "/course-covers/course-main-basics.webp", width: 1126, height: 1397,
        alt: "Обложка курса «Основы флексинга»", type: "image/webp" }],
    });
    expect(courseMetadata(withImage).twitter).toMatchObject({ card: "summary_large_image" });
    expect(courseJsonLd(origin, withImage)[0]).toMatchObject({ image: `${origin}/course-covers/course-main-basics.webp` });
    expect(publicSitemap(origin, [withImage])[2]).toMatchObject({ images: [`${origin}/course-covers/course-main-basics.webp`] });
    const lesson = { ...withImage, section: { sectionRef: "s", title: "Раздел", position: 0 },
      lesson: { lessonRef: "l", sectionRef: "s", title: "Урок", slug: "intro", position: 0, freePreview: false, description: null } };
    expect(lessonMetadata(lesson as LessonDetail).openGraph).toMatchObject({ images: [{ url: "/course-covers/course-main-basics.webp" }] });
  });

  it.each([
    ["an unmapped courseRef", "course-without-artwork", "Курс"],
    ["a slug that only resembles an artwork name", "Basics", "Курс"],
    ["an empty title (no honest alt)", "basics", "   "],
  ])("falls back to a text-only page for %s", (_name, courseRef, title) => {
    const withoutImage = detail(courseRef, title);
    expect(courseImageFor(withoutImage.course)).toBeNull();
    expect(courseMetadata(withoutImage).openGraph).not.toHaveProperty("images");
    expect(courseMetadata(withoutImage)).not.toHaveProperty("twitter");
    expect(courseJsonLd(origin, withoutImage)[0]).not.toHaveProperty("image");
    expect(publicSitemap(origin, [withoutImage])[2]).not.toHaveProperty("images");
  });

  it("binds each artwork to exactly one courseRef and path", () => {
    expect(new Set(COURSE_IMAGE_MANIFEST.map((entry) => entry.courseRef)).size).toBe(COURSE_IMAGE_MANIFEST.length);
    expect(new Set(COURSE_IMAGE_MANIFEST.map((entry) => entry.path)).size).toBe(COURSE_IMAGE_MANIFEST.length);
  });
});

describe("FLEX-70 IndexNow, robots and analytics boundaries", () => {
  it("builds one IndexNow request for canonical public course and lesson URLs only", () => {
    const request = indexNowRequest("https://flexperiment.ru", "a1b2c3d4e5f6", [
      "/courses/one", "/courses/one", "/courses/one/lessons/intro", "/account", "/courses/one?utm_source=x", "https://evil.test/x",
    ])!;
    expect(request.url).toBe("https://yandex.com/indexnow");
    expect(JSON.parse(request.init.body)).toEqual({
      host: "flexperiment.ru", key: "a1b2c3d4e5f6", keyLocation: "https://flexperiment.ru/indexnow-key.txt",
      urlList: ["https://flexperiment.ru/courses/one", "https://flexperiment.ru/courses/one/lessons/intro"],
    });
    expect(indexNowRequest("https://flexperiment.ru", undefined, ["/courses/one"])).toBeNull();
    expect(indexNowRequest("https://flexperiment.ru", "bad key!", ["/courses/one"])).toBeNull();
    expect(indexNowRequest("https://flexperiment.ru", "a1b2c3d4e5f6", ["/account"])).toBeNull();
  });

  it("scopes Clean-param to marketing parameters and never strips auth or return parameters", () => {
    const robots = robotsTxt("https://flexperiment.ru", "production");
    const clean = robots.split("\n").find((line) => line.startsWith("Clean-param:"))!;
    expect(clean).toBe("Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid /courses");
    for (const forbidden of ["rt", "state", "return", "token", "code"]) expect(clean.split(/[ &]/)).not.toContain(forbidden);
    expect(robotsTxt("https://flexperiment.ru", "staging")).toBe("User-agent: *\nDisallow: /\n");
  });

  it("tracks only consented, sanitized public locations", () => {
    expect(analyticsConsentFromCookie("a=1; fx_consent=v1%3Aa1")).toBe("ALLOWED");
    expect(analyticsConsentFromCookie("fx_consent=v1:a0")).toBe("DENIED");
    expect(analyticsConsentFromCookie("fx_consent=%E0%A4%A")).toBe("UNDECIDED");
    expect(analyticsConsentSetCookie("DENIED")).toContain("Secure");
    expect(safeAnalyticsLocation("/courses/one", "?utm_source=vk&rt=secret&email=a%40b.ru")).toBe("/courses/one?utm_source=vk");
    expect(safeAnalyticsLocation("/account", "")).toBeNull();
    expect(safeAnalyticsLocation("/admin/x", "")).toBeNull();
  });
});
