import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalReq, getPayload, type Payload } from "payload";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPublicCourses } from "../lib/content/editorial";
import { closedEditorial, closedEmail } from "../lib/canary-editorial";
import type { Lesson, User } from "../payload-types";
import { buildCourseManifest } from "../lib/manifest/build";
import type { EditorialDocument } from "../lib/content/editorial";

let payload: Payload;
let directory: string;
let author: User;
let savedLesson: Lesson;
const environment = { ...process.env };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "editorial-authoring-"));
  process.env.PAYLOAD_SECRET = "isolated-stage-a-preparation-not-a-runtime-key";
  process.env.PAYLOAD_DATABASE_URL = `file:${join(directory, "editorial.sqlite")}`;
  process.env.PAYLOAD_MEDIA_DIR = join(directory, "media");
  process.env.PAYLOAD_JOBS_ENABLED = "false";
  delete process.env.PLATFORM_V2_CANARY;
  delete process.env.S3_BUCKET;
  process.env.DEPLOY_ENV = "staging";
  const { default: config } = await import("../payload.config");
  const resolved = await config;
  // Isolated normal editorial schema, never live closed canary. No cron in the test process.
  payload = await getPayload({ config: { ...resolved, email: closedEmail, jobs: { ...resolved.jobs, autoRun: [] } } });
  await payload.create({ collection: "users", overrideAccess: false, data: {
    email: "stage-a-author@example.test", password: "isolated-test-password-only",
  } });
  const login = await payload.login({ collection: "users", data: {
    email: "stage-a-author@example.test", password: "isolated-test-password-only",
  } });
  if (!login.user) throw new Error("ISOLATED_AUTHOR_LOGIN_FAILED");
  author = login.user;
});

afterAll(async () => {
  if (payload) await payload.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
  process.env = environment;
});

const request = () => createLocalReq({ user: author }, payload);
// Disposable test data through the ordinary author APIs, never a launch/import helper.
const createDraftTree = async (slug: string, lessonCount: number) => {
  const req = await request();
  const transactionID = await payload.db.beginTransaction();
  if (transactionID == null) throw new Error("ISOLATED_TRANSACTION_REQUIRED");
  req.transactionID = transactionID;
  try {
    const course = await payload.create({ collection: "courses", draft: true, depth: 0, overrideAccess: false, req,
      data: { title: `Synthetic ${slug}`, slug, summary: "Isolated test content", visibility: "unlisted", _status: "draft" } });
    const section = await payload.create({ collection: "sections", draft: true, depth: 0, overrideAccess: false, req,
      data: { course: course.id, title: `Section ${slug}`, position: 0, visibility: "unlisted", _status: "draft" } });
    const lessons = [];
    for (let position = 0; position < lessonCount; position += 1) {
      lessons.push(await payload.create({ collection: "lessons", draft: true, depth: 0, overrideAccess: false, req,
        data: { course: course.id, section: section.id, title: `Lesson ${position}`, slug: `${slug}-${position}`,
          position, freePreview: false, visibility: "unlisted", _status: "draft" } }));
    }
    await payload.db.commitTransaction(transactionID);
    return { course, section, lessons };
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID);
    throw error;
  } finally { delete req.transactionID; }
};
const counts = async () => Promise.all(["courses", "sections", "lessons", "payload-jobs", "course-manifest-states", "access-operations"].map(
  (collection) => payload.count({ collection: collection as "courses", overrideAccess: true }).then((value) => value.totalDocs),
));

describe("ordinary editorial authoring on actual isolated Payload SQLite", () => {
  it("refuses unauthenticated course authoring before any write", async () => {
    const before = await counts();
    await expect(payload.create({ collection: "courses", draft: true, overrideAccess: false, req: await createLocalReq({}, payload),
      data: { title: "Guest content", slug: "guest-content", summary: "Synthetic", _status: "draft" } })).rejects.toThrow();
    expect(await counts()).toEqual(before);
  });

  it("does not bypass the existing live canary closed-editorial hook", async () => {
    const before = await counts();
    const collection = payload.collections.courses.config;
    const originalHooks = collection.hooks;
    const closed = closedEditorial(collection);
    collection.hooks = { ...originalHooks, beforeChange: closed.hooks!.beforeChange! };
    try {
      await expect(createDraftTree("closed-content", 2)).rejects.toThrow("PLATFORM_CANARY_EDITORIAL_CLOSED");
    } finally { collection.hooks = originalHooks; }
    expect(await counts()).toEqual(before);
  });

  it("rolls back course, section and preceding lessons on a real late hook failure", async () => {
    const before = await counts();
    const hooks = payload.collections.lessons.config.hooks!;
    const original = hooks.beforeChange;
    hooks.beforeChange = [...(original ?? []), ({ data }) => {
      if (data.slug === "rollback-content-1") throw new Error("ISOLATED_LATE_LESSON_FAILURE");
      return data;
    }];
    try {
      await expect(createDraftTree("rollback-content", 3)).rejects.toThrow("ISOLATED_LATE_LESSON_FAILURE");
    } finally { hooks.beforeChange = original; }
    expect(await counts()).toEqual(before);
  });

  it.each([["arbitrary-alpha", 2], ["arbitrary-beta", 3]] as const)("authors %s with %s lessons and dynamic refs, without external I/O", async (slug, lessonCount) => {
    const before = await counts();
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("EXTERNAL_IO_FORBIDDEN"));
    try {
      const result = await createDraftTree(slug, lessonCount);
      const { course, section, lessons } = result;
      expect(course.title).toBe(`Synthetic ${slug}`);
      expect(course.hero).toBeFalsy();
      expect(section.course).toBe(course.id);
      expect(lessons).toHaveLength(lessonCount);
      const refs = [course.courseRef, section.sectionRef, ...lessons.map((lesson) => lesson.lessonRef)];
      expect(new Set(refs).size).toBe(lessonCount + 2);
      for (const ref of refs) expect(ref).toMatch(/^[a-f0-9-]{36}$/);
      for (const [index, lesson] of lessons.entries()) {
        expect(lesson.course).toBe(course.id);
        expect(lesson.section).toBe(section.id);
        expect(lesson.position).toBe(index);
        expect(lesson.title).toBe(`Lesson ${index}`);
        expect(lesson.durationSeconds).toBeFalsy();
        expect(lesson).not.toHaveProperty("videoRef");
        expect(lesson.freePreview).toBe(false);
      }
      for (const record of [course, section, ...lessons]) {
        expect(record._status).toBe("draft");
        expect(record.visibility).toBe("unlisted");
        expect(record.everPublished).toBe(false);
      }
      expect(await counts()).toEqual([before[0] + 1, before[1] + 1, before[2] + lessonCount, ...before.slice(3)]);
      savedLesson = lessons[0];
      await expect(buildCourseManifest(payload, course as unknown as EditorialDocument)).rejects.toThrow("COURSE_NOT_PUBLISHED");
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("keeps drafts invisible through the actual public editorial query", async () => {
    expect(await listPublicCourses(payload)).toEqual([]);
  });

  it("preserves immutable refs through a real collection hook", async () => {
    await expect(payload.update({ collection: "lessons", id: savedLesson.id, draft: true,
      overrideAccess: false, req: await request(), data: { lessonRef: "not-the-created-ref" },
    })).rejects.toThrow("LESSONREF_IMMUTABLE");
    const saved = await payload.findByID({ collection: "lessons", id: savedLesson.id, overrideAccess: true });
    expect(saved.lessonRef).toBe(savedLesson.lessonRef);
  });
});
