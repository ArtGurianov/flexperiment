import type Database from "better-sqlite3";
import { decideLessonAccess, type AccessDecision } from "./access-policy";
import { playbackResumeAt } from "./resume";

type ProjectionRow = {
  lesson_ref: string;
  course_ref: string;
  ever_published: number;
  lesson_visibility: "LISTED" | "UNLISTED";
  free_preview: number;
  lesson_withdrawn_at: string | null;
  section_visibility: "LISTED" | "UNLISTED";
  course_visibility: "LISTED" | "UNLISTED";
  last_reconciled_at: string;
  access_model: "FREE" | "PAID" | null;
  product_withdrawn_at: string | null;
  sale_mode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
};

type Grant = { scope: "COURSE" | "ALL_COURSES"; course_ref: string | null; revoked_at: string | null };

export type PlaybackAccessResolution = {
  decision: AccessDecision;
  courseRef?: string;
  paidEntitled: boolean;
  binding?: { videoId: string; durationSeconds: number | null };
  resumeAt: number;
};

export function resolvePlaybackAccess(db: Database.Database, input: {
  customerId: string;
  lessonRef: string;
  now: Date;
  leaseMs: number;
}): PlaybackAccessResolution {
  const row = db.prepare(`SELECT
    lesson.lesson_ref, lesson.course_ref, lesson.ever_published, lesson.visibility AS lesson_visibility,
    lesson.free_preview, lesson.withdrawn_at AS lesson_withdrawn_at,
    section.visibility AS section_visibility, course.visibility AS course_visibility,
    course.last_reconciled_at, product.access_model, product.withdrawn_at AS product_withdrawn_at,
    COALESCE(offer.sale_mode, 'CLOSED') AS sale_mode
    FROM catalog_lesson_projection lesson
    JOIN catalog_section_projection section ON section.section_ref = lesson.section_ref
    JOIN catalog_course_projection course ON course.course_ref = lesson.course_ref
    LEFT JOIN products product ON product.course_ref = lesson.course_ref
    LEFT JOIN offers offer ON offer.product_id = product.id
    WHERE lesson.lesson_ref = ?`).get(input.lessonRef) as ProjectionRow | undefined;
  const grants = db.prepare(`SELECT scope, course_ref, revoked_at FROM course_entitlements
    WHERE customer_id = ? AND revoked_at IS NULL`).all(input.customerId) as Grant[];
  const activeOverride = Boolean(row && db.prepare(`SELECT 1 FROM access_overrides WHERE course_ref=? AND state='PENDING' AND
    (scope_level='COURSE' OR (scope_level='SECTION' AND scope_ref=(SELECT section_ref FROM catalog_lesson_projection WHERE lesson_ref=?)) OR (scope_level='LESSON' AND scope_ref=?)) LIMIT 1`)
    .get(row.course_ref, input.lessonRef, input.lessonRef));
  const effectiveVisibility = row && row.course_visibility === "LISTED" && row.section_visibility === "LISTED" && row.lesson_visibility === "LISTED"
    ? "LISTED" : "UNLISTED";
  const decision = decideLessonAccess({
    customerId: input.customerId,
    courseRef: row?.course_ref ?? "",
    lesson: row ? {
      everPublished: Boolean(row.ever_published), effectiveVisibility,
      freePreview: Boolean(row.free_preview), withdrawn: Boolean(row.lesson_withdrawn_at),
    } : undefined,
    courseProduct: row?.access_model ? {
      accessModel: row.access_model, withdrawn: Boolean(row.product_withdrawn_at), saleMode: row.sale_mode,
    } : undefined,
    grants: grants.map((grant) => ({ scope: grant.scope, courseRef: grant.course_ref ?? undefined, revoked: Boolean(grant.revoked_at) })),
    activeDenyNonEntitledOverride: activeOverride,
    projectionStale: row ? input.now.getTime() - Date.parse(row.last_reconciled_at) > input.leaseMs : false,
  });
  const paidEntitled = Boolean(row?.access_model === "PAID" && grants.some((grant) =>
    grant.scope === "ALL_COURSES" || (grant.scope === "COURSE" && grant.course_ref === row.course_ref)));
  if (decision !== "ALLOW") return { decision, courseRef: row?.course_ref, paidEntitled, resumeAt: 0 };
  const binding = db.prepare("SELECT active_video_id,duration_seconds FROM lesson_video_bindings WHERE lesson_ref=?")
    .get(input.lessonRef) as { active_video_id: string; duration_seconds: number | null } | undefined;
  if (!binding) return { decision, courseRef: row?.course_ref, paidEntitled, resumeAt: 0 };
  const resume = db.prepare("SELECT seconds FROM lesson_resume_positions WHERE customer_id=? AND lesson_ref=?")
    .get(input.customerId, input.lessonRef) as { seconds: number } | undefined;
  return {
    decision,
    courseRef: row?.course_ref,
    paidEntitled,
    binding: { videoId: binding.active_video_id, durationSeconds: binding.duration_seconds },
    resumeAt: playbackResumeAt(resume?.seconds ?? 0, binding.duration_seconds),
  };
}
