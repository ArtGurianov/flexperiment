import type { PublishedRecord } from "@/lib/seo/occurrence-snapshot";
import {
  toScheduleViewModel,
  type ScheduleEventView,
  type ScheduleListing,
  type ScheduleViewModel,
} from "@/lib/seo/schedule-view-model";

/**
 * One event, as the event surface presents it.
 *
 * A dedicated model rather than a widened ScheduleEventView. The two describe
 * different things: a catalogue row shows a short `venueLabel` and a chip, an
 * event page shows the full venue sentence and an archival banner. Growing the
 * schedule DTO into a universal bag of fields would blur a boundary that is
 * currently clean.
 *
 * Fully serializable and pre-formatted, like every other model here, because it
 * is built on the server for the standalone page and in the browser for the
 * drawer.
 */
export type EventViewModel = {
  readonly id: string;
  readonly slug: string;
  readonly cityTitle: string;
  readonly startsAt: string;
  readonly dateLabel: string;
  readonly timeLabel: string;
  readonly venueDisclosure: string;
  readonly priceLabel: string;
  readonly archivalNotice: string | null;
  readonly listing: ScheduleListing;
};

/**
 * The drawer's path: the visitor has already clicked a row, so every string is
 * formatted and simply moves across.
 *
 * It used to take the owning `ScheduleCityView` as well, purely to supply a
 * `citySlug` for the `/schedule#<city>` backlink. That fragment is gone — the
 * catalogue is one chronological list with no per-city section — so the city is
 * no longer part of this model's identity, only of its content.
 */
export const toEventViewModelFromSchedule = (
  event: ScheduleEventView,
): EventViewModel => ({
  id: event.id,
  slug: event.slug,
  cityTitle: event.cityTitle,
  startsAt: event.startsAt,
  dateLabel: event.dateLabel,
  timeLabel: event.timeLabel,
  venueDisclosure: event.venueDisclosure,
  priceLabel: event.priceLabel,
  archivalNotice: event.archivalNotice,
  listing: event.listing,
});

/**
 * The standalone page's path, deliberately routed through the schedule model.
 *
 * It would be easy to format the record directly here, and that is exactly the
 * mistake: there would then be two places deciding how a date, a venue and a
 * price are rendered, and they would drift. Building the one-record schedule
 * model and converting guarantees a single presentation contract by
 * construction rather than by discipline.
 */
export const toEventViewModel = (record: PublishedRecord): EventViewModel => {
  const [city] = toScheduleViewModel([record]).cities;
  const [event] = [...city.upcoming, ...city.archived];
  return toEventViewModelFromSchedule(event);
};

/** Finds an event in a (reconciled) schedule model and converts it. */
export const findEventInSchedule = (
  model: ScheduleViewModel,
  slug: string,
): EventViewModel | null => {
  for (const city of model.cities) {
    const event = [...city.upcoming, ...city.archived].find((entry) => entry.slug === slug);
    if (event) return toEventViewModelFromSchedule(event);
  }
  return null;
};
