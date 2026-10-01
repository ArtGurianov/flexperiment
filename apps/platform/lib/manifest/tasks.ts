import type { PayloadRequest, TaskConfig } from "payload";
import { buildCourseManifest } from "./build";
import { listPendingCommerceOverrides, pushCourseManifest, releaseRolledBackOverride } from "./commerce-client";
import { getCourseManifestState, getPublishedDocument, hasCommittedAccessOperation, listPublishedCourses } from "@/lib/content/editorial";
import { getPlatformEpoch, operationIsInFlight } from "./in-flight";
import { invalidatePlatformCache, notifyIndexNow } from "@/lib/cache-invalidation";

type SyncInputOutput = { input: { courseId: string }; output: { courseRef: string; version: number } };
type ReconcileInputOutput = { input: Record<string, never>; output: { queued: number; released: number } };

async function markAcknowledged(req: PayloadRequest, operationIds: readonly string[]) {
  if (operationIds.length === 0) return;
  await req.payload.update({
    collection: "access-operations",
    data: { state: "ACKED", acknowledgedAt: new Date().toISOString() },
    depth: 0,
    overrideAccess: true,
    req,
    where: { operationId: { in: [...operationIds] } },
  });
}

export const syncCourseManifestTask: TaskConfig<SyncInputOutput> = {
  slug: "syncCourseManifest",
  label: "Sync a committed course manifest",
  inputSchema: [{ name: "courseId", type: "text", required: true }],
  outputSchema: [
    { name: "courseRef", type: "text", required: true },
    { name: "version", type: "number", required: true },
  ],
  retries: { attempts: 20, backoff: { type: "exponential", delay: 5_000 } },
  handler: async ({ input, req }) => {
    const course = await getPublishedDocument(req, "courses", input.courseId);
    if (!course) throw new Error("PUBLISHED_COURSE_NOT_FOUND");
    const manifest = await buildCourseManifest(req.payload, course, req);
    const ack = await pushCourseManifest(manifest);
    // Side effects belong to a committed version, not to a push: the reconciler re-pushes every
    // course every few minutes, and an unchanged course must not churn the cache or IndexNow. A
    // version whose invalidation failed is retried with its operations still unacknowledged, so
    // the retry keeps the immediate expiry a restriction needs.
    const state = await getCourseManifestState(req.payload, manifest.courseRef, req);
    if (state && Number(state.invalidatedVersion ?? 0) < manifest.version) {
      const slug = typeof course.slug === "string" ? course.slug : undefined;
      await invalidatePlatformCache(manifest.operations.length > 0 ? "immediate" : "swr", slug);
      await notifyIndexNow(["/courses", "/search-index.json", "/sitemap.xml", ...(slug ? [`/courses/${slug}`] : [])]);
      await req.payload.update({
        collection: "course-manifest-states",
        id: state.id,
        data: { invalidatedVersion: manifest.version },
        depth: 0,
        overrideAccess: true,
        req,
      });
    }
    await markAcknowledged(req, [...ack.finalized, ...ack.superseded, ...ack.lateCommitted]);
    return { output: { courseRef: manifest.courseRef, version: manifest.version } };
  },
};

export const reconcileCourseManifestsTask: TaskConfig<ReconcileInputOutput> = {
  slug: "reconcileCourseManifests",
  label: "Reconcile every committed course manifest",
  schedule: [{ cron: "*/5 * * * *", queue: "default" }],
  inputSchema: [],
  outputSchema: [
    { name: "queued", type: "number", required: true },
    { name: "released", type: "number", required: true },
  ],
  retries: 3,
  handler: async ({ req }) => {
    const courses = await listPublishedCourses(req.payload, req);
    for (const course of courses) {
      await req.payload.jobs.queue({
        task: "syncCourseManifest" as never,
        input: { courseId: String(course.id) } as never,
        queue: "default",
        req,
      });
    }
    let released = 0;
    const checkedAt = new Date().toISOString();
    for (const override of await listPendingCommerceOverrides()) {
      const committedRecordExists = await hasCommittedAccessOperation(req.payload, override.operationId, req);
      const operationInFlight = operationIsInFlight(override.operationId);
      const transactionEnded = override.platformEpoch !== getPlatformEpoch() || !operationInFlight;
      if (committedRecordExists || operationInFlight || Date.parse(checkedAt) < Date.parse(override.deadlineAt)) continue;
      await releaseRolledBackOverride(override.operationId, {
        checkedAt,
        currentPlatformEpoch: getPlatformEpoch(),
        committedRecordExists,
        operationInFlight,
        transactionEnded,
      });
      released += 1;
    }
    return { output: { queued: courses.length, released } };
  },
};
