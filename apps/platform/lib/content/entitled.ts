import type { CourseDetail, LessonDetail } from "./public";

export type AccountLibraryCourse = {
  courseRef: string; title: string; url: string; access: "ENTITLED" | "FREE" | "PREVIEW";
  lessons: Array<{ lessonRef: string; title: string; sectionTitle: string; url: string;
    access: "ENTITLED" | "FREE" | "PREVIEW" }>;
};

async function privateContent<T>(cookieHeader: string, path: string): Promise<T | null> {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) throw new Error("COMMERCE_CONTENT_NOT_CONFIGURED");
  if (!cookieHeader) return null;
  const response = await fetch(new URL(path, origin), {
    headers: { cookie: cookieHeader }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3_000),
  });
  if ([401, 403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error("COMMERCE_CONTENT_UNAVAILABLE");
  return await response.json() as T;
}

export async function accountLibrary(cookieHeader: string): Promise<AccountLibraryCourse[]> {
  return (await privateContent<{ courses: AccountLibraryCourse[] }>(cookieHeader, "/v1/me/course-library"))?.courses ?? [];
}

export function entitledCourse(cookieHeader: string, courseSlug: string) {
  return privateContent<CourseDetail>(cookieHeader, `/v1/me/courses/${encodeURIComponent(courseSlug)}`);
}

export function entitledLesson(cookieHeader: string, courseSlug: string, lessonSlug: string) {
  return privateContent<LessonDetail>(cookieHeader,
    `/v1/me/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`);
}
