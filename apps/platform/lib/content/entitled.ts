import { getPayload, type Where } from "payload";
import config from "@payload-config";
import {
  relationId,
  type PublicCourse,
  type PublicLesson,
} from "./editorial";

type ActiveEntitlement = {
  scope: "COURSE" | "ALL_COURSES";
  course_ref?: string | null;
};

type CourseAuthorization = {
  allCourses: boolean;
  courseRefs: string[];
};

async function authorizeCourses(cookieHeader: string): Promise<CourseAuthorization | null> {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin || !cookieHeader) return null;
  const response = await fetch(new URL("/v1/me", origin), {
    headers: { cookie: cookieHeader },
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { customer?: unknown; entitlements?: ActiveEntitlement[] };
  if (!body.customer) return null;
  const entitlements = body.entitlements ?? [];
  return {
    allCourses: entitlements.some(({ scope }) => scope === "ALL_COURSES"),
    courseRefs: entitlements.flatMap(({ scope, course_ref }) => scope === "COURSE" && course_ref ? [course_ref] : []),
  };
}

const entitledCourseWhere = (authorization: CourseAuthorization, slug?: string) => {
  const and: Where[] = [
    { _status: { equals: "published" } },
    { everPublished: { equals: true } },
  ];
  if (slug) and.push({ slug: { equals: slug } });
  if (!authorization.allCourses) and.push({ courseRef: { in: authorization.courseRefs } });
  return {
    and,
  };
};

const courseSelect = {
  courseRef: true, title: true, slug: true, summary: true, description: true, hero: true,
  displayDate: true, publicContentUpdatedAt: true, visibility: true, seo: true,
} as const;

async function entitledOutline(courseId: number | string) {
  const payload = await getPayload({ config });
  const [sections, lessons] = await Promise.all([
    payload.find({
      collection: "sections", depth: 0, draft: false, limit: 1000,
      overrideAccess: true, pagination: false, sort: "position",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { everPublished: { equals: true } }] },
      select: { sectionRef: true, title: true, position: true, course: true, visibility: true, everPublished: true },
    }),
    payload.find({
      collection: "lessons", depth: 0, draft: false, limit: 5000,
      overrideAccess: true, pagination: false, sort: "position",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { everPublished: { equals: true } }] },
      select: {
        lessonRef: true, section: true, title: true, slug: true, description: true,
        position: true, durationSeconds: true, freePreview: true, visibility: true, seo: true, everPublished: true,
      },
    }),
  ]);
  const sectionIds = new Set(sections.docs.map(({ id }) => String(id)));
  return { sections: sections.docs, lessons: lessons.docs.filter((lesson) => sectionIds.has(String(relationId(lesson.section)))) };
}

export async function listEntitledCourses(cookieHeader: string): Promise<PublicCourse[]> {
  const authorization = await authorizeCourses(cookieHeader);
  if (!authorization || (!authorization.allCourses && authorization.courseRefs.length === 0)) return [];
  const payload = await getPayload({ config });
  const result = await payload.find({
    collection: "courses", depth: 1, draft: false, limit: 1000,
    overrideAccess: true, pagination: false, sort: "-displayDate",
    where: entitledCourseWhere(authorization), select: courseSelect,
  });
  return result.docs as unknown as PublicCourse[];
}

export async function entitledCourse(cookieHeader: string, slug: string) {
  const authorization = await authorizeCourses(cookieHeader);
  if (!authorization || (!authorization.allCourses && authorization.courseRefs.length === 0)) return null;
  const payload = await getPayload({ config });
  const result = await payload.find({
    collection: "courses", depth: 1, draft: false, limit: 1,
    overrideAccess: true, pagination: false,
    where: entitledCourseWhere(authorization, slug), select: courseSelect,
  });
  const course = result.docs[0] as unknown as PublicCourse | undefined;
  return course ? { course, outline: await entitledOutline(course.id) } : null;
}

export async function entitledLesson(cookieHeader: string, courseSlug: string, lessonSlug: string) {
  const courseResult = await entitledCourse(cookieHeader, courseSlug);
  if (!courseResult) return null;
  const payload = await getPayload({ config });
  const lessonResult = await payload.find({
    collection: "lessons", depth: 0, draft: false, limit: 1,
    overrideAccess: true, pagination: false,
    where: { and: [
      { course: { equals: courseResult.course.id } }, { slug: { equals: lessonSlug } },
      { _status: { equals: "published" } }, { everPublished: { equals: true } },
    ] },
    select: {
      lessonRef: true, section: true, title: true, slug: true, description: true,
      position: true, durationSeconds: true, freePreview: true, visibility: true, seo: true, everPublished: true,
    },
  });
  const lesson = lessonResult.docs[0] as unknown as PublicLesson | undefined;
  if (!lesson) return null;
  const section = courseResult.outline.sections.find(({ id }) => String(id) === String(relationId(lesson.section)));
  return section ? { course: courseResult.course, lesson, section } : null;
}
