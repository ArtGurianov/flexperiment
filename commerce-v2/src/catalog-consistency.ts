import type Database from "better-sqlite3";

export type CatalogConsistencyIssue = {
  readonly code:
    | "ACTIVE_COURSE_OFFER_WITHOUT_CMS_COURSE"
    | "CMS_COURSE_WITHOUT_PRODUCT"
    | "PLAYABLE_LESSON_WITHOUT_VIDEO_BINDING"
    | "VIDEO_BINDING_WITHOUT_LESSON";
  readonly ref: string;
};

type RefRow = { ref: string };

/**
 * Cross-checks the committed CMS projection against the commerce catalogue
 * and private Kinescope bindings. It is deliberately read-only so CI and
 * operators can inspect a snapshot without changing catalogue state.
 */
export function catalogConsistencyIssues(db: Database.Database): CatalogConsistencyIssue[] {
  const issues: CatalogConsistencyIssue[] = [];
  const collect = (code: CatalogConsistencyIssue["code"], sql: string) => {
    for (const { ref } of db.prepare(sql).all() as RefRow[]) issues.push({ code, ref });
  };

  collect("ACTIVE_COURSE_OFFER_WITHOUT_CMS_COURSE", `
    SELECT product.course_ref AS ref
    FROM offers offer
    JOIN products product ON product.id=offer.product_id
    LEFT JOIN catalog_course_projection course ON course.course_ref=product.course_ref
    WHERE product.kind='ONLINE_COURSE'
      AND product.withdrawn_at IS NULL
      AND offer.sale_mode<>'CLOSED'
      AND course.course_ref IS NULL
    ORDER BY product.course_ref
  `);
  collect("CMS_COURSE_WITHOUT_PRODUCT", `
    SELECT course.course_ref AS ref
    FROM catalog_course_projection course
    LEFT JOIN products product ON product.course_ref=course.course_ref AND product.kind='ONLINE_COURSE'
    WHERE product.id IS NULL
    ORDER BY course.course_ref
  `);
  collect("PLAYABLE_LESSON_WITHOUT_VIDEO_BINDING", `
    SELECT lesson.lesson_ref AS ref
    FROM catalog_lesson_projection lesson
    LEFT JOIN lesson_video_bindings binding ON binding.lesson_ref=lesson.lesson_ref
    WHERE lesson.ever_published=1
      AND lesson.withdrawn_at IS NULL
      AND binding.lesson_ref IS NULL
    ORDER BY lesson.lesson_ref
  `);
  collect("VIDEO_BINDING_WITHOUT_LESSON", `
    SELECT binding.lesson_ref AS ref
    FROM lesson_video_bindings binding
    LEFT JOIN catalog_lesson_projection lesson ON lesson.lesson_ref=binding.lesson_ref
    WHERE lesson.lesson_ref IS NULL
    ORDER BY binding.lesson_ref
  `);

  return issues;
}
