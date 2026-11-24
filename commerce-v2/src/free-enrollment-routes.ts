import { accountSessionScope, type AccountSessionScope } from "./shared-account-routes";
import type Database from "better-sqlite3";
import type { Env, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { enrollInFreeCourse, freeEnrollmentStatus, FreeEnrollmentRefusal, type FreeEnrollmentRefusalCode } from "./free-enrollment";

const noStore = { "Cache-Control": "no-store" };
const privateNoStore = { "Cache-Control": "private, no-store" };
const STATUS: Record<FreeEnrollmentRefusalCode, 403 | 404 | 409 | 422> = {
  COURSE_SLUG_INVALID: 422, LESSON_SLUG_INVALID: 422, COURSE_NOT_FOUND: 404, LESSON_NOT_FOUND: 404,
  VERIFIED_ACCOUNT_REQUIRED: 403, CONSENT_REQUIRED: 403, FREE_COURSE_REQUIRED: 409, COURSE_NOT_READY: 409,
};

/**
 * FLEX-128 Stage A: `POST /v1/me/free-enrollments` (explicit enrollment, same-origin LMS only) and
 * `GET /v1/me/free-enrollments/:courseSlug` (the account's enrollment status). Both answer only for
 * the session's own customer; no other subject can be named in a request.
 */
export function registerFreeEnrollmentRoutes<E extends Env>(app: Hono<E>, deps: {
  readonly db: Database.Database;
  readonly coursesOrigin: string;
  readonly now: () => Date;
  readonly authenticateCustomer?: (headers: Headers, scope?: AccountSessionScope) => Promise<string | null>;
}) {
  const refusal = (error: unknown) => error instanceof FreeEnrollmentRefusal
    ? { body: { code: error.code }, status: STATUS[error.code] } : undefined;

  app.get("/v1/me/free-enrollments/:courseSlug", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers, accountSessionScope(context)) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    try {
      const status = freeEnrollmentStatus(deps.db, customerId, context.req.param("courseSlug"));
      return status ? context.json(status, 200, privateNoStore) : context.json({ code: "COURSE_NOT_FOUND" }, 404, noStore);
    } catch (error) {
      const known = refusal(error);
      return known ? context.json(known.body, known.status, noStore) : context.json({ code: "FREE_ENROLLMENT_UNAVAILABLE" }, 503, noStore);
    }
  });

  app.post("/v1/me/free-enrollments", bodyLimit({ maxSize: 2048,
    onError: context => context.json({ code: "FREE_ENROLLMENT_INPUT_TOO_LARGE" }, 413, noStore) }), async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers, accountSessionScope(context)) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    // A cross-site page cannot enroll a signed-in visitor: only the LMS origin's own page can.
    if (context.req.header("origin") !== deps.coursesOrigin) return context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    let body: { courseSlug?: unknown; lessonSlug?: unknown };
    try {
      body = await context.req.json<typeof body>();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return context.json({ code: "FREE_ENROLLMENT_INPUT_INVALID" }, 422, noStore); }
    if (typeof body.courseSlug !== "string" || (body.lessonSlug !== undefined && typeof body.lessonSlug !== "string")) {
      return context.json({ code: "FREE_ENROLLMENT_INPUT_INVALID" }, 422, noStore);
    }
    try {
      const result = enrollInFreeCourse(deps.db, { customerId, courseSlug: body.courseSlug,
        ...(body.lessonSlug !== undefined ? { lessonSlug: body.lessonSlug } : {}) }, deps.now().toISOString());
      return context.json(result, result.created ? 201 : 200, noStore);
    } catch (error) {
      const known = refusal(error);
      if (known) return context.json(known.body, known.status, noStore);
      // The transaction rolled back: nothing was written. No SQL, stack or customer data in the log.
      try { console.error(JSON.stringify({ event: "FREE_ENROLLMENT_FAILURE", errorKind: error instanceof Error ? "ERROR" : "NON_ERROR" })); }
      catch { /* diagnostics never replace the sanitized response */ }
      return context.json({ code: "FREE_ENROLLMENT_UNAVAILABLE" }, 503, noStore);
    }
  });
}
