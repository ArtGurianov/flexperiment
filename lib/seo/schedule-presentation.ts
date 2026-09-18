import { isCitySlug, type CitySlug } from "@/lib/city-catalog";
import type { ScheduleEventView, ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * Presentation ordering for the catalogue. Deliberately NOT part of domain
 * reconciliation.
 *
 * `ScheduleViewModel` is grouped by city because that is how the snapshot is
 * published and how an event is looked up by slug. It is not how the catalogue
 * reads: the surface a visitor wants is one global itinerary — the next date
 * first, whatever city it is in — and grouping by city turned that into an
 * index of cities that happens to contain dates.
 *
 * So the grouping stays in the model and the flattening lives here, where it is
 * a rendering decision two different presentations can share. Nothing in this
 * file knows about sales, availability or purchase eligibility: those are live
 * Commerce facts that belong to the event surface and the checkout, and pulling
 * them into the catalogue would move transactional authority back into a picker.
 *
 * NOTHING HERE MUTATES THE MODEL. `flatMap` already produces a fresh array and
 * `filter` another, so the `sort` below only ever reorders a local copy — the
 * readonly arrays inside `ScheduleViewModel` are never touched.
 */

/**
 * Earliest first, with a deterministic tie-break.
 *
 * Two occurrences can share an instant (two cities on the same evening is the
 * obvious case), and a comparator that returns 0 there leaves the order to the
 * engine's sort stability over an array whose input order came from city
 * grouping. `id` is the one field guaranteed present, unique and stable across
 * a live reconciliation that may rewrite every other field.
 */
const byStartThenId = (a: ScheduleEventView, b: ScheduleEventView): number =>
  a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Every upcoming date still being offered, across all cities, in chronological
 * order.
 *
 * `ACTIONABLE` is the only filter. A record a successful live read stopped
 * returning is `NOT_IN_LIVE_TOUR`: it keeps its permanent /events/<slug> page,
 * but it is not a date anyone can be sent to book, so it leaves the picker. It
 * is NOT moved to the archive — absence from `tour()` is ambiguous, and calling
 * it cancelled would assert a reason nothing established.
 *
 * Because the sort reads `startsAt` off the reconciled events rather than off
 * the snapshot, a live read that moves a date also moves the row: the ordering
 * is derived at render time, not frozen at build time.
 */
export const actionableUpcomingEvents = (
  model: ScheduleViewModel,
): readonly ScheduleEventView[] =>
  model.cities
    .flatMap((city) => city.upcoming)
    .filter((event) => event.listing === "ACTIONABLE")
    .sort(byStartThenId);

/**
 * Archived dates across all cities, most recent first.
 *
 * Newest-first rather than chronological: this is a record of what has already
 * happened, and the date a visitor is most likely to be looking for — the one
 * they just missed, or the one on a ticket in their inbox — is the latest one.
 * The same `id` tie-break keeps it deterministic.
 *
 * Archived records are snapshot-owned; a live read never reaches them.
 */
export const archivedEvents = (
  model: ScheduleViewModel,
): readonly ScheduleEventView[] =>
  model.cities.flatMap((city) => city.archived).sort((a, b) => -byStartThenId(a, b));

/**
 * The cities that currently have a bookable date, for CityInterestForm.
 *
 * It takes this from the reconciled catalogue rather than from a second
 * `/v1/public/tour` read of its own — the picker has already decided which
 * dates are actionable, and asking again could offer "tell me when you come to
 * X" for a city whose date is visible one row above.
 *
 * Filtered through `isCitySlug` because the form's options come from
 * CITY_CATALOGUE: a snapshot slug outside that catalogue cannot suppress an
 * option that does not exist, and must not be forced into the `CitySlug` type
 * by a cast.
 */
export const scheduledCitySlugs = (model: ScheduleViewModel): CitySlug[] =>
  model.cities
    .filter((city) => city.upcoming.some((event) => event.listing === "ACTIONABLE"))
    .map((city) => city.slug)
    .filter(isCitySlug);
