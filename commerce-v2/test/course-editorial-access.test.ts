import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRestrictiveOverride, releaseRolledBackOverride } from "../src/access-overrides";
import { configureProduct, withdrawProduct } from "../src/catalog-control";
import { saveEditorialDraft, publishEditorialDraft } from "../src/course-editorial";
import { migrateV2 } from "../src/db";
import { listCustomerLibrary } from "../src/library";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { resolvePlaybackAccess } from "../src/playback-access";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";

let db: Database.Database;
const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" });
const publishedAt = new Date("2026-10-13T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const later = (days: number) => new Date(publishedAt.getTime() + days * day);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrateV2(db);
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('student','student@example.com')").run();
  confirmSyntheticAccount(db, "student");
});
afterEach(() => db.close());

function publishCourse(courseRef: string, accessModel: "FREE" | "PAID", freePreview = false) {
  configureProduct(db, config, { kind: "ONLINE_COURSE", courseRef, productRef: `course:${courseRef}`,
    offerRef: `course:${courseRef}`, accessModel, priceKopecks: accessModel === "FREE" ? 0 : 100,
    saleMode: "CLOSED", expectedVersion: 0, actor: "control-room" }, publishedAt.toISOString());
  saveEditorialDraft(db, { expectedRevision: 0, actor: "control-room", document: {
    courseRef, title: courseRef, slug: courseRef, summary: "", visibility: "LISTED",
    sections: [{ sectionRef: `${courseRef}-section`, title: "Section", position: 0, visibility: "LISTED" }],
    lessons: [{ lessonRef: `${courseRef}-lesson`, sectionRef: `${courseRef}-section`, title: "Lesson", slug: "lesson",
      position: 0, visibility: "LISTED", freePreview }],
  } }, publishedAt.toISOString());
  publishEditorialDraft(db, { courseRef, expectedRevision: 1, expectedPublishedVersion: 0,
    idempotencyKey: `publish-${courseRef}`, actor: "control-room" }, publishedAt.toISOString());
  db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES (?,?,?,?)`)
    .run(`${courseRef}-lesson`, `${courseRef}-video`, publishedAt.toISOString(), publishedAt.toISOString());
}

const access = (courseRef: string, when: Date, recordFreeEnrollment = false) => resolvePlaybackAccess(db, {
  customerId: "student", lessonRef: `${courseRef}-lesson`, now: when, leaseMs: day, recordFreeEnrollment,
});
const library = (when: Date) => listCustomerLibrary(db, "student", when, day);

describe("Commerce editorial access without a manifest lease", () => {
  it("keeps FREE, preview and retained FREE enrollment available at 25 hours and seven days", () => {
    publishCourse("free", "FREE");
    publishCourse("preview", "PAID", true);
    expect(access("free", later(0), true).decision).toBe("ALLOW");
    configureProduct(db, config, { kind: "ONLINE_COURSE", courseRef: "free", productRef: "course:free",
      offerRef: "course:free", accessModel: "PAID", priceKopecks: 100, saleMode: "CLOSED",
      expectedVersion: 1, actor: "control-room" }, publishedAt.toISOString());

    for (const when of [later(25 / 24), later(7)]) {
      expect(access("free", when).decision).toBe("ALLOW");
      expect(access("preview", when).decision).toBe("ALLOW");
      expect(library(when).courses.map((course) => [course.courseRef, course.access])).toEqual([
        ["free", "FREE"], ["preview", "PREVIEW"],
      ]);
    }
  });

  it("enforces local visibility and withdrawal without waiting for reconciliation", () => {
    publishCourse("free", "FREE");
    expect(access("free", later(7)).decision).toBe("ALLOW");
    db.prepare("UPDATE catalog_lesson_projection SET visibility='UNLISTED' WHERE lesson_ref='free-lesson'").run();
    expect(access("free", later(7)).decision).toBe("DENY");
    expect(library(later(7)).courses).toEqual([]);
    db.prepare("UPDATE catalog_lesson_projection SET visibility='LISTED' WHERE lesson_ref='free-lesson'").run();
    withdrawProduct(db, { productRef: "course:free", expectedVersion: 1, actor: "control-room",
      reason: "Rights ended", termsRef: "terms-v1" }, later(7).toISOString());
    expect(access("free", later(7)).decision).toBe("DENY");
    expect(library(later(7)).courses).toEqual([]);
  });

  it("refuses handover with a pending legacy restriction and rejects new legacy overrides", () => {
    const override = { operationId: "legacy-operation", courseRef: "free",
      scope: { level: "COURSE" as const, ref: "free" },
      expected: { kind: "EFFECTIVE_VISIBILITY" as const, value: "UNLISTED" as const },
      deadlineAt: later(1).toISOString(), platformEpoch: "legacy-epoch" };
    createRestrictiveOverride(db, override);
    expect(() => publishCourse("free", "FREE")).toThrow("PENDING_LEGACY_OVERRIDE");
    expect(db.prepare("SELECT count(*) n FROM catalog_course_projection").get()).toEqual({ n: 0 });

    releaseRolledBackOverride(db, override.operationId, { checkedAt: later(2).toISOString(),
      currentPlatformEpoch: "new-epoch", committedRecordExists: false, operationInFlight: false, transactionEnded: true });
    publishEditorialDraft(db, { courseRef: "free", expectedRevision: 1, expectedPublishedVersion: 0,
      idempotencyKey: "publish-free", actor: "control-room" }, publishedAt.toISOString());
    expect(() => createRestrictiveOverride(db, { ...override, operationId: "late-operation" }))
      .toThrow("COMMERCE_EDITORIAL_OWNED");
    expect(access("free", later(7)).decision).toBe("ALLOW");
  });
});
