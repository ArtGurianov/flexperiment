import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCourseImage } from "../lib/public-media";
import { courseJsonLd, courseMetadata, indexNowRequest, lessonMetadata, publicSitemap, robotsTxt } from "../lib/seo";
import { analyticsConsentFromCookie, analyticsConsentSetCookie, safeAnalyticsLocation } from "../lib/analytics-consent";
import type { CourseDetail, LessonDetail } from "../lib/content/public";

const media = "https://flexperiment.s3.cloud.ru/course-media/public/course-one/abc";
const image = (patch: (variants: Array<Record<string, unknown>>) => void = () => {}) => {
  const variants: Array<Record<string, unknown>> = [
    { name: "card", url: `${media}/card.webp`, width: 960, height: 640 },
    { name: "hero", url: `${media}/hero.webp`, width: 1920, height: 1080 },
    { name: "og", url: `${media}/og.webp`, width: 1200, height: 630 },
  ];
  patch(variants);
  return { alt: "Танцор в стойке", variants };
};
const detail = (courseImage?: unknown): CourseDetail => ({
  course: { courseRef: "course-one", version: 1, title: "Курс", slug: "one", summary: "Описание", description: null,
    seo: null, publicContentUpdatedAt: "2026-11-20T10:00:00.000Z", ...(courseImage === undefined ? {} : { image: courseImage }) },
  commercial: { courseRef: "course-one", offerRef: null, accessModel: "FREE", saleMode: "CLOSED", priceKopecks: null, withdrawn: false },
  outline: { sections: [], lessons: [] },
} as unknown as CourseDetail);

beforeEach(() => vi.stubEnv("S3_PUBLIC_URL", "https://flexperiment.s3.cloud.ru"));
afterEach(() => vi.unstubAllEnvs());

describe("FLEX-63 course image on public surfaces", () => {
  it("publishes the 1200×630 OG variant with alt, and hero/card in Course JSON-LD and the sitemap", () => {
    const withImage = detail(image());
    expect(courseMetadata(withImage).openGraph).toMatchObject({
      images: [{ url: `${media}/og.webp`, width: 1200, height: 630, alt: "Танцор в стойке", type: "image/webp" }],
    });
    expect(courseMetadata(withImage).twitter).toMatchObject({ card: "summary_large_image" });
    expect(courseJsonLd("https://flexperiment.ru", withImage)[0]).toMatchObject({
      image: [`${media}/hero.webp`, `${media}/og.webp`, `${media}/card.webp`],
    });
    expect(publicSitemap("https://flexperiment.ru", [withImage])[2]).toMatchObject({ images: [`${media}/hero.webp`] });
    const lesson = { ...withImage, section: { sectionRef: "s", title: "Раздел", position: 0 },
      lesson: { lessonRef: "l", sectionRef: "s", title: "Урок", slug: "intro", position: 0, freePreview: false, description: null } };
    expect(lessonMetadata(lesson as LessonDetail).openGraph).toMatchObject({ images: [{ url: `${media}/og.webp` }] });
  });

  it.each([
    ["no image", undefined],
    ["null image", null],
    ["foreign origin", image((v) => { v[2].url = "https://evil.test/og.webp"; })],
    ["outside the media path", image((v) => { v[2].url = "https://flexperiment.s3.cloud.ru.evil.test/og.webp"; })],
    ["wrong size", image((v) => { v[1].width = 1280; })],
    ["missing variant", image((v) => { v.pop(); })],
    ["signed URL", image((v) => { v[0].url = `${media}/card.webp?X-Amz-Signature=abc`; })],
    ["non-WebP", image((v) => { v[0].url = `${media}/card.png`; })],
    ["empty alt", { ...image(), alt: " " }],
  ])("falls back to a text-only page for %s", (_name, value) => {
    const withoutImage = detail(value);
    expect(courseMetadata(withoutImage).openGraph).not.toHaveProperty("images");
    expect(courseMetadata(withoutImage)).not.toHaveProperty("twitter");
    expect(courseJsonLd("https://flexperiment.ru", withoutImage)[0]).not.toHaveProperty("image");
    expect(publicSitemap("https://flexperiment.ru", [withoutImage])[2]).not.toHaveProperty("images");
  });

  it("does not fail a page render when the media origin is misconfigured", () => {
    vi.stubEnv("S3_PUBLIC_URL", "http://insecure.test");
    expect(() => parseCourseImage(image())).toThrow("S3_PUBLIC_URL_INVALID");
    expect(courseMetadata(detail(image())).openGraph).not.toHaveProperty("images");
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
