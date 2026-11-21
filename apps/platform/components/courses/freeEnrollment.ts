/**
 * FLEX-128 Stage A client contract for the explicit FREE enrollment (`/v1/me/free-enrollments`).
 * Kept route-agnostic so moving to the (experience) routes of #284 only changes the paths built here.
 */

export type EnrollmentFacts = { enrolledAt: string; startedAt: string | null; progressPercent: 0 };
export type FreeEnrollmentStatus = {
  courseRef: string; courseSlug: string; courseTitle: string; accessModel: "FREE" | "PAID";
  enrollment: (EnrollmentFacts & { courseRef: string; courseSlug: string }) | null; enrollable: boolean;
};
export type EnrollmentIntent = { courseSlug: string; lessonSlug?: string };
export type EnrollmentOutcome =
  | { kind: "enrolled"; lessonPath: string; created: boolean }
  | { kind: "signin" }
  | { kind: "consent" }
  | { kind: "refused"; code: string }
  /** Transport failure: the command is idempotent per account–course, so retrying is safe. */
  | { kind: "unknown" };

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const LESSON_PATH = /^\/courses\/[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?\/lessons\/[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const INTENT_KEY = "flx-free-enrollment-intent";
/** A magic link is short-lived; an older click is not treated as this login's explicit action. */
const INTENT_TTL_MS = 2 * 60 * 60 * 1000;

/** Full navigation (the lesson page is request-rendered with the fresh session); replaceable in tests. */
export const navigation = { assign: (path: string) => window.location.assign(path) };

export const validSlug = (value: unknown): value is string => typeof value === "string" && SLUG.test(value);
export const safeLessonPath = (value: unknown): value is string => typeof value === "string" && LESSON_PATH.test(value);

export function parseEnrollmentIntent(enroll: unknown, lesson: unknown): EnrollmentIntent | null {
  if (!validSlug(enroll)) return null;
  return validSlug(lesson) ? { courseSlug: enroll, lessonSlug: lesson } : { courseSlug: enroll };
}

/** Same-origin account path that carries the chosen course and lesson through the magic-link login. */
export function enrollmentAccountPath(intent: EnrollmentIntent) {
  const query = new URLSearchParams({ enroll: intent.courseSlug });
  if (intent.lessonSlug) query.set("lesson", intent.lessonSlug);
  return `/account?${query.toString()}`;
}

/** Marks that THIS browser's visitor pressed «Записаться бесплатно» before signing in. */
export function rememberEnrollmentIntent(intent: EnrollmentIntent, now = Date.now()) {
  try { window.localStorage.setItem(INTENT_KEY, JSON.stringify({ ...intent, at: now })); } catch { /* storage unavailable: explicit confirm later */ }
}

/** True only for this browser's own fresh click on the same course and lesson; always clears the mark. */
export function consumeEnrollmentIntent(intent: EnrollmentIntent, now = Date.now()) {
  try {
    const raw = window.localStorage.getItem(INTENT_KEY);
    window.localStorage.removeItem(INTENT_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { courseSlug?: unknown; lessonSlug?: unknown; at?: unknown };
    return saved.courseSlug === intent.courseSlug && (saved.lessonSlug ?? undefined) === intent.lessonSlug
      && typeof saved.at === "number" && now - saved.at >= 0 && now - saved.at <= INTENT_TTL_MS;
  } catch { return false; }
}

export async function readEnrollmentStatus(courseSlug: string, signal?: AbortSignal): Promise<FreeEnrollmentStatus | "signin" | null> {
  const response = await fetch(`/v1/me/free-enrollments/${encodeURIComponent(courseSlug)}`,
    { cache: "no-store", credentials: "same-origin", signal });
  if (response.status === 401) return "signin";
  if (!response.ok) return null;
  const status = await response.json() as FreeEnrollmentStatus;
  return status && status.courseSlug === courseSlug && typeof status.enrollable === "boolean" ? status : null;
}

export async function requestEnrollment(intent: EnrollmentIntent): Promise<EnrollmentOutcome> {
  let response: Response;
  try {
    response = await fetch("/v1/me/free-enrollments", { method: "POST", cache: "no-store", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(intent) });
  } catch { return { kind: "unknown" }; }
  const body = await response.json().catch(() => null) as { code?: unknown; lessonPath?: unknown; created?: unknown } | null;
  if (response.ok && body && safeLessonPath(body.lessonPath)) {
    return { kind: "enrolled", lessonPath: body.lessonPath, created: body.created === true };
  }
  if (response.status === 401) return { kind: "signin" };
  if (body?.code === "CONSENT_REQUIRED" || body?.code === "VERIFIED_ACCOUNT_REQUIRED") return { kind: "consent" };
  if (typeof body?.code === "string" && response.status >= 400 && response.status < 500) return { kind: "refused", code: body.code };
  return { kind: "unknown" };
}

export const refusalMessage = (code: string) => code === "FREE_COURSE_REQUIRED"
  ? "Курс больше не бесплатный: новая запись закрыта. Уже записанные сохраняют доступ."
  : code === "LESSON_NOT_FOUND" ? "Этот урок сейчас недоступен. Откройте курс и выберите другой урок."
    : code === "COURSE_NOT_READY" ? "В курсе пока нет опубликованных уроков. Запись откроется после публикации."
      : "Запись на этот курс сейчас недоступна.";
