import type Database from "better-sqlite3";
import { hasRequiredAccountConsents } from "./authenticated-consents";

/**
 * FLEX-128 · explicit FREE enrollment and minimal start of learning.
 *
 * One IMMEDIATE transaction records the customer's FREE course right in the existing
 * `free_course_enrollments` and the minimal start fact in `course_learning_starts` (local migration 0036,
 * coordinator reserve 0037).
 * It is idempotent per customer–course: a repeat returns the original timestamps. It never creates an
 * order, payment, entitlement or `course_access_starts` row, and it infers no viewing or completion.
 * A playback grant never enrolls; the enrollment is the only writer of these two facts.
 */
export class FreeEnrollmentRefusal extends Error {
  constructor(readonly code: FreeEnrollmentRefusalCode) { super(code); this.name = "FreeEnrollmentRefusal"; }
}
export type FreeEnrollmentRefusalCode =
  | "COURSE_SLUG_INVALID" | "LESSON_SLUG_INVALID" | "COURSE_NOT_FOUND" | "LESSON_NOT_FOUND"
  | "VERIFIED_ACCOUNT_REQUIRED" | "CONSENT_REQUIRED" | "FREE_COURSE_REQUIRED" | "COURSE_NOT_READY";

export type FreeEnrollment = {
  readonly courseRef: string;
  readonly courseSlug: string;
  readonly enrolledAt: string;
  /** The explicit start fact. Null for an enrollment recorded before FLEX-128 by an implicit grant:
   * no start row is backfilled or inferred for it, and its access is unchanged. */
  readonly startedAt: string | null;
  /** Stage A shows 0% at the start; FLEX-129 owns completion facts and progress computation. */
  readonly progressPercent: 0;
};
export type FreeEnrollmentResult = FreeEnrollment & {
  readonly created: boolean;
  /** The chosen lesson when given and open to the account, else the first lesson of the course. */
  readonly lessonPath: string;
};
export type FreeEnrollmentStatus = {
  readonly courseRef: string;
  readonly courseSlug: string;
  readonly accessModel: "FREE" | "PAID";
  readonly enrollment: FreeEnrollment | null;
  /** Only a published listed FREE course with lessons can be enrolled now. */
  readonly enrollable: boolean;
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

type CourseRow = {
  course_ref: string; slug: string; visibility: "LISTED" | "UNLISTED"; authoring_source: string;
  product_id: string; product_version: number; access_model: "FREE" | "PAID"; product_withdrawn_at: string | null;
};
type LessonRow = { slug: string };

const courseRow = (db: Database.Database, slug: string) => db.prepare(`SELECT course.course_ref,course.slug,course.visibility,
    course.authoring_source,product.id AS product_id,product.version AS product_version,product.access_model,
    product.withdrawn_at AS product_withdrawn_at
  FROM catalog_course_projection course
  JOIN products product ON product.course_ref=course.course_ref AND product.kind='ONLINE_COURSE'
  WHERE course.slug=? AND course.title IS NOT NULL`).get(slug) as CourseRow | undefined;

/** Listed published lessons in syllabus order; the same order as the public course outline. */
const courseLessons = (db: Database.Database, courseRef: string) => db.prepare(`SELECT lesson.slug
  FROM catalog_lesson_projection lesson JOIN catalog_section_projection section ON section.section_ref=lesson.section_ref
  WHERE lesson.course_ref=? AND lesson.ever_published=1 AND lesson.withdrawn_at IS NULL AND lesson.visibility='LISTED'
    AND section.visibility='LISTED' AND section.title IS NOT NULL AND lesson.title IS NOT NULL AND lesson.slug IS NOT NULL
  ORDER BY section.position,section.section_ref,lesson.position,lesson.lesson_ref`).all(courseRef) as LessonRow[];

const verifiedAccount = (db: Database.Database, customerId: string) => Boolean(db.prepare(`SELECT 1 FROM customers c
  JOIN "user" u ON u.id=c.auth_user_id WHERE c.id=? AND u.email_verified=1 AND lower(trim(u.email))=c.email_normalized`)
  .get(customerId));

const readEnrollment = (db: Database.Database, customerId: string, course: CourseRow): FreeEnrollment | null => {
  const row = db.prepare(`SELECT f.enrolled_at,s.started_at FROM free_course_enrollments f
    LEFT JOIN course_learning_starts s ON s.customer_id=f.customer_id AND s.course_ref=?
    WHERE f.customer_id=? AND f.product_id=?`).get(course.course_ref, customerId, course.product_id) as
    { enrolled_at: string; started_at: string | null } | undefined;
  if (!row) return null;
  return { courseRef: course.course_ref, courseSlug: course.slug, enrolledAt: row.enrolled_at,
    startedAt: row.started_at, progressPercent: 0 };
};

const enrollable = (course: CourseRow) => course.access_model === "FREE" && !course.product_withdrawn_at
  && course.visibility === "LISTED" && course.authoring_source === "COMMERCE_EDITORIAL";

export function freeEnrollmentStatus(db: Database.Database, customerId: string, courseSlug: string): FreeEnrollmentStatus | null {
  if (!SLUG.test(courseSlug)) throw new FreeEnrollmentRefusal("COURSE_SLUG_INVALID");
  const read = db.transaction(() => {
    const course = courseRow(db, courseSlug);
    if (!course || course.product_withdrawn_at) return null;
    const enrollment = readEnrollment(db, customerId, course);
    // An unlisted course is visible only to those already enrolled in it.
    if (!enrollment && course.visibility !== "LISTED") return null;
    return { courseRef: course.course_ref, courseSlug: course.slug, accessModel: course.access_model, enrollment,
      enrollable: enrollable(course) && courseLessons(db, course.course_ref).length > 0 };
  });
  return read.deferred();
}

export function enrollInFreeCourse(db: Database.Database, input: {
  readonly customerId: string; readonly courseSlug: string; readonly lessonSlug?: string;
}, now = new Date().toISOString()): FreeEnrollmentResult {
  if (!SLUG.test(input.courseSlug)) throw new FreeEnrollmentRefusal("COURSE_SLUG_INVALID");
  if (input.lessonSlug !== undefined && !SLUG.test(input.lessonSlug)) throw new FreeEnrollmentRefusal("LESSON_SLUG_INVALID");
  // IMMEDIATE: serializes with FREE→PAID, withdrawal, consent and erasure writers on every connection.
  const command = db.transaction((): FreeEnrollmentResult => {
    if (!verifiedAccount(db, input.customerId)) throw new FreeEnrollmentRefusal("VERIFIED_ACCOUNT_REQUIRED");
    if (!hasRequiredAccountConsents(db, input.customerId, "COURSES")) throw new FreeEnrollmentRefusal("CONSENT_REQUIRED");
    const course = courseRow(db, input.courseSlug);
    if (!course || course.product_withdrawn_at) throw new FreeEnrollmentRefusal("COURSE_NOT_FOUND");
    const lessons = courseLessons(db, course.course_ref);
    const path = (slug: string) => `/courses/${course.slug}/lessons/${slug}`;
    const chosen = input.lessonSlug === undefined ? lessons[0]
      : lessons.find(lesson => lesson.slug === input.lessonSlug);
    const existing = readEnrollment(db, input.customerId, course);
    if (existing) {
      // A repeat (or a race lost to an earlier click) changes nothing, even after FREE→PAID.
      if (input.lessonSlug !== undefined && !chosen) throw new FreeEnrollmentRefusal("LESSON_NOT_FOUND");
      if (!chosen) throw new FreeEnrollmentRefusal("COURSE_NOT_READY");
      return { ...existing, created: false, lessonPath: path(chosen.slug) };
    }
    if (course.visibility !== "LISTED" || course.authoring_source !== "COMMERCE_EDITORIAL") {
      throw new FreeEnrollmentRefusal("COURSE_NOT_FOUND");
    }
    if (course.access_model !== "FREE") throw new FreeEnrollmentRefusal("FREE_COURSE_REQUIRED");
    if (lessons.length === 0) throw new FreeEnrollmentRefusal("COURSE_NOT_READY");
    if (input.lessonSlug !== undefined && !chosen) throw new FreeEnrollmentRefusal("LESSON_NOT_FOUND");
    // 0024/0037 triggers re-check verified binding, FREE model, product version and the enrollment link.
    db.prepare(`INSERT INTO free_course_enrollments(customer_id,product_id,product_version,enrolled_at)
      VALUES (?,?,?,?)`).run(input.customerId, course.product_id, course.product_version, now);
    db.prepare(`INSERT INTO course_learning_starts(customer_id,course_ref,product_id,source,started_at)
      VALUES (?,?,?,'FREE_ENROLLMENT',?)`).run(input.customerId, course.course_ref, course.product_id, now);
    return { courseRef: course.course_ref, courseSlug: course.slug, enrolledAt: now, startedAt: now, progressPercent: 0,
      created: true, lessonPath: path(chosen!.slug) };
  });
  return command.immediate();
}

/** Enrollment facts for the account library, keyed by course reference. */
export function customerFreeEnrollments(db: Database.Database, customerId: string) {
  const rows = db.prepare(`SELECT p.course_ref,f.enrolled_at,s.started_at FROM free_course_enrollments f
    JOIN products p ON p.id=f.product_id
    LEFT JOIN course_learning_starts s ON s.customer_id=f.customer_id AND s.course_ref=p.course_ref
    WHERE f.customer_id=?`).all(customerId) as Array<{ course_ref: string; enrolled_at: string; started_at: string | null }>;
  return new Map(rows.map(row => [row.course_ref, {
    enrolledAt: row.enrolled_at, startedAt: row.started_at, progressPercent: 0 as const }]));
}
