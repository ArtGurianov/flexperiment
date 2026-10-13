import type { CourseCommercialSummary } from "@/lib/commerce-summary";

export type StorefrontCourse = {
  courseRef: string; version: number; title: string; slug: string; summary: string;
  description: unknown; seo: { title?: string; description?: string } | null;
  publicContentUpdatedAt: string;
};
export type StorefrontSection = { sectionRef: string; title: string; position: number };
export type StorefrontLesson = { lessonRef: string; sectionRef: string; title: string; slug: string;
  position: number; freePreview: boolean; description?: unknown; seo?: { title?: string; description?: string } | null };
export type StorefrontOutline = { sections: StorefrontSection[]; lessons: StorefrontLesson[] };
export type CourseDetail = { course: StorefrontCourse; commercial: CourseCommercialSummary; outline: StorefrontOutline };
export type LessonDetail = CourseDetail & { lesson: StorefrontLesson; section: StorefrontSection };

async function commerceGet<T>(path: string): Promise<T | null> {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) throw new Error("COMMERCE_CONTENT_NOT_CONFIGURED");
  const response = await fetch(new URL(path, origin), {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("COMMERCE_CONTENT_UNAVAILABLE");
  return await response.json() as T;
}

export async function publicCourses() {
  const result = await commerceGet<{ courses: Array<{ course: StorefrontCourse; commercial: CourseCommercialSummary }> }>("/v1/courses");
  if (!result) throw new Error("COMMERCE_CONTENT_UNAVAILABLE");
  return result.courses;
}

export const publicCourse = (slug: string) => commerceGet<CourseDetail>(`/v1/courses/${encodeURIComponent(slug)}`);

export const publicLesson = (courseSlug: string, lessonSlug: string) => commerceGet<LessonDetail>(
  `/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`,
);

export type PublicSearchDocument = {
  type: "course" | "lesson"; ref: string; courseRef: string; title: string; summary: string;
  url: string; lastModified?: string | null;
};

export async function publicSearchDocuments(): Promise<PublicSearchDocument[]> {
  const courses = await publicCourses();
  const details = await Promise.all(courses.map(({ course }) => publicCourse(course.slug)));
  return details.flatMap((detail) => {
    if (!detail) return [];
    const { course, outline } = detail;
    return [{ type: "course" as const, ref: course.courseRef, courseRef: course.courseRef,
      title: course.title, summary: course.summary, url: `/courses/${course.slug}`,
      lastModified: course.publicContentUpdatedAt },
    ...outline.lessons.map(lesson => ({ type: "lesson" as const, ref: lesson.lessonRef,
      courseRef: course.courseRef, title: lesson.title, summary: course.title,
      url: `/courses/${course.slug}/lessons/${lesson.slug}`,
      lastModified: course.publicContentUpdatedAt }))];
  });
}
