import type { Metadata, MetadataRoute } from "next";
import type { CourseCommercialSummary } from "./commerce-summary";
import type { CourseDetail, LessonDetail, StorefrontCourse } from "./content/public";

type Breadcrumb = { readonly name: string; readonly path: string };

const notIndexable = { index: false, follow: false } as const;

export const coursePath = (courseSlug: string) => `/courses/${courseSlug}`;
export const lessonPath = (courseSlug: string, lessonSlug: string) => `${coursePath(courseSlug)}/lessons/${lessonSlug}`;

export function breadcrumbJsonLd(origin: string, items: readonly Breadcrumb[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: new URL(item.path, origin).toString(),
    })),
  };
}

export function courseOfferJsonLd(commercial: CourseCommercialSummary | undefined) {
  if (!commercial) return undefined;
  const availability = commercial.accessModel === "FREE" || commercial.saleMode === "PUBLIC"
    ? "https://schema.org/InStock"
    : commercial.saleMode === "ACCEPTANCE_ONLY"
      ? "https://schema.org/LimitedAvailability"
      : "https://schema.org/SoldOut";
  return {
    "@type": "Offer",
    priceCurrency: "RUB",
    price: commercial.accessModel === "FREE"
      ? "0"
      : commercial.priceKopecks === null
        ? undefined
        : String(commercial.priceKopecks / 100),
    availability,
  };
}

export function lessonIsAccessibleForFree(
  commercial: CourseCommercialSummary | undefined,
  freePreview: boolean,
) {
  return commercial?.accessModel === "FREE" || freePreview;
}

/**
 * Page metadata is read from the public Commerce projection on each request. A course that is absent there
 * (unlisted, withdrawn or never published) is not indexable, even when an entitled viewer can still read it.
 */
export function courseMetadata(detail: CourseDetail | null): Metadata {
  if (!detail) return { robots: notIndexable };
  const { course } = detail;
  const title = course.seo?.title || course.title;
  const description = course.seo?.description || course.summary;
  const path = coursePath(course.slug);
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, type: "website", url: path, locale: "ru_RU" },
  };
}

/** Public lesson pages carry no lesson body, so they stay out of the index unless Commerce publishes one. */
export function lessonMetadata(detail: LessonDetail | null): Metadata {
  if (!detail) return { robots: notIndexable };
  const { course, lesson } = detail;
  const description = lesson.seo?.description || `${lesson.title} — урок курса «${course.title}».`;
  const path = lessonPath(course.slug, lesson.slug);
  return {
    title: lesson.seo?.title || lesson.title,
    description,
    robots: lesson.description ? undefined : { index: false, follow: true },
    alternates: { canonical: path },
    openGraph: { title: lesson.title, description, type: "video.other", url: path, locale: "ru_RU" },
  };
}

export function courseJsonLd(origin: string, { course, commercial }: Pick<CourseDetail, "course" | "commercial">) {
  return [{
    "@context": "https://schema.org", "@type": "Course",
    name: course.title, description: course.summary,
    provider: { "@type": "Organization", name: "Flexperiment" },
    offers: courseOfferJsonLd(commercial),
  }, breadcrumbJsonLd(origin, [
    { name: "Главная", path: "/" },
    { name: "Курсы", path: "/courses" },
    { name: course.title, path: coursePath(course.slug) },
  ])];
}

export function lessonJsonLd(origin: string, { course, commercial, lesson }: Pick<LessonDetail, "course" | "commercial" | "lesson">) {
  return [{
    "@context": "https://schema.org", "@type": "LearningResource",
    name: lesson.title, isPartOf: { "@type": "Course", name: course.title },
    isAccessibleForFree: lessonIsAccessibleForFree(commercial, lesson.freePreview),
  }, breadcrumbJsonLd(origin, [
    { name: "Главная", path: "/" },
    { name: "Курсы", path: "/courses" },
    { name: course.title, path: coursePath(course.slug) },
    { name: lesson.title, path: lessonPath(course.slug, lesson.slug) },
  ])];
}

/** Serializes JSON-LD for an inline script without letting content close the element. */
export const jsonLdScript = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Only listed, non-withdrawn courses reach this list; lesson pages are noindex and stay out of it. */
export function publicSitemap(
  origin: string,
  courses: ReadonlyArray<{ readonly course: Pick<StorefrontCourse, "slug" | "publicContentUpdatedAt"> }>,
): MetadataRoute.Sitemap {
  return [
    { url: origin, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/courses`, changeFrequency: "daily", priority: 0.9 },
    ...courses.map(({ course }) => ({
      url: new URL(coursePath(course.slug), origin).toString(),
      lastModified: course.publicContentUpdatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}

export function robotsTxt(origin: string, deployEnv: string | undefined) {
  if (deployEnv !== "production") return "User-agent: *\nDisallow: /\n";
  return [
    "User-agent: *", "Allow: /", "Disallow: /admin/", "Disallow: /api/", "Disallow: /account",
    "Disallow: /checkout/", "Disallow: /v1/",
    "Clean-param: utm_source&utm_medium&utm_campaign&utm_content&utm_term&yclid&gclid /courses",
    `Sitemap: ${origin}/sitemap.xml`, "",
  ].join("\n");
}
