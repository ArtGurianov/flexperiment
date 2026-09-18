import type { PurchaseStatus } from "@/lib/occurrence-sales";
import type { SeoDeparture } from "@/lib/seo/occurrence-snapshot";

/**
 * The live public occurrence as the browser sees it, and the formatters that
 * turn it into Russian UI copy.
 *
 * Extracted verbatim out of components/CheckoutFlow.tsx, where all of it was
 * module-private inside a `"use client"` file and therefore unusable from a
 * server component. The call sites in CheckoutFlow are unchanged — only the
 * definitions moved — so an event page and the checkout dialog format the same
 * occurrence the same way rather than drifting into two dialects of the same
 * date.
 *
 * Note this is the *runtime* view: it carries availability, sales_status and
 * purchase_status, which lib/seo/occurrence-snapshot.ts deliberately does not,
 * because they are clock- and gate-dependent. The snapshot's SeoOccurrence and
 * this type are separate on purpose — one is a build-time durable record, the
 * other is what a fetch returned a moment ago.
 */
export type Occurrence = {
  id: string;
  city: string;
  city_title: string;
  title: string;
  starts_at: string;
  timezone: string;
  price_kopecks: number;
  availability: number;
  sales_status: "OPEN" | "PAUSED" | "CLOSED";
  fulfillment_status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  purchase_status: PurchaseStatus;
  venue: {
    status: "CONFIRMED" | "TO_BE_ANNOUNCED";
    name: string | null;
    address: string | null;
    disclosure_text: string | null;
    announce_by: string | null;
  };
};

/**
 * TWO DATE REGISTERS, AND THE DIFFERENCE IS THE SURFACE, NOT THE TASTE.
 *
 *   compact   25.09.2026            a catalogue row — a picker, scanned
 *   long      25 сентября 2026 г.   a heading, a detail panel, a confirmation
 *
 * A row's job is to be scanned against its neighbours and clicked; it carries
 * no other information, it sits at text-2xl, and it competes for a line with a
 * city name. A heading, an event page's «Дата и время», a checkout panel and a
 * refund confirmation are read once and deliberately — there the spelled-out
 * month is easier to take in and much harder to misread at a glance.
 *
 * The compact form is safe HERE and would not be everywhere: the audience is
 * Russia only, where DD.MM.YYYY is the everyday written form and MM.DD.YYYY is
 * not in use, so a numeric date carries no ambiguity to resolve.
 *
 * An earlier pass made everything numeric, which is how the long register ended
 * up removed from surfaces that had nothing to do with the catalogue. Two
 * registers is not the same as two competing formats: each one names the job it
 * is for, and the picker is the only caller of the compact one.
 *
 * NOT part of this at all: the server-issued strings in commerce/ — the
 * transactional emails, the fiscal receipt line items and the API's own
 * `venue_disclosure`. Those are a different layer with its own audience and
 * legal weight, they spell the month out, and they should.
 */

/**
 * The picker's date: numeric, compact, in the occurrence's own zone.
 *
 * Zone-explicit like every other formatter here, and for the reason that
 * governs the whole file: under `output: "export"` the ambient zone is the CI
 * runner's, so a date formatted without one is frozen into static HTML for
 * every visitor. This replaced an ambient-zone helper that produced the same
 * string and was correct only in a browser.
 *
 * It does NOT promise to fit on one line. It shortens the row — «Новосибирск ×
 * 02.10.2026» fits at 390px where the long form did not — but a browser smoke
 * measured «Санкт-Петербург × 25.09.2026» at 340px in a 314px drawer row, and
 * city-catalog.ts holds longer names still. ScheduleRow is built to wrap well
 * rather than to rely on not wrapping.
 */
export const occurrenceCompactDateLabelInZone = (startsAt: string, timeZone: string) => {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "Дата уточняется";
  const options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};

/** Full date and time in the occurrence's own zone — safe to prerender. */
export const occurrenceDateTimeLabel = (startsAt: string, timeZone: string) => {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "Время уточняется";
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};

/**
 * The long date, without a time, in the occurrence's own zone.
 *
 * The one a prerendered heading wants: "14 марта 2030 г." is the same string on
 * every machine that builds it.
 */
export const occurrenceDateLabelInZone = (startsAt: string, timeZone: string) => {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "Дата уточняется";
  const options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "long", year: "numeric" };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};

/** Time of day only, in the occurrence's own zone. */
export const occurrenceTimeLabelInZone = (startsAt: string, timeZone: string) => {
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("ru-RU", options).format(date);
  }
};

/**
 * What may be said publicly about where the workshop happens.
 *
 * Reads `disclosure_text` and `announce_by`, which are live-response fields the
 * SEO snapshot does not carry — an event page states the venue or says plainly
 * that it is not announced yet, and never restates a promise about when an
 * email will go out.
 */
export const publicVenueDisclosure = (occurrence: Occurrence) => {
  const { venue } = occurrence;
  if (venue.status === "CONFIRMED") {
    return venue.name && venue.address
      ? `${venue.name}: ${venue.address}`
      : "Точное место проведения будет доступно при записи.";
  }
  const deadline = venue.announce_by
    ? ` Сообщим адрес участникам на email не позднее ${occurrenceDateTimeLabel(venue.announce_by, occurrence.timezone)}.`
    : "";
  return `${venue.disclosure_text ?? "Площадка уточняется."}${deadline}`;
};

/**
 * What to tell a visitor who has landed on a page for a date that is no longer
 * in the public tour.
 *
 * Each string says only what the snapshot actually knows. WITHDRAWN is the
 * careful one: `/v1/public/occurrences/{id}` answered 404, so the honest
 * statement is that the date is no longer available — not that it was cancelled
 * (which would assert a reason nothing confirmed) and not that it happened.
 */
export const departureNotice = (departed: SeoDeparture): string =>
  departed === "CANCELLED"
    ? "Этот мастер-класс отменён. Запись закрыта."
    : departed === "COMPLETED"
      ? "Этот мастер-класс уже прошёл."
      : departed === "PAST"
        ? "Эта дата уже прошла."
        : "Эта дата больше не доступна.";

/** The same thing as a short label, for a list item rather than a banner. */
export const departureLabel = (departed: SeoDeparture): string =>
  departed === "CANCELLED"
    ? "Отменён"
    : departed === "COMPLETED" || departed === "PAST"
      ? "Прошёл"
      : "Недоступен";
