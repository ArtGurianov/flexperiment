import { formatRubles } from "@/lib/money";
import {
  departureLabel,
  departureNotice,
  occurrenceCompactDateLabelInZone,
  occurrenceDateLabelInZone,
  occurrenceTimeLabelInZone,
} from "@/lib/occurrence-format";
import { isUpcoming } from "@/lib/seo/occurrence-publication";
import { isDeparted, type PublishedRecord } from "@/lib/seo/occurrence-snapshot";

/**
 * The one shape the schedule is rendered from, wherever it is rendered.
 *
 * Every field is a finished string, and that is the point. This model crosses
 * the server→client boundary: the standalone /schedule page renders it during
 * `next build`, and the home page hands the identical object to the client
 * controller that opens the same content in a drawer. Anything non-serializable
 * — a Date, a formatter, a snapshot record with methods — would work in one of
 * those places and break in the other.
 *
 * Formatting therefore happens exactly once, here, in the occurrence's own
 * timezone. It must not happen in the view, and it must not reach for a
 * formatter that takes no zone: the ambient one is the viewer's in a browser
 * and the CI runner's during a build, and those two disagreeing is precisely
 * the bug this avoids.
 *
 * What is NOT in here: availability, sales state, purchase eligibility, promo
 * and quote. Those are live Commerce facts. The snapshot is the publication
 * state — canonical URLs, indexable HTML, and the initial city/date/venue/price
 * representation — and it is never the source of truth for whether a seat can
 * be sold.
 */
/**
 * Whether an event can still be acted on.
 *
 * Always ACTIONABLE as built — the snapshot only publishes what was in the tour
 * at generation time. Hydration may downgrade it; see schedule-reconciliation.
 */
export type ScheduleListing = "ACTIONABLE" | "NOT_IN_LIVE_TOUR";

export type ScheduleEventView = {
  readonly id: string;
  readonly slug: string;
  readonly href: string;
  readonly cityTitle: string;
  /** Machine-readable, for <time dateTime>. */
  readonly startsAt: string;
  /**
   * The long date, «25 сентября 2026 г.» — for a heading, a detail panel, a
   * dialog title: anything read once and deliberately.
   */
  readonly dateLabel: string;
  /**
   * The same instant as «25.09.2026», for a catalogue row.
   *
   * A second FIELD, not a second FORMAT: the two are different presentation
   * registers for different surfaces, and carrying both here is what keeps the
   * choice at the call site instead of in a formatter that has to guess. Both
   * are derived from the same instant in the same zone, in one place, so a
   * catalogue row and the heading it links to cannot name different days — and
   * live reconciliation must rewrite BOTH, which is asserted in
   * useReconciledSchedule's tests.
   */
  readonly compactDateLabel: string;
  readonly timeLabel: string;
  readonly venueLabel: string;
  readonly priceLabel: string;
  /** Null while the occurrence is still in the public tour. */
  readonly departedLabel: string | null;
  /** The full public venue sentence, for the event detail panel. */
  readonly venueDisclosure: string;
  /**
   * The full archival sentence for an event detail banner, or null while the
   * occurrence is still in the tour.
   *
   * Separate from `departedLabel` because they are different registers, not
   * different lengths of the same string: the label is a chip on a catalogue
   * row («Отменён»), this is the sentence a visitor reads on the event itself
   * («Этот мастер-класс уже прошёл.»). COMPLETED and PAST share a label and do
   * not share a notice.
   *
   * Finished strings rather than the raw departure enum, keeping the rule that
   * this model carries presentation and never asks the view to interpret
   * domain values.
   */
  readonly archivalNotice: string | null;
  readonly listing: ScheduleListing;
};

export type ScheduleCityView = {
  readonly slug: string;
  readonly title: string;
  readonly upcoming: readonly ScheduleEventView[];
  readonly archived: readonly ScheduleEventView[];
};

export type ScheduleViewModel = {
  readonly cities: readonly ScheduleCityView[];
  /** Across every city — what decides whether the page has anything to offer. */
  readonly upcomingCount: number;
};

/**
 * The venue's two presentations, derived in one place.
 *
 * Exported because live reconciliation re-derives these from a fresh Commerce
 * occurrence, and a second copy of the rule would let the same venue read one
 * way before revalidation and another after — a visible flicker that is also a
 * correctness question ("did the venue change, or just the wording?").
 */
export const venuePresentation = (venue: {
  status: "CONFIRMED" | "TO_BE_ANNOUNCED";
  name: string | null;
  address: string | null;
}): { venueLabel: string; venueDisclosure: string } =>
  venue.status === "CONFIRMED" && venue.name
    ? {
        venueLabel: venue.name,
        venueDisclosure: venue.address
          ? `${venue.name}: ${venue.address}`
          : "Площадка уточняется. Адрес сообщим участникам по email.",
      }
    : {
        venueLabel: "Площадка уточняется",
        venueDisclosure: "Площадка уточняется. Адрес сообщим участникам по email.",
      };

const toEventView = (record: PublishedRecord): ScheduleEventView => ({
  id: record.id,
  slug: record.event_slug,
  href: `/events/${record.event_slug}`,
  cityTitle: record.city_title,
  startsAt: record.starts_at,
  dateLabel: occurrenceDateLabelInZone(record.starts_at, record.timezone),
  compactDateLabel: occurrenceCompactDateLabelInZone(record.starts_at, record.timezone),
  timeLabel: occurrenceTimeLabelInZone(record.starts_at, record.timezone),
  ...venuePresentation(record.venue),
  priceLabel: formatRubles(record.price_kopecks),
  departedLabel: isDeparted(record) ? departureLabel(record.departed) : null,
  archivalNotice: isDeparted(record) ? departureNotice(record.departed) : null,
  // As built, everything published was in the tour. Hydration may downgrade it.
  listing: "ACTIONABLE",
});

/**
 * Groups published records into the schedule, city by city.
 *
 * Cities are ordered by their soonest upcoming date, so the page reads as a
 * tour itinerary rather than an alphabetical index. A city whose dates are all
 * archival sorts last — it keeps its entry, because its event URLs are
 * permanent and still link here, but it stops competing for the top of a page
 * that means "where we are going next".
 */
export function toScheduleViewModel(
  records: readonly PublishedRecord[],
): ScheduleViewModel {
  const byCity = new Map<string, PublishedRecord[]>();
  for (const record of records) {
    const list = byCity.get(record.city);
    if (list) list.push(record);
    else byCity.set(record.city, [record]);
  }

  const cities = [...byCity.entries()].map(([slug, list]) => ({
    slug,
    title: list[0].city_title,
    upcoming: list.filter(isUpcoming).map(toEventView),
    archived: list.filter((record) => !isUpcoming(record)).map(toEventView),
  }));

  cities.sort((a, b) => {
    const soonest = (city: ScheduleCityView) => city.upcoming[0]?.startsAt ?? "";
    // Empty string sorts before any timestamp, so invert: a city with no
    // upcoming date goes last, and otherwise the earlier date wins.
    if (!a.upcoming.length !== !b.upcoming.length) return a.upcoming.length ? -1 : 1;
    const left = soonest(a);
    const right = soonest(b);
    return left < right ? -1 : left > right ? 1 : a.slug < b.slug ? -1 : 1;
  });

  return {
    cities,
    upcomingCount: cities.reduce((total, city) => total + city.upcoming.length, 0),
  };
}
