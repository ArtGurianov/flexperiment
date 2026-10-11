import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalReq, getPayload, type Payload } from "payload";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flexing101Proposal, prepareFlexing101Draft } from "../lib/launch/flexing101";
import { listPublicCourses } from "../lib/content/editorial";
import { closedEditorial, closedEmail } from "../lib/canary-editorial";
import type { User } from "../payload-types";
import { buildCourseManifest } from "../lib/manifest/build";
import type { EditorialDocument } from "../lib/content/editorial";

let payload: Payload;
let directory: string;
let author: User;
let result: Awaited<ReturnType<typeof prepareFlexing101Draft>>;
const environment = { ...process.env };

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "flexing101-preparation-"));
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
const counts = async () => Promise.all(["courses", "sections", "lessons", "payload-jobs", "course-manifest-states", "access-operations"].map(
  (collection) => payload.count({ collection: collection as "courses", overrideAccess: true }).then((value) => value.totalDocs),
));

describe("Flexing 101 draft preparation on actual Payload SQLite", () => {
  it("refuses unauthenticated preparation before any write", async () => {
    const before = await counts();
    await expect(prepareFlexing101Draft(await createLocalReq({}, payload))).rejects.toThrow("EDITORIAL_AUTHOR_REQUIRED");
    expect(await counts()).toEqual(before);
  });

  it("refuses production even with an authenticated author", async () => {
    const before = await counts();
    process.env.DEPLOY_ENV = "production";
    try {
      await expect(prepareFlexing101Draft(await request())).rejects.toThrow("DRAFT_PREPARATION_PRODUCTION_FORBIDDEN");
    } finally { process.env.DEPLOY_ENV = "staging"; }
    expect(await counts()).toEqual(before);
  });

  it("does not bypass the existing live canary closed-editorial hook", async () => {
    const before = await counts();
    const collection = payload.collections.courses.config;
    const originalHooks = collection.hooks;
    const closed = closedEditorial(collection);
    collection.hooks = { ...originalHooks, beforeChange: closed.hooks!.beforeChange! };
    try {
      await expect(prepareFlexing101Draft(await request())).rejects.toThrow("PLATFORM_CANARY_EDITORIAL_CLOSED");
    } finally { collection.hooks = originalHooks; }
    expect(await counts()).toEqual(before);
  });

  it("rolls back course, section and preceding lessons on a real late hook failure", async () => {
    const before = await counts();
    const hooks = payload.collections.lessons.config.hooks!;
    const original = hooks.beforeChange;
    hooks.beforeChange = [...(original ?? []), ({ data }) => {
      if (data.slug === "practice-combination") throw new Error("ISOLATED_LATE_LESSON_FAILURE");
      return data;
    }];
    try {
      await expect(prepareFlexing101Draft(await request())).rejects.toThrow("ISOLATED_LATE_LESSON_FAILURE");
    } finally { hooks.beforeChange = original; }
    expect(await counts()).toEqual(before);
  });

  it("creates genuine draft refs/relations without videos, offers, manifest or external I/O", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("EXTERNAL_IO_FORBIDDEN"));
    try {
      result = await prepareFlexing101Draft(await request());
      const { course, section, lessons } = result;
      expect(course.title).toBe("Flexing 101");
      expect(course.hero).toBeFalsy();
      expect(section.course).toBe(course.id);
      expect(lessons).toHaveLength(4);
      const refs = [course.courseRef, section.sectionRef, ...lessons.map((lesson) => lesson.lessonRef)];
      expect(new Set(refs).size).toBe(6);
      for (const ref of refs) expect(ref).toMatch(/^[a-f0-9-]{36}$/);
      for (const [index, lesson] of lessons.entries()) {
        expect(lesson.course).toBe(course.id);
        expect(lesson.section).toBe(section.id);
        expect(lesson.position).toBe(index);
        expect(lesson.title).toBe(flexing101Proposal.lessons[index].title);
        expect(lesson.durationSeconds).toBeFalsy();
        expect(lesson).not.toHaveProperty("videoRef");
        expect(lesson.freePreview).toBe(false);
      }
      for (const record of [course, section, ...lessons]) {
        expect(record._status).toBe("draft");
        expect(record.visibility).toBe("unlisted");
        expect(record.everPublished).toBe(false);
      }
      expect(await counts()).toEqual([1, 1, 4, 0, 0, 0]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

  it("keeps the proposal separate from factual video metadata and paid catalogue", () => {
    expect(flexing101Proposal.lessons.reduce((minutes, lesson) => minutes + lesson.proposedMinutes, 0)).toBe(20);
    expect(flexing101Proposal.priceMinor).toBe(0);
    expect(flexing101Proposal.accessModel).toBe("FREE");
    expect(flexing101Proposal.status).toBe("DRAFT_OWNER_REVIEW");
    expect(flexing101Proposal).not.toHaveProperty("courseRef");
    expect(flexing101Proposal).not.toHaveProperty("videoRef");
  });

  it("keeps drafts invisible through the actual public editorial query", async () => {
    expect(await listPublicCourses(payload)).toEqual([]);
  });

  it("refuses duplicate import without modifying existing draft identities", async () => {
    const before = await counts();
    await expect(prepareFlexing101Draft(await request())).rejects.toThrow("FLEXING101_ALREADY_EXISTS");
    expect(await counts()).toEqual(before);
    const saved = await payload.findByID({ collection: "courses", id: result.course.id, overrideAccess: true });
    expect(saved.courseRef).toBe(result.course.courseRef);
  });

  it("preserves immutable refs through a real collection hook", async () => {
    await expect(payload.update({ collection: "lessons", id: result.lessons[0].id, draft: true,
      overrideAccess: false, req: await request(), data: { lessonRef: "not-the-created-ref" },
    })).rejects.toThrow("LESSONREF_IMMUTABLE");
  });

  it("cannot enter the existing publication pipeline as a draft", async () => {
    await expect(buildCourseManifest(payload, result.course as unknown as EditorialDocument)).rejects.toThrow("COURSE_NOT_PUBLISHED");
    expect((await counts()).slice(3)).toEqual([0, 0, 0]);
  });
});
