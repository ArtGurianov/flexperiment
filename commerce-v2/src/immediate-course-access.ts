import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export type ImmediateCourseAccess = {
  schema: "flexperiment.immediate-course-access/1";
  courseRef: string;
  courseVersion: number;
  contentHash: string;
  materials: { lessonRef: string; videoId: string; durationSeconds: number }[];
  materialsSha256: string;
};

/** Initial personal access to ready recorded materials, not a promise of future teaching.
 * Local provider-confirmed READY bindings are admission evidence, not an uptime guarantee. */
export function readyImmediateCourseAccess(db: Database.Database, courseRef: string): ImmediateCourseAccess {
  const course = db.prepare("SELECT version,content_hash FROM catalog_course_projection WHERE course_ref=?").get(courseRef) as
    { version: number; content_hash: string } | undefined;
  const rows = db.prepare(`SELECT l.lesson_ref,l.ever_published,b.active_video_id,b.duration_seconds,u.status
    FROM catalog_lesson_projection l LEFT JOIN lesson_video_bindings b ON b.lesson_ref=l.lesson_ref
    LEFT JOIN video_upload_sessions u ON u.video_id=b.active_video_id AND u.lesson_ref=l.lesson_ref
    WHERE l.course_ref=? AND l.withdrawn_at IS NULL ORDER BY l.lesson_ref`).all(courseRef) as {
      lesson_ref: string; ever_published: number; active_video_id: string | null; duration_seconds: number | null; status: string | null;
    }[];
  if (!course || rows.length === 0 || rows.some(r => r.ever_published !== 1 || r.status !== "READY"
    || !r.active_video_id || r.duration_seconds === null || r.duration_seconds <= 0)) {
    throw new Error("IMMEDIATE_COURSE_ACCESS_NOT_READY");
  }
  const materials = rows.map(r => ({ lessonRef: r.lesson_ref, videoId: r.active_video_id!, durationSeconds: r.duration_seconds! }));
  return { schema: "flexperiment.immediate-course-access/1", courseRef, courseVersion: course.version,
    contentHash: course.content_hash, materials, materialsSha256: createHash("sha256").update(JSON.stringify(materials)).digest("hex") };
}
