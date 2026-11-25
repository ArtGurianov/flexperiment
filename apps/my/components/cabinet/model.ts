/* FLEX-123 cabinet DTOs and strict parsers. Every answer from Commerce is narrowed to a closed
 * field set here; unknown fields (ids of other rows, tokens, QR payloads, provider data) never
 * reach a page. Pure module: no I/O, safe to unit-test. */

export type LoadResult<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "signed-out" }
  | { readonly status: "consent-required" }
  /** The read route is not live yet (R1/R2 pending) — shown as "скоро", never as an empty list. */
  | { readonly status: "not-yet-available" }
  | { readonly status: "unavailable" };

export type CabinetProfile = {
  readonly email: string;
  readonly displayName: string | null;
  readonly consentRequired: boolean;
  readonly marketing: boolean;
  readonly createdAt: string;
};

export type CourseAccess = "FREE_ENROLMENT" | "PURCHASE" | "BUNDLE" | "GRANTED";
export type CabinetCourse = {
  readonly slug: string;
  readonly title: string;
  readonly access: CourseAccess;
  /** "Начат" is a separate fact. */
  readonly started: boolean;
  readonly progressPercent?: number;
  readonly continuationReason?: "FIRST" | "CURRENT" | "NEXT" | "REWATCH" | "PREVIOUS_UNAVAILABLE";
  readonly resumeLesson: { readonly slug: string; readonly title: string } | null;
};

export type TicketStatus = "VALID" | "USED" | "VOID" | "NOT_ISSUED";
export type CabinetTicket = {
  readonly orderPublicId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly timezone: string;
  readonly venueName: string | null;
  readonly status: TicketStatus;
  /** Relative MY path of the owner's ticket view (FLEX-60). Never a QR or capability token. */
  readonly viewPath: string | null;
};

export type OrderState = "DRAFT" | "PAYMENT_PENDING" | "FULFILLED" | "EXPIRED" | "CANCELLED"
  | "REFUND_PENDING" | "REFUNDED" | "REVIEW_REQUIRED";
export type ProductKind = "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
export type CabinetOrder = {
  readonly orderPublicId: string;
  readonly state: OrderState;
  readonly amountKopecks: number;
  readonly title: string;
  readonly productKind: ProductKind;
  readonly createdAt: string;
};

type Unknown = Record<string, unknown>;
const record = (value: unknown): Unknown | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Unknown : null;
const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
const iso = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (values as readonly string[]).includes(value) ? value as T : null;
const list = <T>(value: unknown, key: string, item: (entry: Unknown) => T | null): T[] | null => {
  const items = record(value)?.[key];
  if (!Array.isArray(items)) return null;
  return items.flatMap((entry) => { const parsed = record(entry) && item(entry as Unknown); return parsed ? [parsed] : []; });
};

const SLUG = /^[a-z0-9-]{1,80}$/;
const LESSON_SLUG = /^[a-z0-9-]{1,120}$/;
const PUBLIC_ID = /^[A-Za-z0-9_-]{8,64}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export function parseProfile(value: unknown): CabinetProfile | null {
  const input = record(value);
  if (!input) return null;
  const email = typeof input.email === "string" && EMAIL.test(input.email) ? input.email : null;
  const createdAt = iso(input.createdAt);
  if (!email || !createdAt) return null;
  return {
    email, createdAt,
    displayName: text(input.displayName, 80),
    consentRequired: input.consentRequired === true,
    marketing: input.marketing === true,
  };
}

export function parseCourses(value: unknown): CabinetCourse[] | null {
  return list(value, "courses", (entry) => {
    const slug = typeof entry.slug === "string" && SLUG.test(entry.slug) ? entry.slug : null;
    const title = text(entry.title);
    const access = oneOf(["FREE_ENROLMENT", "PURCHASE", "BUNDLE", "GRANTED"] as const, entry.access);
    if (!slug || !title || !access) return null;
    const lesson = record(entry.resumeLesson);
    const lessonSlug = lesson && typeof lesson.slug === "string" && LESSON_SLUG.test(lesson.slug) ? lesson.slug : null;
    const lessonTitle = lesson && text(lesson.title);
    const progressPercent = typeof entry.progressPercent === "number" && Number.isInteger(entry.progressPercent)
      && entry.progressPercent >= 0 && entry.progressPercent <= 100 ? entry.progressPercent : undefined;
    const continuationReason = oneOf(["FIRST", "CURRENT", "NEXT", "REWATCH", "PREVIOUS_UNAVAILABLE"] as const, entry.continuationReason);
    return { slug, title, access, started: entry.started === true,
      ...(continuationReason ? { continuationReason } : {}),
      ...(progressPercent !== undefined ? { progressPercent } : {}),
      resumeLesson: lessonSlug && lessonTitle ? { slug: lessonSlug, title: lessonTitle } : null };
  });
}

export function parseTickets(value: unknown): CabinetTicket[] | null {
  return list(value, "tickets", (entry) => {
    const orderPublicId = typeof entry.orderPublicId === "string" && PUBLIC_ID.test(entry.orderPublicId) ? entry.orderPublicId : null;
    const title = text(entry.title);
    const startsAt = iso(entry.startsAt);
    const timezone = text(entry.timezone, 64);
    const status = oneOf(["VALID", "USED", "VOID", "NOT_ISSUED"] as const, entry.status);
    if (!orderPublicId || !title || !startsAt || !timezone || !status) return null;
    return { orderPublicId, title, startsAt, timezone, status,
      endsAt: iso(entry.endsAt), venueName: text(entry.venueName),
      viewPath: entry.viewPath === `/tickets/${orderPublicId}` ? entry.viewPath : null };
  });
}

export function parseOrders(value: unknown): CabinetOrder[] | null {
  return list(value, "orders", (entry) => {
    const orderPublicId = typeof entry.orderPublicId === "string" && PUBLIC_ID.test(entry.orderPublicId) ? entry.orderPublicId : null;
    const state = oneOf(["DRAFT", "PAYMENT_PENDING", "FULFILLED", "EXPIRED", "CANCELLED", "REFUND_PENDING", "REFUNDED", "REVIEW_REQUIRED"] as const, entry.state);
    const productKind = oneOf(["ONLINE_COURSE", "COURSE_BUNDLE", "LAB"] as const, entry.productKind);
    const title = text(entry.title);
    const createdAt = iso(entry.createdAt);
    const amountKopecks = Number.isSafeInteger(entry.amountKopecks) && (entry.amountKopecks as number) >= 0 ? entry.amountKopecks as number : null;
    if (!orderPublicId || !state || !productKind || !title || !createdAt || amountKopecks === null) return null;
    if (entry.currency !== undefined && entry.currency !== "RUB") return null;
    return { orderPublicId, state, productKind, title, createdAt, amountKopecks };
  });
}

/** Lesson / course entry through the exchange receiver (FLEX-121 accepts the protected entry). */
export function lmsEntryHref(platformOrigin: string, course: CabinetCourse, sharedSession = false): string {
  const next = course.resumeLesson ? `/courses/${course.slug}/lessons/${course.resumeLesson.slug}` : `/courses/${course.slug}`;
  if (sharedSession) return new URL(next, platformOrigin).href;
  const url = new URL("/auth/lms/start", platformOrigin);
  url.searchParams.set("next", next);
  return url.toString();
}

export const ACCESS_LABEL: Record<CourseAccess, string> = {
  FREE_ENROLMENT: "Бесплатная запись",
  PURCHASE: "Куплен",
  BUNDLE: "В пакете",
  GRANTED: "Предоставлен",
};

/** Payment / refund state of an order — deliberately separate from access. */
export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  DRAFT: "Черновик",
  PAYMENT_PENDING: "Ожидает оплаты",
  FULFILLED: "Оплачен",
  EXPIRED: "Срок оплаты истёк",
  CANCELLED: "Отменён",
  REFUND_PENDING: "Возврат в обработке",
  REFUNDED: "Возвращён",
  REVIEW_REQUIRED: "На проверке",
};

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  VALID: "Действует",
  USED: "Использован",
  VOID: "Аннулирован",
  NOT_ISSUED: "Ещё не выдан",
};

export const PRODUCT_LABEL: Record<ProductKind, string> = {
  ONLINE_COURSE: "Курс",
  COURSE_BUNDLE: "Пакет курсов",
  LAB: "LAB",
};

export function formatRub(kopecks: number): string {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: kopecks % 100 ? 2 : 0 })
    .format(kopecks / 100);
}

export function formatDate(value: string, timeZone = "Europe/Moscow"): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone }).format(new Date(value));
}

export function formatDateTime(value: string, timeZone: string): string {
  try { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone }).format(new Date(value)); }
  catch { return formatDate(value); }
}
