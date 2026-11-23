import type Database from "better-sqlite3";
import { listCustomerLibrary, type CustomerLibrary } from "./library";

type CourseRow = {
  course_ref: string; version: number; title: string; slug: string; summary: string;
  description_json: string | null; seo_json: string | null; applied_at: string;
  access_model: "FREE" | "PAID"; offer_ref: string | null;
  sale_mode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC" | null; price_kopecks: number | null;
};
type SectionRow = { section_ref: string; title: string; position: number };
type LessonRow = { lesson_ref: string; section_ref: string; title: string; slug: string; position: number;
  free_preview: number; description_json: string | null; seo_json: string | null };

const courseFrom = `FROM catalog_course_projection course
  JOIN products product ON product.course_ref=course.course_ref AND product.kind='ONLINE_COURSE'
  LEFT JOIN offers offer ON offer.product_id=product.id
  WHERE course.authoring_source='COMMERCE_EDITORIAL'
    AND product.withdrawn_at IS NULL AND course.title IS NOT NULL AND course.slug IS NOT NULL`;
const publicVisibility = " AND course.visibility='LISTED'";
const courseColumns = `course.course_ref,course.version,course.title,course.slug,course.summary,
  course.description_json,course.seo_json,course.applied_at,product.access_model,
  offer.offer_ref,offer.sale_mode,offer.price_kopecks`;
const json = (value: string | null) => value === null ? null : JSON.parse(value) as unknown;

function projectCourse(row: CourseRow) {
  return {
    courseRef: row.course_ref, version: row.version,
    title: row.title, slug: row.slug, summary: row.summary, description: json(row.description_json),
    seo: json(row.seo_json), publicContentUpdatedAt: row.applied_at,
  };
}
function projectCommercial(row: CourseRow) {
  return {
    courseRef: row.course_ref, accessModel: row.access_model, offerRef: row.offer_ref,
    saleMode: row.sale_mode ?? "CLOSED", priceKopecks: row.price_kopecks,
    withdrawn: false,
  };
}
function courseBySlug(db: Database.Database, slug: string, publicOnly: boolean) {
  return db.prepare(`SELECT ${courseColumns} ${courseFrom}${publicOnly ? publicVisibility : ""} AND course.slug=?`)
    .get(slug) as CourseRow | undefined;
}
function courseByRef(db: Database.Database, courseRef: string, publicOnly: boolean) {
  return db.prepare(`SELECT ${courseColumns} ${courseFrom}${publicOnly ? publicVisibility : ""} AND course.course_ref=?`)
    .get(courseRef) as CourseRow | undefined;
}
function outline(db: Database.Database, courseRef: string, allowedLessonRefs?: ReadonlySet<string>) {
  const publicOnly = !allowedLessonRefs;
  const sections = db.prepare(`SELECT section_ref,title,position FROM catalog_section_projection
    WHERE course_ref=? ${publicOnly ? "AND visibility='LISTED'" : ""}
      AND title IS NOT NULL ORDER BY position,section_ref`)
    .all(courseRef) as SectionRow[];
  const sectionOrder = new Map(sections.map((section, index) => [section.section_ref, index]));
  const lessons = (db.prepare(`SELECT lesson_ref,section_ref,title,slug,position,free_preview,description_json,seo_json
    FROM catalog_lesson_projection WHERE course_ref=? ${publicOnly ? "AND visibility='LISTED'" : ""}
      AND ever_published=1
      AND withdrawn_at IS NULL AND title IS NOT NULL AND slug IS NOT NULL
    ORDER BY position,lesson_ref`).all(courseRef) as LessonRow[])
    .filter(lesson => sectionOrder.has(lesson.section_ref)
      && (!allowedLessonRefs || allowedLessonRefs.has(lesson.lesson_ref)))
    .sort((left, right) => (sectionOrder.get(left.section_ref)! - sectionOrder.get(right.section_ref)!)
      || left.position - right.position || left.lesson_ref.localeCompare(right.lesson_ref));
  const visibleSectionRefs = allowedLessonRefs && new Set(lessons.map(lesson => lesson.section_ref));
  return {
    sections: sections.filter(section => !visibleSectionRefs || visibleSectionRefs.has(section.section_ref))
      .map(section => ({ sectionRef: section.section_ref, title: section.title, position: section.position })),
    lessons: lessons.map(lesson => ({ lessonRef: lesson.lesson_ref, sectionRef: lesson.section_ref,
      title: lesson.title, slug: lesson.slug, position: lesson.position, freePreview: Boolean(lesson.free_preview) })),
    lessonRows: lessons,
  };
}

/** All responses are explicit allowlists, never raw SQLite rows or draft JSON. */
export function listStorefrontCourses(db: Database.Database) {
  const read = db.transaction(() => (db.prepare(`SELECT ${courseColumns} ${courseFrom}${publicVisibility} ORDER BY course.applied_at DESC,course.course_ref`)
    .all() as CourseRow[]).map(row => ({ course: projectCourse(row), commercial: projectCommercial(row) })));
  return read.deferred();
}

export function getStorefrontCourse(db: Database.Database, slug: string) {
  const read = db.transaction(() => {
    const row = courseBySlug(db, slug, true);
    if (!row) return null;
    const graph = outline(db, row.course_ref);
    return { course: projectCourse(row), commercial: projectCommercial(row),
      outline: { sections: graph.sections, lessons: graph.lessons } };
  });
  return read.deferred();
}

export function getStorefrontLesson(db: Database.Database, courseSlug: string, lessonSlug: string,
  allowedLessonRefs?: ReadonlySet<string>) {
  const read = db.transaction(() => {
    const row = courseBySlug(db, courseSlug, !allowedLessonRefs);
    if (!row) return null;
    const graph = outline(db, row.course_ref, allowedLessonRefs);
    const lesson = graph.lessonRows.find(item => item.slug === lessonSlug);
    if (!lesson) return null;
    const section = graph.sections.find(item => item.sectionRef === lesson.section_ref);
    if (!section) return null;
    const reveal = allowedLessonRefs?.has(lesson.lesson_ref) ?? false;
    return { course: projectCourse(row), commercial: projectCommercial(row), section,
      lesson: { lessonRef: lesson.lesson_ref, sectionRef: lesson.section_ref, title: lesson.title,
        slug: lesson.slug, position: lesson.position, freePreview: Boolean(lesson.free_preview),
        description: reveal ? json(lesson.description_json) : null, seo: reveal ? json(lesson.seo_json) : null },
      outline: { sections: graph.sections, lessons: graph.lessons } };
  });
  return read.deferred();
}

export function getCustomerStorefrontLesson(db: Database.Database, customerId: string,
  courseSlug: string, lessonSlug: string, now: Date, leaseMs: number) {
  const read = db.transaction(() => {
    const row = courseBySlug(db, courseSlug, false);
    if (!row) return null;
    const permitted = listCustomerLibrary(db, customerId, now, leaseMs).courses.find(course => course.courseRef === row.course_ref);
    if (!permitted) return null;
    const allowed = new Set(permitted.lessons.map(lesson => lesson.lessonRef));
    const result = getStorefrontLesson(db, courseSlug, lessonSlug, allowed);
    return result && allowed.has(result.lesson.lessonRef) ? result : null;
  });
  return read.deferred();
}

export function getCustomerStorefrontCourse(db: Database.Database, customerId: string,
  courseSlug: string, now: Date, leaseMs: number) {
  const read = db.transaction(() => {
    const row = courseBySlug(db, courseSlug, false);
    if (!row) return null;
    const permitted = listCustomerLibrary(db, customerId, now, leaseMs).courses.find(course => course.courseRef === row.course_ref);
    if (!permitted) return null;
    const graph = outline(db, row.course_ref, new Set(permitted.lessons.map(lesson => lesson.lessonRef)));
    return { course: projectCourse(row), commercial: projectCommercial(row),
      outline: { sections: graph.sections, lessons: graph.lessons } };
  });
  return read.deferred();
}

export function listCustomerStorefrontLibrary(db: Database.Database, customerId: string, now: Date, leaseMs: number) {
  const read = db.transaction(() => {
    const authorized: CustomerLibrary = listCustomerLibrary(db, customerId, now, leaseMs);
    return { courses: authorized.courses.flatMap(item => {
      const row = courseByRef(db, item.courseRef, false);
      if (!row) return [];
      const graph = outline(db, item.courseRef, new Set(item.lessons.map(lesson => lesson.lessonRef)));
      const lessons = new Map(graph.lessons.map(lesson => [lesson.lessonRef, lesson]));
      const sections = new Map(graph.sections.map(section => [section.sectionRef, section]));
      return [{ courseRef: item.courseRef, title: row.title, url: `/courses/${row.slug}`, access: item.access,
        enrollment: item.enrollment,
        lessons: item.lessons.flatMap(allowed => {
          const lesson = lessons.get(allowed.lessonRef);
          const section = lesson && sections.get(lesson.sectionRef);
          return lesson && section ? [{ lessonRef: lesson.lessonRef, title: lesson.title,
            sectionTitle: section.title, url: `/courses/${row.slug}/lessons/${lesson.slug}`, access: allowed.access }] : [];
        }) }];
    }) };
  });
  return read.deferred();
}

/** MY cabinet projection of the same course access policy the LMS uses. */
export function listMyStorefrontLibrary(db: Database.Database, customerId: string, now: Date, leaseMs: number) {
  return db.transaction(() => {
    const { courses } = listCustomerStorefrontLibrary(db, customerId, now, leaseMs);
    const grants = db.prepare(`SELECT entitlement.scope,entitlement.course_ref,
        COALESCE(json_extract(orders.checkout_snapshot_json,'$.schema'),'')='flexperiment.manual-entitlement/1' AS manual
      FROM course_entitlements entitlement JOIN order_lines line ON line.id=entitlement.source_order_line_id
      JOIN orders ON orders.id=line.order_id WHERE entitlement.customer_id=? AND entitlement.revoked_at IS NULL`)
      .all(customerId) as Array<{ scope: "COURSE" | "ALL_COURSES"; course_ref: string | null; manual: number }>;
    const viewHistory = db.prepare(`SELECT lesson_ref FROM lesson_resume_positions WHERE customer_id=? AND seconds>0
       ORDER BY julianday(updated_at) DESC,lesson_ref`).pluck().all(customerId) as string[];
    const rank = new Map(viewHistory.map((ref, index) => [ref, index]));

    return { courses: courses.filter(course => course.access !== "PREVIEW" && course.lessons.length > 0).map(course => {
      const direct = grants.some(grant => !grant.manual && grant.scope === "COURSE" && grant.course_ref === course.courseRef);
      const bundle = grants.some(grant => !grant.manual && grant.scope === "ALL_COURSES");
      const access = direct ? "PURCHASE" : bundle ? "BUNDLE" : course.enrollment ? "FREE_ENROLMENT" : "GRANTED";
      const watched = course.lessons.filter(lesson => rank.has(lesson.lessonRef))
        .sort((a,b) => rank.get(a.lessonRef)! - rank.get(b.lessonRef)!)[0];
      return { slug: course.url.split("/").at(-1)!, title: course.title, access,
        started: Boolean(watched || course.enrollment?.startedAt),
        resumeLesson: watched ? { slug: watched.url.split("/").at(-1)!, title: watched.title } : null };
    }) };
  }).deferred();
}
