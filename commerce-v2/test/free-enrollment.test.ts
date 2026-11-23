import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCommerceV2App } from "../src/app";
import { configureProduct, withdrawProduct } from "../src/catalog-control";
import { publishEditorialDraft, saveEditorialDraft } from "../src/course-editorial";
import { migrateV2 } from "../src/db";
import { enrollInFreeCourse, freeEnrollmentStatus } from "../src/free-enrollment";
import { listCustomerLibrary } from "../src/library";
import { loadCommerceRuntimeConfig } from "../src/payment-mode";
import { resolvePlaybackAccess } from "../src/playback-access";
import { listCustomerStorefrontLibrary } from "../src/storefront-content";
import { confirmSyntheticAccount } from "./fixtures/confirmed-account";

const ORIGIN = "http://localhost:3001"; // loadCommerceOrigins({ NODE_ENV: "test" }).platform
const at = new Date("2026-11-20T10:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled" });
const drm = { keyring: { currentKeyId: "k1", keys: { k1: "s".repeat(32) } }, username: "drm", password: "synthetic" };

let root: string;
let db: Database.Database;
const open = () => {
  const connection = new Database(join(root, "commerce.sqlite"));
  connection.pragma("foreign_keys=ON"); connection.pragma("journal_mode=WAL"); connection.pragma("busy_timeout=0");
  return connection;
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flex-128-"));
  db = open(); migrateV2(db);
  for (const id of ["student", "other"]) {
    db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id}@example.test`);
    confirmSyntheticAccount(db, id);
  }
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

function publish(courseRef: string, accessModel: "FREE" | "PAID", options: { previewFirst?: boolean; visibility?: "LISTED" | "UNLISTED" } = {}) {
  configureProduct(db, config, { kind: "ONLINE_COURSE", courseRef, productRef: `course:${courseRef}`, offerRef: `course:${courseRef}`,
    accessModel, priceKopecks: accessModel === "FREE" ? 0 : 100, saleMode: "CLOSED", expectedVersion: 0, actor: "control-room" }, at.toISOString());
  saveEditorialDraft(db, { expectedRevision: 0, actor: "control-room", document: {
    courseRef, title: `Course ${courseRef}`, slug: courseRef, summary: "", visibility: options.visibility ?? "LISTED",
    sections: [{ sectionRef: `${courseRef}-s2`, title: "Second", position: 1, visibility: "LISTED" },
      { sectionRef: `${courseRef}-s1`, title: "First", position: 0, visibility: "LISTED" }],
    lessons: [
      { lessonRef: `${courseRef}-l2`, sectionRef: `${courseRef}-s2`, title: "Two", slug: "two", position: 0, visibility: "LISTED", freePreview: false },
      { lessonRef: `${courseRef}-l1`, sectionRef: `${courseRef}-s1`, title: "One", slug: "one", position: 0, visibility: "LISTED",
        freePreview: options.previewFirst ?? false },
    ],
  } }, at.toISOString());
  publishEditorialDraft(db, { courseRef, expectedRevision: 1, expectedPublishedVersion: 0, idempotencyKey: `publish-${courseRef}`,
    actor: "control-room" }, at.toISOString());
  for (const lesson of ["l1", "l2"]) {
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES (?,?,?,?)")
      .run(`${courseRef}-${lesson}`, `${courseRef}-${lesson}-video`, at.toISOString(), at.toISOString());
  }
}
const toPaid = (courseRef: string) => configureProduct(db, config, { kind: "ONLINE_COURSE", courseRef, productRef: `course:${courseRef}`,
  offerRef: `course:${courseRef}`, accessModel: "PAID", priceKopecks: 100, saleMode: "CLOSED", expectedVersion: 1, actor: "control-room" }, at.toISOString());
const decision = (courseRef: string, customerId = "student", lesson = "l1") =>
  resolvePlaybackAccess(db, { customerId, lessonRef: `${courseRef}-${lesson}`, now: at, leaseMs: day }).decision;
const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
const app = (protectedDelivery = false) => createCommerceV2App({ db, sourceCommit: "a".repeat(40), serviceToken: "synthetic-service",
  config: protectedDelivery
    ? loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-" })
    : loadCommerceRuntimeConfig({ DEPLOY_ENV: "staging", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "open" }),
  ...(protectedDelivery ? { kinescopeDrmAuth: drm } : {}),
  authenticateCustomer: async headers => headers.get("authorization")?.replace(/^Session /, "") || null, now: () => at });
const enroll = (server: ReturnType<typeof app>, body: unknown, customer: string | null = "student", origin: string | null = ORIGIN) =>
  server.request("/v1/me/free-enrollments", { method: "POST", body: JSON.stringify(body), headers: {
    "content-type": "application/json", ...(customer ? { authorization: `Session ${customer}` } : {}), ...(origin ? { origin } : {}) } });
const NON_FINANCIAL = ["orders", "order_lines", "course_entitlements", "course_access_starts", "checkout_attempts", "refund_requests"];

describe("FLEX-128 explicit FREE enrollment", () => {
  it("refuses guests, foreign or absent origin and malformed input before any write", async () => {
    publish("free", "FREE");
    const server = app();
    expect((await enroll(server, { courseSlug: "free" }, null)).status).toBe(401);
    expect(await (await enroll(server, { courseSlug: "free" }, "student", "https://evil.example")).json()).toEqual({ code: "ORIGIN_FORBIDDEN" });
    expect((await enroll(server, { courseSlug: "free" }, "student", null)).status).toBe(403);
    for (const body of [null, [], { courseSlug: 1 }, { courseSlug: "free", lessonSlug: 2 }, { courseSlug: "../x" }]) {
      expect((await enroll(server, body)).status).toBe(422);
    }
    expect((await server.request("/v1/me/free-enrollments/free")).status).toBe(401);
    expect(count("free_course_enrollments") + count("course_learning_starts")).toBe(0);
  });

  it.each(["unverified", "consent", "unbound"])("refuses an account without %s and writes nothing", async state => {
    publish("free", "FREE");
    if (state === "unverified") db.exec(`UPDATE "user" SET email_verified=0 WHERE id='synthetic-user-student'`);
    if (state === "consent") db.exec("DELETE FROM authenticated_consent_actions WHERE customer_id='student'");
    if (state === "unbound") db.exec("UPDATE customers SET auth_user_id=NULL WHERE id='student'");
    const response = await enroll(app(), { courseSlug: "free" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: state === "consent" ? "CONSENT_REQUIRED" : "VERIFIED_ACCOUNT_REQUIRED" });
    expect(count("free_course_enrollments") + count("course_learning_starts")).toBe(0);
  });

  it("refuses paid, unlisted, withdrawn, unknown and lesson-less courses", async () => {
    publish("paid", "PAID"); publish("hidden", "FREE", { visibility: "UNLISTED" }); publish("gone", "FREE");
    withdrawProduct(db, { productRef: "course:gone", expectedVersion: 1, actor: "control-room", reason: "Rights ended", termsRef: "t" }, at.toISOString());
    const server = app();
    expect(await (await enroll(server, { courseSlug: "paid" })).json()).toEqual({ code: "FREE_COURSE_REQUIRED" });
    for (const slug of ["hidden", "gone", "missing"]) expect((await enroll(server, { courseSlug: slug })).status).toBe(404);
    publish("empty", "FREE");
    db.exec("UPDATE catalog_lesson_projection SET visibility='UNLISTED' WHERE course_ref='empty'");
    expect(await (await enroll(server, { courseSlug: "empty" })).json()).toEqual({ code: "COURSE_NOT_READY" });
    expect(await (await enroll(server, { courseSlug: "free-missing" })).json()).toEqual({ code: "COURSE_NOT_FOUND" });
    expect(count("free_course_enrollments") + count("course_learning_starts")).toBe(0);
  });

  it("records the right and the start once, opens the first lesson, and repeats idempotently without finance", async () => {
    publish("free", "FREE");
    const server = app();
    const status = await server.request("/v1/me/free-enrollments/free", { headers: { authorization: "Session student" } });
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    expect(await status.json()).toEqual({ courseRef: "free", courseSlug: "free", courseTitle: "Course free", accessModel: "FREE", enrollment: null, enrollable: true });
    const first = await enroll(server, { courseSlug: "free" });
    expect(first.status).toBe(201);
    const expected = { courseRef: "free", courseSlug: "free", enrolledAt: at.toISOString(), startedAt: at.toISOString(), progressPercent: 0 };
    // Syllabus order: section position 0 (lesson "one") precedes section position 1.
    expect(await first.json()).toEqual({ ...expected, created: true, lessonPath: "/courses/free/lessons/one" });
    const repeat = await enroll(server, { courseSlug: "free", lessonSlug: "two" });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ...expected, created: false, lessonPath: "/courses/free/lessons/two" });
    expect(db.prepare("SELECT customer_id,course_ref,source,started_at FROM course_learning_starts").all())
      .toEqual([{ customer_id: "student", course_ref: "free", source: "FREE_ENROLLMENT", started_at: at.toISOString() }]);
    expect(count("free_course_enrollments")).toBe(1);
    for (const table of NON_FINANCIAL) expect(count(table)).toBe(0);
    // No viewing/completion is inferred from the click.
    expect(count("lesson_resume_positions") + count("playback_access_events")).toBe(0);
    expect(() => db.exec("UPDATE course_learning_starts SET started_at='x'")).toThrow("COURSE_LEARNING_START_IMMUTABLE");
    expect(() => db.exec(`INSERT INTO course_learning_starts VALUES ('other','free',(SELECT id FROM products WHERE course_ref='free'),'FREE_ENROLLMENT','x')`))
      .toThrow("COURSE_LEARNING_START_AUTHORITY_INVALID");
  });

  it("keeps the chosen lesson through enrollment and refuses an unknown one without writing", async () => {
    publish("free", "FREE");
    const server = app();
    expect(await (await enroll(server, { courseSlug: "free", lessonSlug: "nope" })).json()).toEqual({ code: "LESSON_NOT_FOUND" });
    expect(count("free_course_enrollments")).toBe(0);
    expect((await (await enroll(server, { courseSlug: "free", lessonSlug: "two" })).json() as { lessonPath: string }).lessonPath)
      .toBe("/courses/free/lessons/two");
  });

  it("serializes a concurrent writer: a locked enrollment rolls back and its retry is exactly-once", () => {
    publish("free", "FREE");
    const other = open();
    try {
      // Another connection holds the write lock (e.g. a FREE→PAID command in flight).
      other.prepare("BEGIN IMMEDIATE").run();
      expect(() => enrollInFreeCourse(db, { customerId: "student", courseSlug: "free" }, at.toISOString())).toThrow(/locked|busy/i);
      other.prepare("ROLLBACK").run();
      expect(count("free_course_enrollments") + count("course_learning_starts")).toBe(0);
      const a = enrollInFreeCourse(db, { customerId: "student", courseSlug: "free" }, at.toISOString());
      const b = enrollInFreeCourse(other, { customerId: "student", courseSlug: "free" }, "2026-11-20T10:00:01.000Z");
      expect([a.created, b.created]).toEqual([true, false]);
      expect(b.enrolledAt).toBe(a.enrolledAt);
      expect(count("free_course_enrollments")).toBe(1); expect(count("course_learning_starts")).toBe(1);
    } finally { other.close(); }
  });

  it.each(["enroll-first", "paid-first"])("orders enrollment against FREE→PAID on separate connections (%s)", order => {
    publish("free", "FREE");
    const other = open();
    try {
      if (order === "enroll-first") {
        enrollInFreeCourse(other, { customerId: "student", courseSlug: "free" }, at.toISOString());
        toPaid("free");
        expect(decision("free")).toBe("ALLOW");
        // A repeat after the change answers the retained enrollment and writes nothing new.
        expect(enrollInFreeCourse(other, { customerId: "student", courseSlug: "free" }).created).toBe(false);
      } else {
        toPaid("free");
        expect(() => enrollInFreeCourse(other, { customerId: "student", courseSlug: "free" }, at.toISOString())).toThrow("FREE_COURSE_REQUIRED");
        expect(decision("free")).toBe("NOT_FOR_SALE");
      }
      expect(decision("free", "other")).toBe("NOT_FOR_SALE");
      expect(count("free_course_enrollments")).toBe(order === "enroll-first" ? 1 : 0);
      expect(count("course_learning_starts")).toBe(order === "enroll-first" ? 1 : 0);
    } finally { other.close(); }
  });
});

describe("FLEX-128 access, grant and library", () => {
  it("answers ENROLLMENT_REQUIRED for every lesson before enrollment and never enrolls from a grant", async () => {
    publish("free", "FREE", { previewFirst: true });
    const server = app(true);
    const before = await server.request("/v1/lessons/free-l1/playback", { method: "POST", headers: { authorization: "Session student" } });
    expect(before.status).toBe(403);
    expect(await before.json()).toEqual({ decision: "ENROLLMENT_REQUIRED" });
    expect(decision("free", "student", "l2")).toBe("ENROLLMENT_REQUIRED");
    expect(count("free_course_enrollments")).toBe(0);
    expect(db.prepare("SELECT event_type,reason FROM playback_access_events").all())
      .toEqual([{ event_type: "GRANT_DENIED", reason: "ENROLLMENT_REQUIRED" }]);
    expect(listCustomerLibrary(db, "student", at)).toEqual({ courses: [] });

    expect((await enroll(server, { courseSlug: "free" })).status).toBe(201);
    const granted = await server.request("/v1/lessons/free-l1/playback", { method: "POST", headers: { authorization: "Session student" } });
    expect(granted.status).toBe(200);
    const grant = await granted.json() as { mode: string; token: string; videoId: string };
    expect(grant).toMatchObject({ mode: "protected", videoId: "free-l1-video" });
    const authorize = await server.request("/v1/kinescope/drm/authorize", { method: "POST", headers: {
      authorization: `Basic ${Buffer.from("drm:synthetic").toString("base64")}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "free-l1-video", token: grant.token, type: "vod" }) });
    expect(authorize.status).toBe(200);
    // A FREE course start is not a paid access start.
    for (const table of NON_FINANCIAL) expect(count(table)).toBe(0);
  });

  it("keeps free previews of a paid course open to a consented account without any enrollment", async () => {
    publish("paid", "PAID", { previewFirst: true });
    const response = await app(true).request("/v1/lessons/paid-l1/playback", { method: "POST", headers: { authorization: "Session student" } });
    expect(response.status).toBe(200);
    expect(decision("paid", "student", "l2")).toBe("NOT_FOR_SALE");
    expect(count("free_course_enrollments") + count("course_learning_starts")).toBe(0);
    expect(listCustomerLibrary(db, "student", at).courses).toEqual([
      { courseRef: "paid", access: "PREVIEW", enrollment: null, lessons: [{ lessonRef: "paid-l1", sectionRef: "paid-s1", access: "PREVIEW" }] },
    ]);
  });

  it("distinguishes the enrolled course in the library and keeps it after FREE→PAID", () => {
    publish("free", "FREE"); publish("paid", "PAID", { previewFirst: true });
    enrollInFreeCourse(db, { customerId: "student", courseSlug: "free" }, at.toISOString());
    const enrollment = { enrolledAt: at.toISOString(), startedAt: at.toISOString(), progressPercent: 0 };
    const library = () => listCustomerStorefrontLibrary(db, "student", at, day).courses.map(c => [c.courseRef, c.access, c.enrollment]);
    expect(library()).toEqual([["free", "FREE", enrollment], ["paid", "PREVIEW", null]]);
    toPaid("free");
    expect(library()).toEqual([["free", "FREE", enrollment], ["paid", "PREVIEW", null]]);
    expect(freeEnrollmentStatus(db, "student", "free")).toMatchObject({ accessModel: "PAID", enrollment, enrollable: false });
    expect(freeEnrollmentStatus(db, "other", "free")).toMatchObject({ accessModel: "PAID", enrollment: null, enrollable: false });
    // Retained access keeps the general restrictions.
    db.exec("UPDATE catalog_lesson_projection SET visibility='UNLISTED' WHERE lesson_ref='free-l1'");
    expect(decision("free")).toBe("DENY");
    expect(decision("free", "student", "l2")).toBe("ALLOW");
  });

  it("D-13 (owner, variant A): after FREE→PAID the enrolled keep every current published lesson, including later ones", () => {
    publish("free", "FREE");
    enrollInFreeCourse(db, { customerId: "student", courseSlug: "free" }, at.toISOString());
    toPaid("free");
    // Sale opening is out of scope here; the offer's mode is set directly so the non-enrolled answer is PURCHASE_REQUIRED.
    db.exec("UPDATE offers SET sale_mode='PUBLIC' WHERE offer_ref='course:free'");
    saveEditorialDraft(db, { expectedRevision: 1, actor: "control-room", document: {
      courseRef: "free", title: "Course free", slug: "free", summary: "", visibility: "LISTED",
      sections: [{ sectionRef: "free-s2", title: "Second", position: 1, visibility: "LISTED" },
        { sectionRef: "free-s1", title: "First", position: 0, visibility: "LISTED" }],
      lessons: [
        { lessonRef: "free-l2", sectionRef: "free-s2", title: "Two", slug: "two", position: 0, visibility: "LISTED", freePreview: false },
        { lessonRef: "free-l1", sectionRef: "free-s1", title: "One", slug: "one", position: 0, visibility: "LISTED", freePreview: false },
        { lessonRef: "free-l3", sectionRef: "free-s2", title: "Three", slug: "three", position: 1, visibility: "LISTED", freePreview: false },
      ],
    } }, at.toISOString());
    publishEditorialDraft(db, { courseRef: "free", expectedRevision: 2, expectedPublishedVersion: 1, idempotencyKey: "publish-free-2",
      actor: "control-room" }, at.toISOString());
    db.prepare("INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at) VALUES ('free-l3','free-l3-video',?,?)")
      .run(at.toISOString(), at.toISOString());
    expect(decision("free", "student", "l3")).toBe("ALLOW");
    expect(decision("free", "other", "l3")).toBe("PURCHASE_REQUIRED");
    expect(listCustomerLibrary(db, "student", at).courses[0]!.lessons.map(lesson => lesson.lessonRef)).toEqual(["free-l1", "free-l2", "free-l3"]);
    // The usual restrictions still apply to the later lesson.
    db.exec("UPDATE catalog_lesson_projection SET visibility='UNLISTED' WHERE lesson_ref='free-l3'");
    expect(decision("free", "student", "l3")).toBe("DENY");
    for (const table of NON_FINANCIAL) expect(count(table)).toBe(0);
  });

  it("keeps a historical implicit enrollment valid without inventing a start fact", () => {
    publish("free", "FREE");
    // As an old playback grant recorded it before FLEX-128: enrollment only, no start row.
    db.prepare(`INSERT INTO free_course_enrollments(customer_id,product_id,product_version,enrolled_at)
      SELECT 'student',id,version,'2026-10-01T00:00:00.000Z' FROM products WHERE course_ref='free'`).run();
    expect(decision("free")).toBe("ALLOW");
    expect(freeEnrollmentStatus(db, "student", "free")?.enrollment)
      .toEqual({ courseRef: "free", courseSlug: "free", enrolledAt: "2026-10-01T00:00:00.000Z", startedAt: null, progressPercent: 0 });
    const repeat = enrollInFreeCourse(db, { customerId: "student", courseSlug: "free" }, at.toISOString());
    expect(repeat).toMatchObject({ created: false, startedAt: null });
    expect(count("course_learning_starts")).toBe(0);
  });
});
