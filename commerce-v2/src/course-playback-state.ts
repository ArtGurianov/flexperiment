import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { resolvePlaybackAccess } from "./playback-access";

type Phase = "PLAYING" | "ENDED";
type History = { lessonRef: string; phase: Phase };
type Candidate = { lessonRef: string };

export function customerPlaybackHistory(db: Database.Database, customerId: string) {
  const rows = db.prepare(`SELECT course_ref AS courseRef,played_lesson_ref AS lessonRef,phase
    FROM course_playback_state WHERE customer_id=? AND phase IS NOT NULL`).all(customerId) as Array<History & { courseRef: string }>;
  return new Map(rows.map(row => [row.courseRef, row]));
}

export function continuation<T extends Candidate>(lessons: readonly T[], history?: History) {
  const first = lessons[0];
  if (!first) return null;
  if (!history) return { lesson: first, reason: "FIRST" as const };
  const index = lessons.findIndex(lesson => lesson.lessonRef === history.lessonRef);
  if (index < 0) return { lesson: first, reason: "PREVIOUS_UNAVAILABLE" as const };
  if (history.phase === "PLAYING") return { lesson: lessons[index]!, reason: "CURRENT" as const };
  const next = lessons[index + 1];
  return next ? { lesson: next, reason: "NEXT" as const } : { lesson: lessons[index]!, reason: "REWATCH" as const };
}

export function issueLearningCursor(db: Database.Database, customerId: string, courseRef: string, lessonRef: string) {
  const cursor = randomUUID();
  db.prepare(`INSERT INTO course_playback_state(customer_id,course_ref,issued_lesson_ref,issued_cursor)
    VALUES (?,?,?,?) ON CONFLICT(customer_id,course_ref) DO UPDATE SET
      issued_lesson_ref=excluded.issued_lesson_ref,issued_cursor=excluded.issued_cursor`).run(customerId, courseRef, lessonRef, cursor);
  return cursor;
}

export function recordLearningPlayback(db: Database.Database, input: {
  customerId: string; lessonRef: string; now: Date; leaseMs: number; cursor: string; phase: Phase;
}) {
  return db.transaction(() => {
    const access = resolvePlaybackAccess(db, input);
    if (!access.fullCourseAccess || access.decision !== "ALLOW" || !access.binding || !access.courseRef) return false;
    return db.prepare(`UPDATE course_playback_state
      SET played_lesson_ref=issued_lesson_ref,played_cursor=issued_cursor,phase=@phase
      WHERE customer_id=@customerId AND course_ref=@courseRef AND issued_lesson_ref=@lessonRef AND issued_cursor=@cursor
        AND (@phase='PLAYING' OR (played_cursor=issued_cursor AND phase='PLAYING'))`)
      .run({ ...input, courseRef: access.courseRef }).changes === 1;
  }).immediate();
}
