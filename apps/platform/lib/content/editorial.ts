import type { CollectionSlug, Payload, PayloadRequest } from "payload";

export type EditorialDocument = Record<string, unknown> & { id: number | string };

const relationId = (value: unknown): number | string => {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  throw new Error("INVALID_RELATION");
};

export { relationId };

export async function getDocumentForLifecycle(req: PayloadRequest, collection: CollectionSlug, id: number | string) {
  return req.payload.findByID({ collection, id, depth: 0, overrideAccess: true, req });
}

export async function getPublishedDocument(
  req: PayloadRequest,
  collection: "courses" | "sections" | "lessons",
  id: number | string,
): Promise<EditorialDocument | null> {
  try {
    return await req.payload.findByID({
      collection,
      id,
      depth: 0,
      draft: false,
      overrideAccess: true,
      req,
    }) as unknown as EditorialDocument;
  } catch {
    return null;
  }
}

export async function getCourseForDocument(req: PayloadRequest, document: EditorialDocument): Promise<EditorialDocument> {
  if ("courseRef" in document) return document;
  const course = await getPublishedDocument(req, "courses", relationId(document.course));
  if (!course) throw new Error("PUBLISHED_COURSE_NOT_FOUND");
  return course;
}

export async function listPublishedCourseState(payload: Payload, courseId: number | string, req?: PayloadRequest) {
  const [sections, lessons] = await Promise.all([
    payload.find({
      collection: "sections",
      depth: 0,
      draft: false,
      limit: 1000,
      overrideAccess: true,
      pagination: false,
      req,
      sort: "position",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }] },
      select: { sectionRef: true, visibility: true, position: true, course: true, everPublished: true },
    }),
    payload.find({
      collection: "lessons",
      depth: 0,
      draft: false,
      limit: 5000,
      overrideAccess: true,
      pagination: false,
      req,
      sort: "position",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }] },
      select: {
        lessonRef: true,
        section: true,
        everPublished: true,
        visibility: true,
        freePreview: true,
        position: true,
        course: true,
      },
    }),
  ]);
  return {
    sections: sections.docs as EditorialDocument[],
    lessons: lessons.docs as EditorialDocument[],
  };
}

export async function listUnacknowledgedOperations(payload: Payload, courseRef: string, req?: PayloadRequest) {
  const result = await payload.find({
    collection: "access-operations",
    depth: 0,
    limit: 1000,
    overrideAccess: true,
    pagination: false,
    req,
    sort: "committedVersion",
    where: { and: [{ courseRef: { equals: courseRef } }, { state: { equals: "COMMITTED_UNACKED" } }] },
    select: { operationId: true, committedVersion: true, courseRef: true, state: true },
  });
  return result.docs as EditorialDocument[];
}

export async function listPublishedCourses(payload: Payload, req?: PayloadRequest) {
  const result = await payload.find({
    collection: "courses",
    depth: 0,
    draft: false,
    limit: 1000,
    overrideAccess: true,
    pagination: false,
    req,
    where: { _status: { equals: "published" } },
    select: { courseRef: true, manifestVersion: true, visibility: true },
  });
  return result.docs as EditorialDocument[];
}

export async function hasCommittedAccessOperation(payload: Payload, operationId: string, req?: PayloadRequest) {
  const result = await payload.find({
    collection: "access-operations",
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { operationId: { equals: operationId } },
    select: { operationId: true },
  });
  return result.totalDocs > 0;
}

export type PublicCourse = {
  id: number | string;
  courseRef: string;
  title: string;
  slug: string;
  summary: string;
  displayDate?: string | null;
  publicContentUpdatedAt?: string | null;
  hero?: unknown;
  description?: unknown;
  seo?: { title?: string | null; description?: string | null; image?: unknown } | null;
};

export type PublicLesson = {
  id: number | string;
  lessonRef: string;
  title: string;
  slug: string;
  description?: unknown;
  position: number;
  durationSeconds?: number | null;
  freePreview: boolean;
  section: unknown;
  seo?: { title?: string | null; description?: string | null } | null;
};

export async function listPublicCourses(payload: Payload): Promise<PublicCourse[]> {
  const result = await payload.find({
    collection: "courses",
    context: { storefront: true },
    depth: 1,
    draft: false,
    limit: 1000,
    overrideAccess: false,
    pagination: false,
    sort: "-displayDate",
    where: { and: [{ _status: { equals: "published" } }, { visibility: { equals: "listed" } }] },
    select: {
      courseRef: true, title: true, slug: true, summary: true, hero: true,
      displayDate: true, publicContentUpdatedAt: true, visibility: true,
    },
  });
  return result.docs as unknown as PublicCourse[];
}

export async function getPublicCourseBySlug(payload: Payload, slug: string): Promise<PublicCourse | null> {
  const result = await payload.find({
    collection: "courses",
    context: { storefront: true },
    depth: 1,
    draft: false,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    where: {
      and: [
        { slug: { equals: slug } }, { _status: { equals: "published" } }, { visibility: { equals: "listed" } },
      ],
    },
    select: {
      courseRef: true, title: true, slug: true, summary: true, description: true, hero: true,
      displayDate: true, publicContentUpdatedAt: true, visibility: true, seo: true,
    },
  });
  return (result.docs[0] as unknown as PublicCourse | undefined) ?? null;
}

export async function listPublicCourseOutline(payload: Payload, courseId: number | string) {
  const [sections, lessons] = await Promise.all([
    payload.find({
      collection: "sections",
      context: { storefront: true },
      depth: 0,
      draft: false,
      limit: 1000,
      overrideAccess: false,
      pagination: false,
      sort: "position",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { visibility: { equals: "listed" } }] },
      select: { sectionRef: true, title: true, position: true, course: true, visibility: true },
    }),
    payload.find({
      collection: "lessons",
      context: { storefront: true },
      depth: 0,
      draft: false,
      limit: 5000,
      overrideAccess: false,
      pagination: false,
      sort: "position",
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { visibility: { equals: "listed" } }] },
      select: { lessonRef: true, section: true, title: true, slug: true, description: true, position: true, durationSeconds: true, freePreview: true, visibility: true, seo: true },
    }),
  ]);
  const listedSectionIds = new Set(sections.docs.map(({ id }) => String(id)));
  return {
    sections: sections.docs,
    lessons: lessons.docs.filter((lesson) => listedSectionIds.has(String(relationId(lesson.section)))),
  };
}

export async function getPublicLessonBySlugs(payload: Payload, courseSlug: string, lessonSlug: string) {
  const course = await getPublicCourseBySlug(payload, courseSlug);
  if (!course) return null;
  const lessonResult = await payload.find({
    collection: "lessons",
    context: { storefront: true },
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    where: {
      and: [
        { course: { equals: course.id } }, { slug: { equals: lessonSlug } },
        { _status: { equals: "published" } }, { visibility: { equals: "listed" } },
      ],
    },
    select: {
      lessonRef: true, section: true, title: true, slug: true, description: true,
      position: true, durationSeconds: true, freePreview: true, visibility: true, seo: true,
    },
  });
  const lesson = lessonResult.docs[0] as unknown as PublicLesson | undefined;
  if (!lesson) return null;
  const sectionResult = await payload.find({
    collection: "sections",
    context: { storefront: true },
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: false,
    pagination: false,
    where: {
      and: [
        { id: { equals: relationId(lesson.section) } }, { course: { equals: course.id } },
        { _status: { equals: "published" } }, { visibility: { equals: "listed" } },
      ],
    },
    select: { sectionRef: true, title: true, position: true, course: true, visibility: true },
  });
  const section = sectionResult.docs[0];
  return section ? { course, lesson, section } : null;
}
