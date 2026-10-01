import type Database from "better-sqlite3";
import { decideLessonAccess } from "./access-policy";

type LibraryRow = {
  course_ref: string;
  lesson_ref: string;
  section_ref: string;
  course_visibility: "LISTED" | "UNLISTED";
  section_visibility: "LISTED" | "UNLISTED";
  lesson_visibility: "LISTED" | "UNLISTED";
  ever_published: number;
  free_preview: number;
  lesson_withdrawn_at: string | null;
  last_reconciled_at: string;
  access_model: "FREE" | "PAID" | null;
  product_withdrawn_at: string | null;
  sale_mode: "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";
};

type ActiveGrant = { scope: "COURSE" | "ALL_COURSES"; course_ref: string | null };

export type CustomerLibrary = {
  courses: Array<{
    courseRef: string;
    access: "ENTITLED" | "FREE" | "PREVIEW";
    lessons: Array<{ lessonRef: string; sectionRef: string; access: "ENTITLED" | "FREE" | "PREVIEW" }>;
  }>;
};

export function listCustomerLibrary(
  db: Database.Database,
  customerId: string,
  now = new Date(),
  leaseMs = 24 * 60 * 60 * 1000,
): CustomerLibrary {
  const rows = db.prepare(`SELECT lesson.course_ref,lesson.lesson_ref,lesson.section_ref,
      course.visibility AS course_visibility,section.visibility AS section_visibility,lesson.visibility AS lesson_visibility,
      lesson.ever_published,lesson.free_preview,lesson.withdrawn_at AS lesson_withdrawn_at,course.last_reconciled_at,
      product.access_model,product.withdrawn_at AS product_withdrawn_at,COALESCE(offer.sale_mode,'CLOSED') AS sale_mode
    FROM catalog_lesson_projection lesson
    JOIN catalog_section_projection section ON section.section_ref=lesson.section_ref
    JOIN catalog_course_projection course ON course.course_ref=lesson.course_ref
    LEFT JOIN products product ON product.course_ref=lesson.course_ref
    LEFT JOIN offers offer ON offer.product_id=product.id
    ORDER BY course.course_ref,section.position,lesson.position,lesson.lesson_ref`).all() as LibraryRow[];
  const grants = db.prepare(`SELECT scope,course_ref FROM course_entitlements
    WHERE customer_id=? AND revoked_at IS NULL`).all(customerId) as ActiveGrant[];
  const overrides = db.prepare(`SELECT course_ref,scope_level,scope_ref FROM access_overrides
    WHERE state='PENDING'`).all() as Array<{ course_ref: string; scope_level: "COURSE" | "SECTION" | "LESSON"; scope_ref: string }>;
  const entitledCourse = (courseRef: string) => grants.some((grant) =>
    grant.scope === "ALL_COURSES" || (grant.scope === "COURSE" && grant.course_ref === courseRef));
  const result = new Map<string, CustomerLibrary["courses"][number]>();

  for (const row of rows) {
    const entitled = entitledCourse(row.course_ref);
    const effectiveVisibility = row.course_visibility === "LISTED"
      && row.section_visibility === "LISTED"
      && row.lesson_visibility === "LISTED" ? "LISTED" : "UNLISTED";
    const activeOverride = overrides.some((override) => override.course_ref === row.course_ref && (
      override.scope_level === "COURSE"
      || (override.scope_level === "SECTION" && override.scope_ref === row.section_ref)
      || (override.scope_level === "LESSON" && override.scope_ref === row.lesson_ref)
    ));
    const reconciledAt = Date.parse(row.last_reconciled_at);
    const projectionStale = !Number.isFinite(reconciledAt) || now.getTime() - reconciledAt > leaseMs;
    const decision = decideLessonAccess({
      customerId,
      courseRef: row.course_ref,
      lesson: {
        everPublished: Boolean(row.ever_published),
        effectiveVisibility,
        freePreview: Boolean(row.free_preview),
        withdrawn: Boolean(row.lesson_withdrawn_at),
      },
      courseProduct: row.access_model ? {
        accessModel: row.access_model,
        withdrawn: Boolean(row.product_withdrawn_at),
        saleMode: row.sale_mode,
      } : undefined,
      grants: grants.map((grant) => ({ scope: grant.scope, courseRef: grant.course_ref ?? undefined, revoked: false })),
      activeDenyNonEntitledOverride: activeOverride,
      projectionStale,
    });
    if (decision !== "ALLOW") continue;
    const access = entitled ? "ENTITLED" : row.access_model === "FREE" ? "FREE" : "PREVIEW";
    const course = result.get(row.course_ref) ?? { courseRef: row.course_ref, access, lessons: [] };
    course.lessons.push({ lessonRef: row.lesson_ref, sectionRef: row.section_ref, access });
    if (access === "ENTITLED") course.access = "ENTITLED";
    else if (access === "FREE" && course.access === "PREVIEW") course.access = "FREE";
    result.set(row.course_ref, course);
  }
  return { courses: [...result.values()] };
}

export function listCustomerOrderHistory(db: Database.Database, customerId: string) {
  return db.prepare(`SELECT orders.public_id AS orderPublicId,orders.state,orders.total_kopecks AS amountKopecks,
      orders.currency,line.title_snapshot AS title,line.offer_ref_snapshot AS offerRef,product.kind AS productKind,
      orders.created_at AS createdAt,orders.updated_at AS updatedAt
    FROM orders JOIN order_lines line ON line.order_id=orders.id JOIN products product ON product.id=line.product_id
    WHERE orders.customer_id=?
      AND COALESCE(json_extract(orders.checkout_snapshot_json,'$.schema'),'')<>'flexperiment.manual-entitlement/1'
    ORDER BY orders.created_at DESC,orders.public_id DESC`).all(customerId) as Array<{
      orderPublicId: string;
      state: "DRAFT" | "PAYMENT_PENDING" | "FULFILLED" | "EXPIRED" | "CANCELLED" | "REFUND_PENDING" | "REFUNDED" | "REVIEW_REQUIRED";
      amountKopecks: number;
      currency: "RUB";
      title: string;
      offerRef: string;
      productKind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
      createdAt: string;
      updatedAt: string;
    }>;
}
