import type Database from "better-sqlite3";
import { storefrontOutline as outline } from "./storefront-outline";
import { continuation, customerPlaybackHistory } from "./course-playback-state";
import { completionPercent, customerLearningStarts, customerLessonCompletions } from "./lesson-progress";
import { listCustomerLibrary, type CustomerLibrary } from "./library";

type CourseRow = {
  course_ref: string; version: number; title: string; slug: string; summary: string;
  description_json: string | null; seo_json: string | null; applied_at: string;
  access_model: "FREE" | "PAID"; offer_ref: string | null;
  sale_mode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC" | null; price_kopecks: number | null;
};
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
    const startedCourses = customerLearningStarts(db, customerId);
    const completions = customerLessonCompletions(db, customerId);
    const playback = customerPlaybackHistory(db, customerId);
    return { courses: authorized.courses.flatMap(item => {
      const row = courseByRef(db, item.courseRef, false);
      if (!row) return [];
      const graph = outline(db, item.courseRef, new Set(item.lessons.map(lesson => lesson.lessonRef)));
      const sections = new Map(graph.sections.map(section => [section.sectionRef, section.title]));
      const access = new Map(item.lessons.map(lesson => [lesson.lessonRef, lesson.access]));
      const lessons = graph.lessons.map(lesson => ({
        lessonRef: lesson.lessonRef, title: lesson.title, sectionTitle: sections.get(lesson.sectionRef)!,
        slug: lesson.slug, url: `/courses/${row.slug}/lessons/${lesson.slug}`, access: access.get(lesson.lessonRef)!,
      }));
      const started = item.access !== "PREVIEW" && startedCourses.has(item.courseRef);
      return [{ courseRef: item.courseRef, title: row.title, url: `/courses/${row.slug}`, access: item.access,
        enrollment: item.enrollment, started, progressPercent: started ? completionPercent(lessons, completions) : null,
        continuation: item.access !== "PREVIEW" ? continuation(lessons, playback.get(item.courseRef)) : null,
        lessons }];
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
    return { courses: courses.filter(course => course.access !== "PREVIEW" && course.lessons.length > 0).map(course => {
      const direct = grants.some(grant => !grant.manual && grant.scope === "COURSE" && grant.course_ref === course.courseRef);
      const bundle = grants.some(grant => !grant.manual && grant.scope === "ALL_COURSES");
      const access = direct ? "PURCHASE" : bundle ? "BUNDLE" : course.enrollment ? "FREE_ENROLMENT" : "GRANTED";
      const target = course.continuation?.lesson;
      return { slug: course.url.split("/").at(-1)!, title: course.title, access,
        started: course.started, progressPercent: course.progressPercent, continuationReason: course.continuation?.reason,
        resumeLesson: target ? { slug: target.slug, title: target.title } : null };
    }) };
  }).deferred();
}
