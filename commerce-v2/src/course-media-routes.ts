import { timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type Database from "better-sqlite3";
import { admitCourseImage, CourseMediaError, COURSE_MEDIA_LIMITS, courseMediaSourceKey } from "./course-media";
import {
  activateCourseMedia, claimCourseMediaJob, completeCourseMediaJob, getCourseMediaAsset, registerCourseMediaUpload,
  type CourseMediaResult,
} from "./course-media-store";
import type { ObjectStore } from "./course-media-worker";

export type CourseMediaRouteDeps = {
  readonly db: Database.Database;
  /** Private staging bucket for owner sources; absent while FLEX-63 is not configured. */
  readonly sourceStore?: ObjectStore;
  /** Dedicated worker credential, distinct from the platform service token. */
  readonly workerToken?: string;
  readonly now?: () => Date;
};

const noStore = { "Cache-Control": "no-store" };
type Bindings = { Variables: { controlRoomAdminId?: string } };

const tokenMatches = (presented: string, expected: string) => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

const failure = (context: Context, error: unknown) => {
  if (error instanceof CourseMediaError) {
    const status = error.code === "MEDIA_TOO_LARGE" ? 413
      : error.code === "MEDIA_TYPE_UNSUPPORTED" || error.code === "MEDIA_TYPE_MISMATCH" ? 415 : 422;
    return context.json({ error: { code: error.code } }, status, noStore);
  }
  throw error;
};

/**
 * Registers FLEX-63 routes. Admin routes sit under /v1/admin/*, so the existing Control Room session
 * middleware (registered first in app.ts) authenticates them; there is no second CMS login. Worker
 * routes accept only the worker token and can do nothing except claim and complete media jobs.
 */
export function registerCourseMediaRoutes<E extends Bindings>(app: Hono<E>, deps: CourseMediaRouteDeps) {
  const now = deps.now ?? (() => new Date());

  app.post("/v1/admin/v2/courses/:courseRef/media",
    bodyLimit({ maxSize: COURSE_MEDIA_LIMITS.maxBytes,
      onError: (context) => context.json({ error: { code: "MEDIA_TOO_LARGE" } }, 413, noStore) }),
    async (context) => {
      if (!deps.sourceStore) return context.json({ error: { code: "COURSE_MEDIA_NOT_CONFIGURED" } }, 503, noStore);
      try {
        const courseRef = context.req.param("courseRef");
        const exists = deps.db.prepare("SELECT 1 FROM catalog_course_projection WHERE course_ref=?").get(courseRef)
          ?? deps.db.prepare("SELECT 1 FROM course_editorial_drafts WHERE course_ref=?").get(courseRef);
        if (!exists) return context.json({ error: { code: "COURSE_NOT_FOUND" } }, 404, noStore);
        let alt: string | undefined;
        try { alt = decodeURIComponent(context.req.header("x-media-alt") ?? ""); } catch { alt = undefined; }
        const bytes = new Uint8Array(await context.req.arrayBuffer());
        const image = admitCourseImage({ courseRef, declaredMime: context.req.header("content-type"), alt, bytes });
        // Source first: a crash after this leaves an unreferenced object for orphan cleanup, never a row
        // pointing at missing bytes. The key is content-addressed, so a retry rewrites the same object.
        await deps.sourceStore.put(courseMediaSourceKey(courseRef, image.sourceSha256), bytes, image.mime);
        const result = registerCourseMediaUpload(deps.db, image, context.get("controlRoomAdminId")!, now().toISOString());
        return context.json({ asset: result.asset, replayed: result.replayed }, result.replayed ? 200 : 202, noStore);
      } catch (error) { return failure(context, error); }
    });

  app.get("/v1/admin/v2/course-media/:assetId", (context) => {
    const asset = getCourseMediaAsset(deps.db, context.req.param("assetId"));
    return asset ? context.json({ asset }, 200, noStore) : context.json({ error: { code: "NOT_FOUND" } }, 404, noStore);
  });

  app.post("/v1/admin/v2/course-media/:assetId/activate", (context) => {
    try {
      const asset = activateCourseMedia(deps.db, context.req.param("assetId"), context.get("controlRoomAdminId")!, now().toISOString());
      return context.json({ asset }, 200, noStore);
    } catch (error) {
      if (error instanceof CourseMediaError) return context.json({ error: { code: "MEDIA_NOT_READY" } }, 409, noStore);
      throw error;
    }
  });

  app.use("/v1/course-media-worker/*", async (context, next) => {
    const presented = context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!deps.workerToken) return context.json({ error: { code: "COURSE_MEDIA_NOT_CONFIGURED" } }, 503, noStore);
    if (!presented || !tokenMatches(presented, deps.workerToken)) return context.json({ error: { code: "UNAUTHORIZED" } }, 401, noStore);
    await next();
  });

  app.post("/v1/course-media-worker/claim", (context) =>
    context.json({ job: claimCourseMediaJob(deps.db, undefined, now()) }, 200, noStore));

  app.post("/v1/course-media-worker/:assetId/complete", bodyLimit({ maxSize: 16_384 }), async (context) => {
    try {
      const body = await context.req.json<{ leaseToken?: unknown; result?: CourseMediaResult }>();
      if (typeof body.leaseToken !== "string" || !body.result) throw new CourseMediaError("MEDIA_VARIANTS_INVALID");
      const result = completeCourseMediaJob(deps.db, context.req.param("assetId"), body.leaseToken, body.result, now().toISOString());
      return context.json({ state: result.asset.state, replayed: result.replayed }, 200, noStore);
    } catch (error) {
      if (error instanceof CourseMediaError) return context.json({ error: { code: "MEDIA_RESULT_REJECTED" } }, 409, noStore);
      if (error instanceof SyntaxError) return context.json({ error: { code: "MEDIA_RESULT_REJECTED" } }, 400, noStore);
      throw error;
    }
  });
}
