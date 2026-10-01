import { getPayload, type Where } from "payload";
import config from "@payload-config";
import {
  orderCourseTree,
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

type AuthorizedLibraryCourse = {
  courseRef: string;
  access: "ENTITLED" | "FREE" | "PREVIEW";
  lessons: Array<{ lessonRef: string; sectionRef: string; access: "ENTITLED" | "FREE" | "PREVIEW" }>;
};

export type AccountLibraryCourse = {
  courseRef: string;
  title: string;
  url: string;
  access: "ENTITLED" | "FREE" | "PREVIEW";
  lessons: Array<{
    lessonRef: string;
    title: string;
    sectionTitle: string;
    url: string;
    access: "ENTITLED" | "FREE" | "PREVIEW";
  }>;
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

async function authorizeLibrary(cookieHeader: string): Promise<AuthorizedLibraryCourse[]> {
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin || !cookieHeader) return [];
  const response = await fetch(new URL("/v1/library", origin), {
    headers: { cookie: cookieHeader },
    cache: "no-store",
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return [];
  const body = await response.json() as { courses?: AuthorizedLibraryCourse[] };
  return body.courses ?? [];
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
      overrideAccess: true, pagination: false, sort: "_sections_sections_order",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { everPublished: { equals: true } }] },
      select: { sectionRef: true, title: true, position: true, course: true, visibility: true, everPublished: true, _sections_sections_order: true },
    }),
    payload.find({
      collection: "lessons", depth: 0, draft: false, limit: 5000,
      overrideAccess: true, pagination: false, sort: "_lessons_lessons_order",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { everPublished: { equals: true } }] },
      select: {
        lessonRef: true, section: true, title: true, slug: true, description: true,
        position: true, durationSeconds: true, freePreview: true, visibility: true, seo: true, everPublished: true,
        _lessons_lessons_order: true,
      },
    }),
  ]);
  const ordered = orderCourseTree(sections.docs, lessons.docs);
  const sectionIds = new Set(ordered.sections.map(({ id }) => String(id)));
  return { sections: ordered.sections, lessons: ordered.lessons.filter((lesson) => sectionIds.has(String(relationId(lesson.section)))) };
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

export async function accountLibrary(cookieHeader: string): Promise<AccountLibraryCourse[]> {
  const authorized = await authorizeLibrary(cookieHeader);
  if (authorized.length === 0) return [];
  const payload = await getPayload({ config });
  const result = await payload.find({
    collection: "courses", depth: 1, draft: false, limit: 1000,
    overrideAccess: true, pagination: false, sort: "-displayDate",
    where: { and: [
      { _status: { equals: "published" } },
      { everPublished: { equals: true } },
      { courseRef: { in: authorized.map(({ courseRef }) => courseRef) } },
    ] },
    select: courseSelect,
  });
  const courses = new Map((result.docs as unknown as PublicCourse[]).map((course) => [course.courseRef, course]));
  const library: AccountLibraryCourse[] = [];
  for (const authorization of authorized) {
    const course = courses.get(authorization.courseRef);
    if (!course) continue;
    const outline = await entitledOutline(course.id);
    const allowedLessons = new Map(authorization.lessons.map((lesson) => [lesson.lessonRef, lesson]));
    const sections = new Map(outline.sections.map((section) => [section.sectionRef, section]));
    library.push({
      courseRef: course.courseRef,
      title: course.title,
      url: `/courses/${course.slug}`,
      access: authorization.access,
      lessons: outline.lessons.flatMap((lesson) => {
        const lessonRef = lesson.lessonRef;
        if (!lessonRef) return [];
        const access = allowedLessons.get(lessonRef)?.access;
        const sectionId = relationId(lesson.section);
        const section = outline.sections.find(({ id }) => String(id) === String(sectionId));
        const stableSection = section ? sections.get(section.sectionRef) : undefined;
        return access && stableSection ? [{
          lessonRef,
          title: lesson.title,
          sectionTitle: stableSection.title,
          url: `/courses/${course.slug}/lessons/${lesson.slug}`,
          access,
        }] : [];
      }),
    });
  }
  return library;
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
  const lesson = courseResult.outline.lessons.find((candidate) => candidate.slug === lessonSlug) as unknown as PublicLesson | undefined;
  if (!lesson) return null;
  const section = courseResult.outline.sections.find(({ id }) => String(id) === String(relationId(lesson.section)));
  return section ? { course: courseResult.course, lesson, section } : null;
}
