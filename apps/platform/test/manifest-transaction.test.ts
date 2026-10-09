import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalReq, getPayload, type Payload } from "payload";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPublicCourses } from "../lib/content/editorial";
import { operationIsInFlight, snapshotInFlight } from "../lib/manifest/in-flight";
import { syncCourseManifestTask } from "../lib/manifest/tasks";

// These editorial transaction fixtures have no commercial offers. The fresh commercial facts
// seam is qualified with real fetch responses in payment-purpose.test.ts; do not let a live
// commerce service or unrelated purpose admission hide manifest rollback/acknowledgment failures.
vi.mock("../lib/merchant-offer-facts", () => ({ freshPurposeSummary: vi.fn(async () => null) }));

const databasePath = join(tmpdir(), `flexperiment-platform-test-${process.pid}.sqlite`);
const mediaPath = join(tmpdir(), `flexperiment-platform-media-${process.pid}`);
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

const manifestVersion = async (courseRef = "course:transaction-test") => {
  const result = await payload.find({
    collection: "course-manifest-states", depth: 0, limit: 1, overrideAccess: true, pagination: false,
    where: { courseRef: { equals: courseRef } },
  });
  return result.docs[0]?.manifestVersion ?? 0;
};

afterAll(async () => {
  if (payload) await payload.destroy();
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
    expect(await manifestVersion()).toBe(1);
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
    const beforeVersion = await manifestVersion();
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
    expect(await manifestVersion()).toBe(beforeVersion);
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
    expect(await manifestVersion()).toBe(1);
    expect((await listPublicCourses(payload)).map(({ courseRef }) => courseRef)).toContain("course:transaction-test");
    expect(operations.totalDocs).toBe(0);
    expect(jobs.totalDocs).toBe(initialJobCount);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("serializes concurrent publications into distinct committed manifest versions", async () => {
    const beforeVersion = await manifestVersion();
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

    const jobs = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    expect(await manifestVersion()).toBe(beforeVersion + 2);
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

  it("converges a committed publication through the manifest job and live revalidation boundary", async () => {
    vi.stubEnv("PLATFORM_ORIGIN", "https://platform.test");
    vi.stubEnv("PLATFORM_REVALIDATE_TOKEN", "revalidation-token");
    vi.stubEnv("INDEXNOW_KEY", "");
    const requests: Array<{ body: unknown; url: string }> = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      requests.push({ body, url });
      if (url.endsWith("/v1/internal/course-manifests")) {
        const manifest = body as { operations: Array<{ operationId: string }> };
        return new Response(JSON.stringify({
          kind: "APPLIED",
          finalized: manifest.operations.map(({ operationId }) => operationId),
          superseded: [],
          lateCommitted: [],
          stillOpen: [],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://platform.test/internal/revalidate") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer revalidation-token");
        return new Response(JSON.stringify({ revalidated: true, mode: "immediate" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`UNEXPECTED_FETCH:${url}`);
    });

    try {
      const beforeVersion = await manifestVersion();
      const req = await createLocalReq({}, payload);
      const published = await payload.update({
        collection: "courses",
        id: courseId,
        data: { summary: "Converged summary", visibility: "unlisted", _status: "published" },
        draft: false,
        overrideAccess: true,
        req,
      });
      expect(published.summary).toBe("Converged summary");
      const committedVersion = await manifestVersion();
      expect(committedVersion).toBe(beforeVersion + 1);
      const pendingOperations = await payload.find({
        collection: "access-operations",
        limit: 10,
        overrideAccess: true,
        pagination: false,
        where: { state: { equals: "COMMITTED_UNACKED" } },
      });
      expect(pendingOperations.docs).toHaveLength(1);

      const jobs = await payload.find({
        collection: "payload-jobs",
        limit: 1,
        overrideAccess: true,
        pagination: false,
        sort: "-id",
        where: { taskSlug: { equals: "syncCourseManifest" } },
      });
      expect(jobs.docs).toHaveLength(1);
      await payload.jobs.runByID({ id: jobs.docs[0]!.id, overrideAccess: true, silent: true });

      const manifestRequest = requests.find(({ url }) => url.endsWith("/v1/internal/course-manifests"));
      expect(manifestRequest?.body).toMatchObject({
        courseRef: "course:transaction-test",
        version: committedVersion,
        visibility: "UNLISTED",
        operations: [{
          operationId: pendingOperations.docs[0]!.operationId,
          committedVersion: pendingOperations.docs[0]!.committedVersion,
        }],
      });
      expect(requests.find(({ url }) => url === "https://platform.test/internal/revalidate")?.body)
        .toEqual({ mode: "immediate", slug: "transaction-test" });
      const operations = await payload.find({
        collection: "access-operations",
        limit: 10,
        overrideAccess: true,
        pagination: false,
      });
      expect(operations.docs.map(({ state }) => state)).toEqual(["ACKED"]);
    } finally {
      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const overrideAccepted = () => json({ state: "PENDING", enforced: true }, 201);
const requestBody = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, unknown>;

async function publishedCourse(slug: string) {
  const media = await payload.find({ collection: "media", limit: 1, overrideAccess: true, pagination: false });
  return payload.create({
    collection: "courses",
    data: {
      courseRef: `course:${slug}`, title: slug, slug, summary: slug,
      hero: media.docs[0]!.id, visibility: "listed", _status: "published",
    },
    draft: false,
    overrideAccess: true,
  });
}

const operationsFor = async (courseRef: string) => (await payload.find({
  collection: "access-operations", limit: 10, overrideAccess: true, pagination: false,
  where: { courseRef: { equals: courseRef } },
})).docs;

describe("publication safety", () => {
  it("bumps the manifest for a child publication without publishing the course's open draft", async () => {
    const course = await publishedCourse("draft-isolation");
    await payload.update({
      collection: "courses", id: course.id, data: { title: "Unpublished draft title" }, draft: true, overrideAccess: true,
    });

    await payload.create({
      collection: "sections",
      data: { course: course.id, title: "Section", position: 0, visibility: "listed", _status: "published" },
      draft: false,
      overrideAccess: true,
    });

    const published = await payload.findByID({ collection: "courses", id: course.id, draft: false, overrideAccess: true });
    const latest = await payload.findByID({ collection: "courses", id: course.id, draft: true, overrideAccess: true });
    expect(published).toMatchObject({ _status: "published", title: "draft-isolation" });
    expect(latest).toMatchObject({ _status: "draft", title: "Unpublished draft title" });
    expect(await manifestVersion("course:draft-isolation")).toBe(2);
    const listed = (await listPublicCourses(payload)).find(({ courseRef }) => courseRef === "course:draft-isolation");
    expect(listed?.title).toBe("draft-isolation");
    expect(listed?.publicContentUpdatedAt).toEqual(expect.any(String));
  });

  it("runs field validation before any restrictive commerce call", async () => {
    const course = await publishedCourse("validate-first");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => overrideAccepted());
    try {
      await expect(payload.update({
        collection: "courses", id: course.id, data: { visibility: "unlisted", title: "", _status: "published" },
        draft: false, overrideAccess: true,
      })).rejects.toThrow(/title/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
    const published = await payload.findByID({ collection: "courses", id: course.id, draft: false, overrideAccess: true });
    expect(published.visibility).toBe("listed");
    expect(await operationsFor("course:validate-first")).toHaveLength(0);
  });

  it("clears the in-flight proof as soon as a Local API restrictive save commits", async () => {
    const course = await publishedCourse("local-cleanup");
    const inFlightDuringCall: boolean[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      inFlightDuringCall.push(operationIsInFlight(String(requestBody(init).operationId)));
      return overrideAccepted();
    });
    try {
      await payload.update({
        collection: "courses", id: course.id, data: { visibility: "unlisted", _status: "published" },
        draft: false, overrideAccess: true,
      });
    } finally {
      fetchMock.mockRestore();
    }
    const [operation] = await operationsFor("course:local-cleanup");
    expect(inFlightDuringCall).toEqual([true]);
    expect(operationIsInFlight(String(operation!.operationId))).toBe(false);
    expect(snapshotInFlight()).toEqual([]);
  });

  it("clears the in-flight proof as soon as a scheduled publish commits", async () => {
    const course = await publishedCourse("scheduled-cleanup");
    await payload.update({
      collection: "courses", id: course.id, data: { visibility: "unlisted" }, draft: true, overrideAccess: true,
    });
    const inFlightDuringCall: boolean[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      inFlightDuringCall.push(operationIsInFlight(String(requestBody(init).operationId)));
      return overrideAccepted();
    });
    try {
      const job = await payload.jobs.queue({
        task: "schedulePublish",
        input: { type: "publish", doc: { relationTo: "courses", value: String(course.id) } },
        waitUntil: new Date(Date.now() - 1_000),
      } as never) as { id: number | string };
      await payload.jobs.runByID({ id: job.id, overrideAccess: true, silent: true });
    } finally {
      fetchMock.mockRestore();
    }
    const published = await payload.findByID({ collection: "courses", id: course.id, draft: false, overrideAccess: true });
    const [operation] = await operationsFor("course:scheduled-cleanup");
    expect(published).toMatchObject({ _status: "published", visibility: "unlisted" });
    expect(inFlightDuringCall).toEqual([true]);
    expect(operationIsInFlight(String(operation!.operationId))).toBe(false);
    expect(snapshotInFlight()).toEqual([]);
  });

  it("kills a restrictive save past its hard lifetime and fails its later writes instead of autocommitting them", async () => {
    const course = await publishedCourse("hard-lifetime");
    const versionBefore = await manifestVersion("course:hard-lifetime");
    const jobsBefore = await payload.count({ collection: "payload-jobs", overrideAccess: true });
    vi.stubEnv("PLATFORM_SAVE_HARD_LIFETIME_MS", "200");
    let operationId = "";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      operationId = String(requestBody(init).operationId);
      // Commerce answers only after the platform has already killed the transaction.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return overrideAccepted();
    });
    try {
      await expect(payload.update({
        collection: "courses", id: course.id, data: { visibility: "unlisted", _status: "published" },
        draft: false, overrideAccess: true,
      })).rejects.toThrow("TRANSACTION_TERMINATED");
    } finally {
      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(operationId).not.toBe("");
    expect(operationIsInFlight(operationId)).toBe(false);
    const published = await payload.findByID({ collection: "courses", id: course.id, draft: false, overrideAccess: true });
    expect(published.visibility).toBe("listed");
    expect(await manifestVersion("course:hard-lifetime")).toBe(versionBefore);
    expect(await operationsFor("course:hard-lifetime")).toHaveLength(0);
    expect((await payload.count({ collection: "payload-jobs", overrideAccess: true })).totalDocs).toBe(jobsBefore.totalDocs);

    // The killed transaction released the writer: an ordinary save commits normally.
    await payload.update({
      collection: "courses", id: course.id, data: { summary: "After the kill", _status: "published" },
      draft: false, overrideAccess: true,
    });
    expect(await manifestVersion("course:hard-lifetime")).toBe(versionBefore + 1);
  });

  it("recovers a lost acknowledgement and keeps unchanged reconciles free of cache and IndexNow side effects", async () => {
    vi.stubEnv("PLATFORM_ORIGIN", "https://platform.test");
    vi.stubEnv("PLATFORM_REVALIDATE_TOKEN", "revalidation-token");
    vi.stubEnv("INDEXNOW_KEY", "indexnow-key");
    const course = await publishedCourse("ack-recovery");
    const manifestResponses: Array<(manifest: { operations: Array<{ operationId: string }> }) => Response> = [];
    const calls = { manifests: 0, revalidations: [] as unknown[], indexNow: 0 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/v1/internal/access-overrides")) return overrideAccepted();
      if (url.endsWith("/v1/internal/course-manifests")) {
        calls.manifests += 1;
        return manifestResponses.shift()!(requestBody(init) as never);
      }
      if (url === "https://platform.test/internal/revalidate") {
        calls.revalidations.push(requestBody(init));
        return json({ revalidated: true });
      }
      if (url === "https://api.indexnow.org/indexnow") {
        calls.indexNow += 1;
        return new Response(null, { status: 200 });
      }
      throw new Error(`UNEXPECTED_FETCH:${url}`);
    });
    const handler = syncCourseManifestTask.handler as (args: never) => Promise<unknown>;
    const sync = async () => handler({ input: { courseId: String(course.id) }, req: await createLocalReq({}, payload) } as never);

    try {
      await payload.update({
        collection: "courses", id: course.id, data: { visibility: "unlisted", _status: "published" },
        draft: false, overrideAccess: true,
      });
      const [operation] = await operationsFor("course:ack-recovery");

      // Commerce applied the manifest, but its acknowledgement never reached the platform.
      manifestResponses.push(() => json({ code: "UPSTREAM_RESET" }, 502));
      await expect(sync()).rejects.toThrow("UPSTREAM_RESET");
      expect((await operationsFor("course:ack-recovery"))[0]).toMatchObject({ state: "COMMITTED_UNACKED" });

      // The re-push is a no-op for commerce, which still reports the operation it resolved earlier.
      manifestResponses.push((manifest) => json({
        kind: "NO_OP", finalized: manifest.operations.map(({ operationId }) => operationId),
        superseded: [], lateCommitted: [], stillOpen: [],
      }));
      await sync();
      expect((await operationsFor("course:ack-recovery"))[0]).toMatchObject({ operationId: operation!.operationId, state: "ACKED" });
      // The committed version is invalidated once, immediately, because it carried a restriction.
      expect(calls.revalidations).toEqual([{ mode: "immediate", slug: "ack-recovery" }]);
      expect(calls.indexNow).toBe(1);

      // Unchanged reconciles touch neither the cache nor IndexNow.
      manifestResponses.push(() => json({ kind: "NO_OP", finalized: [], superseded: [], lateCommitted: [], stillOpen: [] }));
      manifestResponses.push(() => json({ kind: "NO_OP", finalized: [], superseded: [], lateCommitted: [], stillOpen: [] }));
      await sync();
      await sync();
      expect(calls.manifests).toBe(4);
      expect(calls.revalidations).toHaveLength(1);
      expect(calls.indexNow).toBe(1);
    } finally {
      fetchMock.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
