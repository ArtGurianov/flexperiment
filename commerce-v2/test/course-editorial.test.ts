import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { migrateV2 } from "../src/db";
import { getEditorialDraft, getEditorialPublished, publishEditorialDraft, relistEditorialCourse, restrictEditorialCourse, saveEditorialDraft, type EditorialDocument } from "../src/course-editorial";
import { applyCourseManifest, withManifestHash } from "../src/manifest";

let db: Database.Database;
const document = (patch: Partial<EditorialDocument> = {}): EditorialDocument => ({
  courseRef: "course", title: "Course", slug: "course", summary: "Summary", visibility: "LISTED",
  sections: [{ sectionRef: "section", title: "Section", position: 0, visibility: "LISTED" }],
  lessons: [{ lessonRef: "lesson", sectionRef: "section", title: "Lesson", slug: "lesson", position: 0,
    visibility: "LISTED", freePreview: false }], ...patch,
});
const save = (doc = document(), expectedRevision = 0) => saveEditorialDraft(db, { document: doc, expectedRevision, actor: "admin" });
const publish = (expectedRevision = 1, expectedPublishedVersion = 0, idempotencyKey = "publish-1") =>
  publishEditorialDraft(db, { courseRef: "course", expectedRevision, expectedPublishedVersion, idempotencyKey, actor: "admin" });
const assertVersionDigests = () => {
  const versions = db.prepare("SELECT version,document_json,content_hash FROM course_editorial_versions WHERE course_ref='course' ORDER BY version")
    .all() as Array<{ version: number; document_json: string; content_hash: string }>;
  for (const row of versions) expect(createHash("sha256").update(row.document_json).digest("hex")).toBe(row.content_hash);
  const current = db.prepare("SELECT version,content_hash FROM catalog_course_projection WHERE course_ref='course'")
    .get() as { version: number; content_hash: string };
  expect(current).toEqual({ version: versions.at(-1)?.version, content_hash: versions.at(-1)?.content_hash });
  expect(db.prepare("SELECT state_hash FROM catalog_course_projection WHERE course_ref='course'").get())
    .toEqual({ state_hash: current.content_hash });
  expect(JSON.stringify(getEditorialPublished(db, "course"))).toBe(versions.at(-1)?.document_json);
  return versions;
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  migrateV2(db);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:course','ONLINE_COURSE','FREE','course')").run();
});

describe("Commerce editorial publication on the real V2 schema", () => {
  it("keeps a draft private and publishes a complete version atomically with replay", () => {
    save();
    expect(getEditorialDraft(db, "course")?.revision).toBe(1);
    expect(getEditorialPublished(db, "course")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) n FROM catalog_lesson_projection").get()).toEqual({ n: 0 });
    const first = publish();
    expect(first).toMatchObject({ version: 1, replayed: false, visibility: "LISTED" });
    expect(publish()).toMatchObject({ version: 1, replayed: true });
    expect(() => publish(1, 1)).toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(db.prepare("SELECT authoring_source,title,slug FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ authoring_source: "COMMERCE_EDITORIAL", title: "Course", slug: "course" });
    expect(db.prepare("SELECT COUNT(*) n FROM course_editorial_versions").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='COURSE_EDITORIAL_PUBLISHED'").get()).toEqual({ n: 1 });
    expect(() => db.prepare("UPDATE course_editorial_versions SET actor='other'").run()).toThrow("EDITORIAL_VERSION_IMMUTABLE");
  });

  it("rejects stale revisions and versions without a partial projection", () => {
    save();
    expect(() => save(document({ title: "Stale" }), 0)).toThrow("DRAFT_REVISION_CONFLICT");
    expect(() => publish(1, 1)).toThrow("PUBLISHED_VERSION_CONFLICT");
    expect(db.prepare("SELECT COUNT(*) n FROM catalog_course_projection").get()).toEqual({ n: 0 });
    publish();
    save(document({ title: "Edited" }), 1);
    expect(() => publish(1, 1, "publish-2")).toThrow("DRAFT_REVISION_CONFLICT");
    expect(() => publish(2, 0, "publish-2")).toThrow("PUBLISHED_VERSION_CONFLICT");
    expect(db.prepare("SELECT title,version FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ title: "Course", version: 1 });
  });

  it("rolls back every write, audit and idempotency record on a SQL failure", () => {
    save();
    db.exec(`CREATE TRIGGER fail_editorial_lesson BEFORE INSERT ON catalog_lesson_projection
      BEGIN SELECT RAISE(ABORT,'INJECTED_LESSON_FAILURE'); END`);
    expect(() => publish()).toThrow("INJECTED_LESSON_FAILURE");
    for (const table of ["catalog_course_projection", "catalog_section_projection", "catalog_lesson_projection",
      "course_editorial_versions", "course_editorial_publish_commands", "audit_log"]) {
      expect(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    db.exec("DROP TRIGGER fail_editorial_lesson");
    expect(publish().version).toBe(1);
  });

  it("retains omitted refs and video bindings as unlisted and refuses identity changes", () => {
    save(); publish();
    db.prepare(`INSERT INTO lesson_video_bindings(lesson_ref,active_video_id,bound_at,updated_at)
      VALUES ('lesson','video','2026-10-13','2026-10-13')`).run();
    save(document({ sections: [{ sectionRef: "new-section", title: "New", position: 0, visibility: "LISTED" }],
      lessons: [{ lessonRef: "new-lesson", sectionRef: "new-section", title: "New", slug: "new-lesson", position: 0,
        visibility: "LISTED", freePreview: false }] }), 1);
    publish(2, 1, "publish-2");
    expect(db.prepare("SELECT visibility,free_preview FROM catalog_lesson_projection WHERE lesson_ref='lesson'").get())
      .toEqual({ visibility: "UNLISTED", free_preview: 0 });
    expect(db.prepare("SELECT visibility FROM catalog_section_projection WHERE section_ref='section'").get())
      .toEqual({ visibility: "UNLISTED" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='lesson'").get())
      .toEqual({ active_video_id: "video" });
    expect(() => db.prepare("DELETE FROM catalog_section_projection WHERE section_ref='section'").run()).toThrow("EDITORIAL_SECTION_IMMUTABLE");
    expect(() => db.prepare("DELETE FROM catalog_course_projection WHERE course_ref='course'").run()).toThrow("EDITORIAL_COURSE_IMMUTABLE");
    expect(() => db.prepare("UPDATE catalog_lesson_projection SET section_ref='new-section' WHERE lesson_ref='lesson'").run())
      .toThrow("EDITORIAL_LESSON_IDENTITY_IMMUTABLE");
    expect(() => db.prepare("INSERT INTO catalog_lesson_projection(lesson_ref,course_ref,section_ref,ever_published,visibility,free_preview,position) VALUES ('orphan','course','absent',1,'LISTED',0,9)").run())
      .toThrow("FOREIGN KEY constraint failed");
    save(document(), 2);
    publish(3, 2, "republish-3");
    expect(db.prepare("SELECT visibility FROM catalog_lesson_projection WHERE lesson_ref='lesson'").get())
      .toEqual({ visibility: "LISTED" });
    expect(db.prepare("SELECT active_video_id FROM lesson_video_bindings WHERE lesson_ref='lesson'").get())
      .toEqual({ active_video_id: "video" });
  });

  it("refuses a malformed Lexical child before persisting a draft", () => {
    const malformed = document({ description: { root: { type: "root", version: 1, children: [{ text: "missing type" }] } } });
    expect(() => save(malformed)).toThrow("LEXICAL_TREE_INVALID");
    expect(getEditorialDraft(db, "course")).toBeNull();
  });

  it("accepts the small editor format and rejects unsupported Lexical nodes", () => {
    const paragraph = { type: "paragraph", version: 1, children: [
      { type: "text", version: 1, text: "Course content", format: 1, style: "" },
      { type: "linebreak", version: 1 },
    ] };
    const description = { root: { type: "root" as const, version: 1, children: [paragraph] } };
    expect(save(document({ description })).revision).toBe(1);
    expect(() => save(document({ description: { root: { type: "root", version: 1, children: [
      { type: "heading", version: 1, tag: "h1", children: [] },
    ] } } }), 1)).toThrow("LEXICAL_TREE_INVALID");
    expect(getEditorialDraft(db, "course")?.revision).toBe(1);
  });

  it("accepts Lexical's serialized paragraph and rejects unknown attributes", () => {
    const textNode = { detail: 0, format: 3, mode: "normal", style: "", text: "Styled text", type: "text", version: 1 };
    const paragraph = { children: [textNode], direction: null, format: "", indent: 0, type: "paragraph", version: 1,
      textFormat: 0, textStyle: "" };
    const root = { children: [paragraph], direction: null, format: "", indent: 0, type: "root" as const, version: 1 };
    expect(save(document({ description: { root } })).revision).toBe(1);
    const invalid = [
      { root, html: "<script>unexpected</script>" },
      { root: { ...root, secret: "unexpected" } },
      { root: { ...root, children: [{ ...paragraph, unknown: "unexpected" }] } },
      { root: { ...root, children: [{ ...paragraph, children: [{ ...textNode, unknown: "unexpected" }] }] } },
      { root: { ...root, children: [{ ...paragraph, children: [{ ...textNode, style: "color:red" }] }] } },
      { root: { ...root, children: [{ ...paragraph, children: [{ ...textNode, format: 4 }] }] } },
      { root: { ...root, children: [{ ...paragraph, children: [{ ...textNode, mode: "token" }] }] } },
      { root: { ...root, children: [{ ...paragraph, textStyle: "color:red" }] } },
    ];
    for (const description of invalid) expect(() => save(document({ description }), 1)).toThrow("LEXICAL_TREE_INVALID");
    expect(getEditorialDraft(db, "course")?.revision).toBe(1);
  });

  it("publishes restrictive visibility immediately and blocks late legacy manifest writes", () => {
    save(); publish();
    save(document({ visibility: "UNLISTED" }), 1);
    publish(2, 1, "unlist-2");
    expect(db.prepare("SELECT visibility FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ visibility: "UNLISTED" });
    expect(() => applyCourseManifest(db, withManifestHash({ courseRef: "course", version: 3, visibility: "LISTED",
      sections: [{ sectionRef: "section", visibility: "LISTED" }],
      lessons: [{ lessonRef: "lesson", sectionRef: "section", everPublished: true, visibility: "LISTED", freePreview: false }],
      operations: [] }))).toThrow("COURSE_COMMERCE_EDITORIAL_OWNED");
    expect(db.prepare("SELECT version,visibility FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ version: 2, visibility: "UNLISTED" });
  });

  it("unlists without applying pending edits and withdraws product and projection in one commit", () => {
    save(); publish();
    save(document({ title: "Pending edit" }), 1);
    const unlist = restrictEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 1,
      idempotencyKey: "unlist", actor: "admin" });
    expect(unlist).toMatchObject({ version: 2, visibility: "UNLISTED" });
    expect(db.prepare("SELECT title,visibility FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ title: "Course", visibility: "UNLISTED" });
    expect(restrictEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 1,
      idempotencyKey: "unlist", actor: "admin" }).replayed).toBe(true);
    const withdrawal = { productRef: "course:course", expectedProductVersion: 1, reason: "Rights ended", termsRef: "terms-v1" };
    expect(() => restrictEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 2,
      idempotencyKey: "withdraw", actor: "admin", withdrawal: { ...withdrawal, expectedProductVersion: 0 } }))
      .toThrow("CATALOG_VERSION_CONFLICT");
    expect(db.prepare("SELECT version FROM catalog_course_projection WHERE course_ref='course'").get()).toEqual({ version: 2 });
    expect(db.prepare("SELECT withdrawn_at FROM products WHERE course_ref='course'").get()).toEqual({ withdrawn_at: null });
    const result = restrictEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 2,
      idempotencyKey: "withdraw", actor: "admin", withdrawal });
    expect(result.version).toBe(3);
    expect(db.prepare("SELECT withdrawn_at IS NOT NULL withdrawn FROM products WHERE course_ref='course'").get())
      .toEqual({ withdrawn: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM course_editorial_versions WHERE course_ref='course'").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT editorial_restriction FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ editorial_restriction: "WITHDRAWN" });
    expect(() => relistEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 3,
      idempotencyKey: "relist-after-withdraw", reason: "Rights restored", actor: "admin" })).toThrow("EMERGENCY_UNLIST_REQUIRED");
    assertVersionDigests();
  });

  it("keeps emergency unlist across an ordinary edit until an explicit audited relist", () => {
    save(); publish();
    restrictEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 1, idempotencyKey: "unlist", actor: "admin" });
    save(document({ title: "Edited while held" }), 1);
    expect(publish(2, 2, "edit-while-held")).toMatchObject({ version: 3, visibility: "UNLISTED" });
    expect(db.prepare(`SELECT title,visibility,editorial_requested_visibility,editorial_restriction
      FROM catalog_course_projection WHERE course_ref='course'`).get()).toEqual({
      title: "Edited while held", visibility: "UNLISTED", editorial_requested_visibility: "LISTED",
      editorial_restriction: "EMERGENCY_UNLIST",
    });
    expect(() => db.prepare("UPDATE catalog_course_projection SET visibility='LISTED' WHERE course_ref='course'").run())
      .toThrow("EDITORIAL_VISIBILITY_INCONSISTENT");
    expect(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='COURSE_EDITORIAL_RELISTED'").get()).toEqual({ n: 0 });
    expect(() => relistEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 2,
      idempotencyKey: "relist-stale", reason: "Reviewed", actor: "admin" })).toThrow("PUBLISHED_VERSION_CONFLICT");
    const relist = { courseRef: "course", expectedPublishedVersion: 3, idempotencyKey: "relist-4",
      reason: "Owner reviewed access", actor: "admin" };
    expect(relistEditorialCourse(db, relist)).toMatchObject({ version: 4, visibility: "LISTED", replayed: false });
    expect(relistEditorialCourse(db, relist)).toMatchObject({ version: 4, replayed: true });
    expect(db.prepare("SELECT visibility,editorial_restriction FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ visibility: "LISTED", editorial_restriction: "NONE" });
    expect(db.prepare("SELECT evidence_json FROM audit_log WHERE action='COURSE_EDITORIAL_RELISTED'").all())
      .toEqual([{ evidence_json: expect.stringContaining("Owner reviewed access") }]);
    expect(assertVersionDigests()).toHaveLength(4);
  });

  it("will not relist an emergency-held course whose editorial intent is unlisted", () => {
    save(); publish();
    restrictEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 1, idempotencyKey: "unlist", actor: "admin" });
    save(document({ visibility: "UNLISTED" }), 1);
    publish(2, 2, "publish-unlisted");
    expect(() => relistEditorialCourse(db, { courseRef: "course", expectedPublishedVersion: 3,
      idempotencyKey: "relist", reason: "Mistaken request", actor: "admin" })).toThrow("EDITORIAL_VISIBILITY_NOT_LISTED");
    expect(db.prepare("SELECT visibility,editorial_restriction FROM catalog_course_projection WHERE course_ref='course'").get())
      .toEqual({ visibility: "UNLISTED", editorial_restriction: "EMERGENCY_UNLIST" });
    assertVersionDigests();
  });
});
