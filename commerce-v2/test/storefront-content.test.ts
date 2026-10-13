import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { saveEditorialDraft, publishEditorialDraft } from "../src/course-editorial";
import { migrateV2 } from "../src/db";
import { grantManualEntitlement, revokeManualEntitlement } from "../src/entitlements";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";

let db: Database.Database;
const now = new Date("2026-10-13T00:00:00.000Z");
const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" });
const app = () => createCommerceV2App({ db, config, sourceCommit: "a".repeat(40), serviceToken: "service",
  authenticateCustomer: async headers => headers.get("cookie") === "session=customer" ? "customer" : null,
  now: () => now });

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrateV2(db);
  db.prepare("INSERT INTO customers(id,email_normalized) VALUES ('customer','customer@example.test')").run();
  confirmSyntheticAccount(db, "customer");
});
afterEach(() => db.close());

function publish() {
  db.prepare(`INSERT INTO products(id,product_ref,kind,access_model,course_ref)
    VALUES ('product','course:demo','ONLINE_COURSE','PAID','demo')`).run();
  db.prepare(`INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode)
    VALUES ('offer','course:demo','product',100,'CLOSED')`).run();
  saveEditorialDraft(db, { expectedRevision: 0, actor: "author", document: {
    courseRef: "demo", title: "Demo course", slug: "demo", summary: "Public summary", visibility: "LISTED",
    sections: [{ sectionRef: "section", title: "Section", position: 0, visibility: "LISTED" }],
    lessons: [{ lessonRef: "lesson", sectionRef: "section", title: "Lesson", slug: "lesson", position: 0,
      visibility: "LISTED", freePreview: false,
      description: { root: { type: "root", version: 1, children: [{ type: "paragraph", version: 1,
        children: [{ type: "text", version: 1, text: "Private lesson text" }] }] } } }],
  } }, now.toISOString());
  publishEditorialDraft(db, { courseRef: "demo", expectedRevision: 1, expectedPublishedVersion: 0,
    idempotencyKey: "publish-demo", actor: "author" }, now.toISOString());
  db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at)
    VALUES ('lesson','secret-video-id',?,?)`).run(now.toISOString(), now.toISOString());
}

describe("Commerce storefront read boundary", () => {
  it("serves only committed listed content and never exposes draft or video binding", async () => {
    const server = app();
    expect(await (await server.request("/v1/courses")).json()).toEqual({ courses: [] });
    publish();
    const listing = await server.request("/v1/courses");
    const listingBody = await listing.clone().text();
    expect(listing.headers.get("cache-control")).toBe("no-store");
    expect((await listing.json() as { courses: Array<{ course: { title: string } }> }).courses[0]?.course.title)
      .toBe("Demo course");
    const course = await server.request("/v1/courses/demo");
    const courseBody = await course.clone().text();
    expect(await course.json()).toMatchObject({ course: { version: 1, slug: "demo" },
      outline: { lessons: [{ lessonRef: "lesson", freePreview: false }] } });
    const lesson = await server.request("/v1/courses/demo/lessons/lesson");
    const lessonBody = await lesson.clone().text();
    expect(await lesson.json()).toMatchObject({ lesson: { description: null } });
    db.prepare("UPDATE products SET access_model='FREE' WHERE id='product'").run();
    expect(await (await server.request("/v1/courses/demo/lessons/lesson")).json())
      .toMatchObject({ lesson: { description: null } });
    for (const body of [listingBody, courseBody, lessonBody]) {
      expect(body).not.toMatch(/secret-video-id|Private lesson text|idempotencyKey|actor/);
    }
    db.prepare("UPDATE catalog_course_projection SET visibility='UNLISTED',editorial_restriction='EMERGENCY_UNLIST' WHERE course_ref='demo'").run();
    expect((await server.request("/v1/courses/demo")).status).toBe(404);
    expect(await (await server.request("/v1/courses")).json()).toEqual({ courses: [] });
    db.prepare("UPDATE catalog_course_projection SET visibility='LISTED',editorial_restriction='NONE' WHERE course_ref='demo'").run();
    db.prepare("UPDATE catalog_lesson_projection SET visibility='UNLISTED' WHERE lesson_ref='lesson'").run();
    expect((await server.request("/v1/courses/demo/lessons/lesson")).status).toBe(404);
    db.prepare("UPDATE catalog_lesson_projection SET visibility='LISTED' WHERE lesson_ref='lesson'").run();
    db.prepare("UPDATE products SET withdrawn_at=?,withdrawn_reason='test',withdrawn_terms_ref='terms-v1' WHERE id='product'")
      .run(now.toISOString());
    expect((await server.request("/v1/courses/demo")).status).toBe(404);
  });

  it("uses the current session, consent and lesson decision for private content", async () => {
    publish();
    const server = app();
    const path = "/v1/me/courses/demo/lessons/lesson";
    expect((await server.request(path)).status).toBe(401);
    expect((await server.request(path, { headers: { cookie: "session=customer" } })).status).toBe(404);
    const grant = grantManualEntitlement(db, { customerId: "customer", scope: "COURSE", courseRef: "demo",
      reason: "Isolated storefront test", evidenceRef: "ART-335-test", legalTermsRef: "terms-v1",
      idempotencyKey: "art335-grant", actor: "author" }, now.toISOString());
    const allowed = await server.request(path, { headers: { cookie: "session=customer" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("private, no-store");
    expect(await allowed.json()).toMatchObject({ lesson: { description: { root: { children: [
      { children: [{ text: "Private lesson text" }] }] } } } });
    const library = await server.request("/v1/me/course-library", { headers: { cookie: "session=customer" } });
    expect(await library.json()).toMatchObject({ courses: [{ title: "Demo course", lessons: [{ title: "Lesson" }] }] });
    revokeManualEntitlement(db, grant.entitlementId, { reason: "Test ended", evidenceRef: "ART-335-test",
      actor: "author" }, now.toISOString());
    expect((await server.request(path, { headers: { cookie: "session=customer" } })).status).toBe(404);
  });
});
