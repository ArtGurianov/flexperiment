/* FLEX-123 first-delivery fixtures for both profiles. Synthetic only: no real e-mail, session,
 * order or ticket. Shapes are the agreed DTO forms (R1 /v1/my/courses → B, R2 /v1/my/tickets → D);
 * `/v1/my/profile` and `/v1/me/orders` follow the live Commerce routes on #286. */

export type CabinetFixtureName = "lms" | "lab" | "signed-out" | "consent-required";

type RawFixture = {
  readonly profile: unknown;
  readonly courses: unknown;
  readonly tickets: unknown;
  readonly orders: unknown;
};

/** LMS profile: a free enrolment, a purchase (started, with a lesson to resume) and a refunded bundle order. */
const lms: RawFixture = {
  profile: { email: "buyer@example.test", displayName: "Курсант", createdAt: "2026-11-20T10:00:00.000Z",
    consentRequired: false, marketing: false },
  courses: { courses: [
    { slug: "flex-basics", title: "Основы флексинга", access: "PURCHASE", started: true,
      resumeLesson: { slug: "isolation-intro", title: "Изоляции: вступление" } },
    { slug: "musicality-free", title: "Музыкальность — бесплатный модуль", access: "FREE_ENROLMENT", started: false, resumeLesson: null },
  ] },
  tickets: { tickets: [] },
  orders: { orders: [
    { orderPublicId: "ord_lms_fixture_0002", state: "REFUNDED", amountKopecks: 990000, currency: "RUB",
      title: "Пакет «Флекс целиком»", offerRef: "bundle:full", productKind: "COURSE_BUNDLE",
      createdAt: "2026-11-20T12:00:00.000Z", updatedAt: "2026-11-21T09:00:00.000Z" },
    { orderPublicId: "ord_lms_fixture_0001", state: "FULFILLED", amountKopecks: 490000, currency: "RUB",
      title: "Основы флексинга", offerRef: "course:flex-basics", productKind: "ONLINE_COURSE",
      createdAt: "2026-11-20T11:00:00.000Z", updatedAt: "2026-11-20T11:05:00.000Z" },
  ] },
};

/** LAB profile: one active ticket, one ticket with a pending refund, matching orders, no courses. */
const lab: RawFixture = {
  profile: { email: "lab-guest@example.test", displayName: null, createdAt: "2026-11-19T08:00:00.000Z",
    consentRequired: false, marketing: true },
  courses: { courses: [] },
  tickets: { tickets: [
    { orderPublicId: "ord_lab_fixture_0001", title: "LAB · Флекс-интенсив", startsAt: "2026-12-06T09:00:00.000Z",
      endsAt: "2026-12-06T17:00:00.000Z", timezone: "Asia/Novosibirsk", venueName: "Студия на Красном",
      status: "ACTIVE", viewPath: "/ticket/ord_lab_fixture_0001" },
    { orderPublicId: "ord_lab_fixture_0002", title: "LAB · Вечерняя практика", startsAt: "2026-12-13T12:00:00.000Z",
      endsAt: null, timezone: "Asia/Novosibirsk", venueName: null, status: "REFUND_PENDING", viewPath: null },
  ] },
  orders: { orders: [
    { orderPublicId: "ord_lab_fixture_0002", state: "REFUND_PENDING", amountKopecks: 250000, currency: "RUB",
      title: "LAB · Вечерняя практика", offerRef: "lab:evening", productKind: "LAB",
      createdAt: "2026-11-19T09:30:00.000Z", updatedAt: "2026-11-21T10:00:00.000Z" },
    { orderPublicId: "ord_lab_fixture_0001", state: "FULFILLED", amountKopecks: 450000, currency: "RUB",
      title: "LAB · Флекс-интенсив", offerRef: "lab:intensive", productKind: "LAB",
      createdAt: "2026-11-19T09:00:00.000Z", updatedAt: "2026-11-19T09:02:00.000Z" },
  ] },
};

export const CABINET_FIXTURES: Readonly<Record<"lms" | "lab", RawFixture>> = { lms, lab };

export function isCabinetFixtureName(value: unknown): value is CabinetFixtureName {
  return value === "lms" || value === "lab" || value === "signed-out" || value === "consent-required";
}
