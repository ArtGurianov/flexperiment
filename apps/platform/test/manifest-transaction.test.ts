import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalReq, getPayload, type Payload } from "payload";
import { rm } from "node:fs/promises";
import { listPublicCourses } from "../lib/content/editorial";

const databasePath = `/private/tmp/flexperiment-platform-test-${process.pid}.sqlite`;
const mediaPath = `/private/tmp/flexperiment-platform-media-${process.pid}`;
let payload: Payload;
let courseId: number | string;
let initialJobCount: number;

beforeAll(async () => {
  process.env.PAYLOAD_SECRET = "manifest-transaction-test-secret";
  process.env.PAYLOAD_DATABASE_URL = `file:${databasePath}`;
  process.env.PLATFORM_COMMERCE_SERVICE_TOKEN = "test-token";
  process.env.PAYLOAD_JOBS_ENABLED = "false";
  process.env.PAYLOAD_MEDIA_DIR = mediaPath;
  const { default: config } = await import("../payload.config");
  payload = await getPayload({ config });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const media = await payload.create({
    collection: "media",
    data: { alt: "Test" },
    file: { data: png, mimetype: "image/png", name: "test.png", size: png.length },
    overrideAccess: true,
  });
  const course = await payload.create({
    collection: "courses",
    data: {
      courseRef: "course:transaction-test",
      title: "Transaction test",
      slug: "transaction-test",
      summary: "Transaction test",
      hero: media.id,
      visibility: "listed",
      _status: "published",
    },
    draft: false,
    overrideAccess: true,
  });
  courseId = course.id;
  initialJobCount = await payload.count({ collection: "payload-jobs", overrideAccess: true }).then(({ totalDocs }) => totalDocs);
});

afterAll(async () => {
  await payload.destroy();
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(mediaPath, { force: true, recursive: true }),
  ]);
});

describe("Payload manifest transaction", () => {
  it("rolls back editorial data, the access operation and the queued job together", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ state: "PENDING", enforced: true }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    const req = await createLocalReq({ context: { __lmsForceThrowAfterQueue: true } }, payload);

    await expect(payload.update({
      collection: "courses",
      id: courseId,
      data: { visibility: "unlisted", _status: "published" },
      draft: false,
      overrideAccess: true,
      req,
    })).rejects.toThrow("FORCED_THROW_AFTER_MANIFEST_ENQUEUE");

    const course = await payload.findByID({ collection: "courses", id: courseId, draft: false, overrideAccess: true });
    const operations = await payload.count({ collection: "access-operations", overrideAccess: true });
    const jobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    expect(course.visibility).toBe("listed");
    expect(course.manifestVersion).toBe(1);
    expect(operations.totalDocs).toBe(0);
    expect(jobs.totalDocs).toBe(initialJobCount);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it("fails a restrictive publication before commit when commerce cannot acknowledge the override", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ code: "COMMERCE_UNAVAILABLE" }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    const before = await payload.findByID({ collection: "courses", id: courseId, draft: false, overrideAccess: true });
    const beforeOperations = await payload.count({ collection: "access-operations", overrideAccess: true });
    const beforeJobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    const req = await createLocalReq({}, payload);

    await expect(payload.update({
      collection: "courses",
      id: courseId,
      data: { visibility: "unlisted", _status: "published" },
      draft: false,
      overrideAccess: true,
      req,
    })).rejects.toThrow("COMMERCE_UNAVAILABLE");

    const published = await payload.findByID({ collection: "courses", id: courseId, draft: false, overrideAccess: true });
    const operations = await payload.count({ collection: "access-operations", overrideAccess: true });
    const jobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    expect(published.visibility).toBe(before.visibility);
    expect(published.manifestVersion).toBe(before.manifestVersion);
    expect(operations.totalDocs).toBe(beforeOperations.totalDocs);
    expect(jobs.totalDocs).toBe(beforeJobs.totalDocs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it("keeps a restrictive draft isolated from the published manifest", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const req = await createLocalReq({}, payload);

    const draft = await payload.update({
      collection: "courses",
      id: courseId,
      data: { visibility: "unlisted" },
      draft: true,
      overrideAccess: true,
      req,
    });

    const published = await payload.findByID({ collection: "courses", id: courseId, draft: false, overrideAccess: true });
    const operations = await payload.count({ collection: "access-operations", overrideAccess: true });
    const jobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    expect(draft._status).toBe("draft");
    expect(draft.visibility).toBe("unlisted");
    expect(published._status).toBe("published");
    expect(published.visibility).toBe("listed");
    expect(published.manifestVersion).toBe(1);
    expect((await listPublicCourses(payload)).map(({ courseRef }) => courseRef)).toContain("course:transaction-test");
    expect(operations.totalDocs).toBe(0);
    expect(jobs.totalDocs).toBe(initialJobCount);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("serializes concurrent publications into distinct committed manifest versions", async () => {
    const before = await payload.findByID({ collection: "courses", id: courseId, draft: false, overrideAccess: true });
    const beforeJobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    const [firstReq, secondReq] = await Promise.all([createLocalReq({}, payload), createLocalReq({}, payload)]);

    await Promise.all([
      payload.update({
        collection: "courses", id: courseId, data: { title: "Concurrent title", visibility: "listed", _status: "published" },
        draft: false, overrideAccess: true, req: firstReq,
      }),
      payload.update({
        collection: "courses", id: courseId, data: { summary: "Concurrent summary", visibility: "listed", _status: "published" },
        draft: false, overrideAccess: true, req: secondReq,
      }),
    ]);

    const published = await payload.findByID({ collection: "courses", id: courseId, draft: false, overrideAccess: true });
    const jobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    expect(published.manifestVersion).toBe(Number(before.manifestVersion) + 2);
    expect(jobs.totalDocs).toBe(beforeJobs.totalDocs + 2);
  });

  it("removes an effectively unlisted publication from the public Local API contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ state: "PENDING", enforced: true }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    const req = await createLocalReq({}, payload);

    await payload.update({
      collection: "courses",
      id: courseId,
      data: { visibility: "unlisted", _status: "published" },
      draft: false,
      overrideAccess: true,
      req,
    });

    const publicCourses = await listPublicCourses(payload);
    expect(publicCourses.map(({ courseRef }) => courseRef)).not.toContain("course:transaction-test");
    expect(JSON.stringify(publicCourses)).not.toMatch(/manifestVersion|everPublished|operationId|videoId|secret/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });
});
