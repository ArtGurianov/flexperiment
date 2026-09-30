import type { MetadataRoute } from "next";
import { publicCourses, publicSearchDocuments } from "@/lib/content/public";
import { getCommercialSummaries } from "@/lib/commerce-summary";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:3001";
  const [courses, searchDocuments, commercial] = await Promise.all([publicCourses(), publicSearchDocuments(), getCommercialSummaries()]);
  return [
    { url: origin, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/courses`, changeFrequency: "daily", priority: 0.9 },
    ...courses.flatMap((course) => commercial.get(course.courseRef)?.withdrawn ? [] : [{
      url: `${origin}/courses/${course.slug}`,
      lastModified: course.publicContentUpdatedAt ?? undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }]),
    ...searchDocuments.flatMap((document) => document.type !== "lesson" || commercial.get(document.courseRef)?.withdrawn ? [] : [{
      url: `${origin}${document.url}`,
      lastModified: document.lastModified ?? undefined,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }]),
  ];
}
