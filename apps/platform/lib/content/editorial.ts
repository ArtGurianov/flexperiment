import type { CollectionSlug, Payload, PayloadRequest } from "payload";

export type EditorialDocument = Record<string, unknown> & { id: number | string };

const sectionOrderField = "_sections_sections_order";
const lessonOrderField = "_lessons_lessons_order";

const asEditorial = (document: { id: number | string }) => document as unknown as EditorialDocument;

const numericPosition = (document: { id: number | string }) => Number.isInteger(asEditorial(document).position)
  ? Number(asEditorial(document).position)
  : Number.MAX_SAFE_INTEGER;

const compareOrder = (field: string) => <T extends { id: number | string }>(left: T, right: T) => {
  const leftKey = asEditorial(left)[field];
  const rightKey = asEditorial(right)[field];
  if (typeof leftKey === "string" && typeof rightKey === "string") return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  if (typeof leftKey === "string") return -1;
  if (typeof rightKey === "string") return 1;
  return numericPosition(left) - numericPosition(right);
};

export function orderCourseTree<
  SectionDocument extends { id: number | string },
  LessonDocument extends { id: number | string; section: unknown },
>(sections: SectionDocument[], lessons: LessonDocument[]) {
  const orderedSections = [...sections].sort(compareOrder(sectionOrderField));
  const sectionRank = new Map(orderedSections.map((section, index) => [String(section.id), index]));
  const orderedLessons = [...lessons].sort((left, right) => {
    const sectionDifference = (sectionRank.get(String(relationId(left.section))) ?? Number.MAX_SAFE_INTEGER)
      - (sectionRank.get(String(relationId(right.section))) ?? Number.MAX_SAFE_INTEGER);
    return sectionDifference || compareOrder(lessonOrderField)(left, right);
  });
  const lessonPositions = new Map<string, number>();
  return {
    sections: orderedSections.map((document, position) => {
      const section = { ...document } as SectionDocument & Record<string, unknown>;
      delete section[sectionOrderField];
      return { ...section, position } as SectionDocument & { position: number };
    }),
    lessons: orderedLessons.map((document) => {
      const sectionId = String(relationId(document.section));
      const position = lessonPositions.get(sectionId) ?? 0;
      lessonPositions.set(sectionId, position + 1);
      const lesson = { ...document } as LessonDocument & Record<string, unknown>;
      delete lesson[lessonOrderField];
      return { ...lesson, position } as LessonDocument & { position: number };
    }),
  };
}

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
      sort: sectionOrderField,
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }] },
      select: { sectionRef: true, visibility: true, position: true, course: true, everPublished: true, _sections_sections_order: true },
    }),
    payload.find({
      collection: "lessons",
      depth: 0,
      draft: false,
      limit: 5000,
      overrideAccess: true,
      pagination: false,
      req,
      sort: lessonOrderField,
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }] },
      select: {
        lessonRef: true,
        section: true,
        title: true,
        slug: true,
        everPublished: true,
        visibility: true,
        freePreview: true,
        position: true,
        course: true,
        _lessons_lessons_order: true,
      },
    }),
  ]);
  return orderCourseTree(sections.docs, lessons.docs);
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

export type CourseManifestState = {
  readonly id: number | string;
  readonly courseRef: string;
  readonly manifestVersion: number;
  readonly publicContentUpdatedAt: string;
  readonly invalidatedVersion?: number | null;
};

/** Manifest bookkeeping for a course, kept apart from the versioned course document and its drafts. */
export async function getCourseManifestState(payload: Payload, courseRef: string, req?: PayloadRequest) {
  const result = await payload.find({
    collection: "course-manifest-states",
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { courseRef: { equals: courseRef } },
  });
  return (result.docs[0] as unknown as CourseManifestState | undefined) ?? null;
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
    select: { courseRef: true, visibility: true },
  });
  return result.docs as EditorialDocument[];
}

export async function getCampaignCourseSnapshot(payload: Payload, courseRef: string, req?: PayloadRequest) {
  const courseResult = await payload.find({
    collection: "courses",
    depth: 0,
    draft: false,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: { and: [
      { courseRef: { equals: courseRef } },
      { _status: { equals: "published" } },
      { everPublished: { equals: true } },
    ] },
    select: { courseRef: true, title: true, slug: true, visibility: true, everPublished: true },
  });
  const course = courseResult.docs[0];
  if (!course) return null;
  const [{ lessons }, state] = await Promise.all([
    listPublishedCourseState(payload, course.id, req),
    getCourseManifestState(payload, courseRef, req),
  ]);
  return {
    course: {
      courseRef: String(course.courseRef ?? ""),
      title: String(course.title ?? ""),
      slug: String(course.slug ?? ""),
      contentVersion: String(state?.publicContentUpdatedAt ?? state?.manifestVersion ?? ""),
    },
    lessons: lessons.map((lesson) => ({
      lessonRef: String(lesson.lessonRef ?? ""),
      title: String(lesson.title ?? ""),
      slug: String(lesson.slug ?? ""),
    })).filter(({ lessonRef, title, slug }) => lessonRef && title && slug),
  };
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

/** Attaches each course's public content date; only that field and the ref leave the state collection. */
async function withPublicContentDates(payload: Payload, courses: PublicCourse[]): Promise<PublicCourse[]> {
  if (courses.length === 0) return courses;
  const states = await payload.find({
    collection: "course-manifest-states",
    context: { storefront: true },
    depth: 0,
    limit: 1000,
    overrideAccess: false,
    pagination: false,
    where: { courseRef: { in: courses.map(({ courseRef }) => courseRef) } },
    select: { courseRef: true, publicContentUpdatedAt: true },
  });
  const dates = new Map(states.docs.map((state) => [String(state.courseRef), state.publicContentUpdatedAt ?? null]));
  return courses.map((course) => ({ ...course, publicContentUpdatedAt: dates.get(course.courseRef) ?? null }));
}

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
      displayDate: true, visibility: true,
    },
  });
  return withPublicContentDates(payload, result.docs as unknown as PublicCourse[]);
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
      displayDate: true, visibility: true, seo: true,
    },
  });
  const course = result.docs[0] as unknown as PublicCourse | undefined;
  return course ? (await withPublicContentDates(payload, [course]))[0]! : null;
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
      sort: sectionOrderField,
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { visibility: { equals: "listed" } }] },
      select: { sectionRef: true, title: true, position: true, course: true, visibility: true, _sections_sections_order: true },
    }),
    payload.find({
      collection: "lessons",
      context: { storefront: true },
      depth: 0,
      draft: false,
      limit: 5000,
      overrideAccess: false,
      pagination: false,
      sort: lessonOrderField,
      where: { and: [{ course: { equals: courseId } }, { _status: { equals: "published" } }, { visibility: { equals: "listed" } }] },
      select: { lessonRef: true, section: true, title: true, slug: true, description: true, position: true, durationSeconds: true, freePreview: true, visibility: true, seo: true, _lessons_lessons_order: true },
    }),
  ]);
  const ordered = orderCourseTree(sections.docs, lessons.docs);
  const listedSectionIds = new Set(ordered.sections.map(({ id }) => String(id)));
  return {
    sections: ordered.sections,
    lessons: ordered.lessons.filter((lesson) => listedSectionIds.has(String(relationId(lesson.section)))),
  };
}

export async function getPublicLessonBySlugs(payload: Payload, courseSlug: string, lessonSlug: string) {
  const course = await getPublicCourseBySlug(payload, courseSlug);
  if (!course) return null;
  const outline = await listPublicCourseOutline(payload, course.id);
  const lesson = outline.lessons.find((candidate) => candidate.slug === lessonSlug) as unknown as PublicLesson | undefined;
  if (!lesson) return null;
  const section = outline.sections.find(({ id }) => String(id) === String(relationId(lesson.section)));
  return section ? { course, lesson, section, outline } : null;
}
