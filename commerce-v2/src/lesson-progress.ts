import type Database from "better-sqlite3";
import { storefrontOutline } from "./storefront-outline";
import { listCustomerLibrary } from "./library";

export function customerLearningStarts(db: Database.Database, customerId: string) {
  return new Set(db.prepare(`SELECT course_ref FROM course_learning_starts WHERE customer_id=?
    UNION SELECT course_ref FROM course_access_starts WHERE customer_id=?
    UNION SELECT course_ref FROM course_playback_state WHERE customer_id=? AND phase IS NOT NULL`).pluck().all(customerId, customerId, customerId) as string[]);
}

export function customerLessonCompletions(db: Database.Database, customerId: string) {
  const rows = db.prepare("SELECT lesson_ref,first_completed_at FROM lesson_completions WHERE customer_id=?")
    .all(customerId) as Array<{ lesson_ref: string; first_completed_at: string }>;
  return new Map(rows.map(row => [row.lesson_ref, row.first_completed_at]));
}

export function completionPercent(lessons: ReadonlyArray<{ lessonRef: string }>, completions: ReadonlyMap<string, string>) {
  if (lessons.length === 0) return 0;
  const completed = lessons.filter(lesson => completions.has(lesson.lessonRef)).length;
  return Math.floor(completed * 100 / lessons.length);
}

/** The snapshot includes access, the independent start fact and the current syllabus.
 * A write keeps that snapshot under one write lock so revocation and completion are ordered. */
export function lessonProgress(db: Database.Database, input: {
  customerId: string;
  lessonRef: string;
  now: Date;
  leaseMs: number;
  complete: boolean;
}) {
  const readOrComplete = db.transaction(() => {
    const courses = listCustomerLibrary(db, input.customerId, input.now, input.leaseMs).courses;
    const course = courses.find(item => item.access !== "PREVIEW" && item.lessons.some(lesson => lesson.lessonRef === input.lessonRef));
    if (!course || !customerLearningStarts(db, input.customerId).has(course.courseRef)) return null;
    const { lessons } = storefrontOutline(db, course.courseRef, new Set(course.lessons.map(lesson => lesson.lessonRef)));
    if (!lessons.some(lesson => lesson.lessonRef === input.lessonRef)) return null;
    if (input.complete) {
      db.prepare(`INSERT INTO lesson_completions (customer_id,lesson_ref,first_completed_at) VALUES (?,?,?)
        ON CONFLICT(customer_id,lesson_ref) DO NOTHING`).run(input.customerId, input.lessonRef, input.now.toISOString());
    }
    const completions = customerLessonCompletions(db, input.customerId);
    return { firstCompletedAt: completions.get(input.lessonRef) ?? null, progressPercent: completionPercent(lessons, completions) };
  });
  return input.complete ? readOrComplete.immediate() : readOrComplete.deferred();
}
