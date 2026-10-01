import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { grantEntitlement, grantManualEntitlement } from "../src/entitlements";
import { listCustomerLibrary, listCustomerOrderHistory } from "../src/library";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','student@example.com')").run();
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-a-v1','{}','2026-09-30T00:00:00Z',1)`).run();
});

const addCourse = (input: {
  courseRef: string;
  accessModel: "FREE" | "PAID";
  visibility?: "LISTED" | "UNLISTED";
  reconciledAt?: string;
  withdrawn?: boolean;
}) => {
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref,withdrawn_at,withdrawn_reason,withdrawn_terms_ref)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    `product:${input.courseRef}`,
    `course:${input.courseRef}`,
    "ONLINE_COURSE",
    input.accessModel,
    input.courseRef,
    input.withdrawn ? "2026-09-30T12:00:00.000Z" : null,
    input.withdrawn ? "Retired" : null,
    input.withdrawn ? "terms-v1" : null,
  );
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES (?,?,?,?,?)`).run(`offer:${input.courseRef}`, `course:${input.courseRef}`, `product:${input.courseRef}`, input.accessModel === "FREE" ? 0 : 10000, "CLOSED");
  db.prepare(`INSERT INTO catalog_course_projection(course_ref,version,content_hash,visibility,last_reconciled_at)
    VALUES (?,1,?,?,?)`).run(input.courseRef, "a".repeat(64), input.visibility ?? "LISTED", input.reconciledAt ?? "2026-10-01T09:59:00.000Z");
  db.prepare(`INSERT INTO catalog_section_projection(section_ref,course_ref,visibility,position)
    VALUES (?,?,?,0)`).run(`section:${input.courseRef}`, input.courseRef, "LISTED");
};

const addLesson = (courseRef: string, suffix: string, freePreview = false) => {
  const lessonRef = `lesson:${courseRef}:${suffix}`;
  db.prepare(`INSERT INTO catalog_lesson_projection
    (lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position)
    VALUES (?,?,?,1,'LISTED',?,?)`).run(lessonRef, courseRef, `section:${courseRef}`, Number(freePreview), suffix === "one" ? 0 : 1);
  return lessonRef;
};

const addPaidOrder = (courseRef: string) => {
  db.prepare(`INSERT INTO orders
    (id,public_id,customer_id,state,total_kopecks,checkout_snapshot_json,snapshot_hash,legal_release_id,created_at,updated_at)
    VALUES (?,?,?,'FULFILLED',10000,'{}',?,'legal','2026-09-30T10:00:00.000Z','2026-09-30T10:00:00.000Z')`)
    .run(`order:${courseRef}`, `FX-${courseRef}`, "customer", "b".repeat(64));
  db.prepare(`INSERT INTO order_lines
    (id,order_id,product_id,offer_ref_snapshot,title_snapshot,unit_amount_kopecks,legal_terms_ref)
    VALUES (?,?,?,?,?,10000,'terms-v1')`)
    .run(`line:${courseRef}`, `order:${courseRef}`, `product:${courseRef}`, `course:${courseRef}`, `Course ${courseRef}`);
  grantEntitlement(db, { customerId: "customer", scope: "COURSE", courseRef, sourceOrderLineId: `line:${courseRef}` });
};

describe("customer library", () => {
  it("returns only lessons the signed-in customer can open under the shared access policy", () => {
    addCourse({ courseRef: "free", accessModel: "FREE" });
    const free = addLesson("free", "one");
    addCourse({ courseRef: "preview", accessModel: "PAID" });
    const preview = addLesson("preview", "one", true);
    addLesson("preview", "two");
    addCourse({ courseRef: "owned", accessModel: "PAID", visibility: "UNLISTED", reconciledAt: "2026-09-01T00:00:00.000Z" });
    const owned = addLesson("owned", "one");
    addPaidOrder("owned");
    addCourse({ courseRef: "withdrawn", accessModel: "PAID", withdrawn: true });
    addLesson("withdrawn", "one");
    addPaidOrder("withdrawn");

    expect(listCustomerLibrary(db, "customer", new Date("2026-10-01T10:00:00.000Z"))).toEqual({
      courses: [
        { courseRef: "free", access: "FREE", lessons: [{ lessonRef: free, sectionRef: "section:free", access: "FREE" }] },
        { courseRef: "owned", access: "ENTITLED", lessons: [{ lessonRef: owned, sectionRef: "section:owned", access: "ENTITLED" }] },
        { courseRef: "preview", access: "PREVIEW", lessons: [{ lessonRef: preview, sectionRef: "section:preview", access: "PREVIEW" }] },
      ],
    });
  });

  it("shows purchase history without presenting manual access as a purchase", () => {
    addCourse({ courseRef: "owned", accessModel: "PAID" });
    addPaidOrder("owned");
    grantManualEntitlement(db, {
      customerId: "customer",
      scope: "COURSE",
      courseRef: "owned",
      reason: "Teacher access",
      evidenceRef: "ART-181/manual",
      legalTermsRef: "manual-access-v1",
      idempotencyKey: "manual-library-history",
      actor: "admin",
    });

    expect(listCustomerOrderHistory(db, "customer")).toEqual([{
      orderPublicId: "FX-owned",
      state: "FULFILLED",
      amountKopecks: 10000,
      currency: "RUB",
      title: "Course owned",
      offerRef: "course:owned",
      productKind: "ONLINE_COURSE",
      createdAt: "2026-09-30T10:00:00.000Z",
      updatedAt: "2026-09-30T10:00:00.000Z",
    }]);
  });
});
