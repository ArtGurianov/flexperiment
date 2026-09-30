import { getPayload } from "payload";
import config from "@payload-config";
import { getPublicCourseBySlug, getPublicLessonBySlugs, listPublicCourseOutline, listPublicCourses } from "./editorial";
import { unstable_cache } from "next/cache";

const payload = () => getPayload({ config });

export const publicCourses = unstable_cache(async () => {
  return listPublicCourses(await payload());
}, ["public-courses"], { revalidate: 3600, tags: ["catalog", "search"] });

export const publicCourse = unstable_cache(async (slug: string) => {
  const cms = await payload();
  const course = await getPublicCourseBySlug(cms, slug);
  if (!course) return null;
  return { course, outline: await listPublicCourseOutline(cms, course.id) };
}, ["public-course"], { revalidate: 3600, tags: ["course", "search"] });

export const publicLesson = unstable_cache(async (courseSlug: string, lessonSlug: string) => {
  return getPublicLessonBySlugs(await payload(), courseSlug, lessonSlug);
}, ["public-lesson"], { revalidate: 3600, tags: ["course", "lesson", "search"] });

export type PublicSearchDocument = {
  type: "course" | "lesson";
  ref: string;
  courseRef: string;
  title: string;
  summary: string;
  url: string;
  lastModified?: string | null;
};

export const publicSearchDocuments = unstable_cache(async (): Promise<PublicSearchDocument[]> => {
  const cms = await payload();
  const courses = await listPublicCourses(cms);
  const documents = await Promise.all(courses.map(async (course) => {
    const outline = await listPublicCourseOutline(cms, course.id);
    return [
      { type: "course" as const, ref: course.courseRef, courseRef: course.courseRef, title: course.title, summary: course.summary, url: `/courses/${course.slug}`, lastModified: course.publicContentUpdatedAt },
      ...outline.lessons.map((lesson) => ({
        type: "lesson" as const,
        ref: String(lesson.lessonRef),
        courseRef: course.courseRef,
        title: String(lesson.title),
        summary: course.title,
        url: `/courses/${course.slug}/lessons/${String(lesson.slug)}`,
        lastModified: course.publicContentUpdatedAt,
      })),
    ];
  }));
  return documents.flat();
}, ["public-search-documents"], { revalidate: 3600, tags: ["catalog", "course", "lesson", "search"] });
