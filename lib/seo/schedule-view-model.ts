import { formatRubles } from "@/lib/money";
import {
  departureLabel,
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
 * timezone. It must not happen in the view: `occurrenceDateLabel` uses the
 * ambient zone, which is the viewer's in a browser and the CI runner's during a
 * build, and those two disagreeing is precisely the bug this avoids.
 *
 * What is NOT in here: availability, sales state, purchase eligibility, promo
 * and quote. Those are live Commerce facts. The snapshot is the publication
 * state — canonical URLs, indexable HTML, and the initial city/date/venue/price
 * representation — and it is never the source of truth for whether a seat can
 * be sold.
 */
export type ScheduleEventView = {
  readonly id: string;
  readonly slug: string;
  readonly href: string;
  readonly cityTitle: string;
  /** Machine-readable, for <time dateTime>. */
  readonly startsAt: string;
  readonly dateLabel: string;
  readonly timeLabel: string;
  readonly venueLabel: string;
  readonly priceLabel: string;
  /** Null while the occurrence is still in the public tour. */
  readonly departedLabel: string | null;
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

const toEventView = (record: PublishedRecord): ScheduleEventView => ({
  id: record.id,
  slug: record.event_slug,
  href: `/events/${record.event_slug}`,
  cityTitle: record.city_title,
  startsAt: record.starts_at,
  dateLabel: occurrenceDateLabelInZone(record.starts_at, record.timezone),
  timeLabel: occurrenceTimeLabelInZone(record.starts_at, record.timezone),
  venueLabel:
    record.venue.status === "CONFIRMED" && record.venue.name
      ? record.venue.name
      : "Площадка уточняется",
  priceLabel: formatRubles(record.price_kopecks),
  departedLabel: isDeparted(record) ? departureLabel(record.departed) : null,
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
