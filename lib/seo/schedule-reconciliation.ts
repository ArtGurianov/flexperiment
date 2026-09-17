import type { PublicOccurrence } from "@/lib/seo/public-occurrence";
import type { ScheduleEventView, ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * Reconciles the build-time schedule against a successful live tour read.
 *
 * The division of authority is the whole point, and it is deliberately lopsided:
 *
 *   The SNAPSHOT owns route-bearing identity — which `event_slug` exists, and
 *   therefore which /events/<slug> documents the static export contains. Live
 *   Commerce cannot add to that set, because a URL nobody built is a 404.
 *
 *   The LIVE TOUR owns mutable presentation for an occurrence the snapshot
 *   already knows: its date, time, venue and price, plus whether it is still
 *   being offered at all.
 *
 * Three cases follow, and each is a decision rather than a default:
 *
 *   known id, present live      update presentation from live
 *   known id, absent live       stops being actionable and stops counting as
 *                               upcoming — but is NOT tombstoned. Absence from
 *                               `tour()` is ambiguous: it filters to SCHEDULED
 *                               and future, so a record can vanish for reasons
 *                               that are not cancellation. Deciding it is
 *                               archived requires the generator's re-fetch
 *                               against /v1/public/occurrences/{id}, which a
 *                               browser does not do. Archival stays
 *                               snapshot-owned until the next regeneration.
 *   unknown id, present live    IGNORED ENTIRELY. This is publication skew —
 *                               Commerce has an occurrence the snapshot has not
 *                               published. Minting `city + uuid` in the browser
 *                               would link to a page the export does not
 *                               contain. It is closed by regenerating the
 *                               snapshot and releasing, which is exactly what
 *                               makes the refresh obligation a product
 *                               correctness requirement and not a preference.
 *
 * A failed read changes nothing: the snapshot stands. Applied identically by
 * the standalone /schedule page after hydration and by the drawer, so the two
 * never drift apart in front of the same user.
 */

const reconcileEvent = (
  event: ScheduleEventView,
  live: PublicOccurrence | undefined,
  format: (occurrence: PublicOccurrence) => Partial<ScheduleEventView>,
): ScheduleEventView =>
  live
    ? { ...event, ...format(live), listing: "ACTIONABLE" }
    : { ...event, listing: "NOT_IN_LIVE_TOUR" };

export function reconcileSchedule(
  model: ScheduleViewModel,
  live: readonly PublicOccurrence[] | null,
  format: (occurrence: PublicOccurrence) => Partial<ScheduleEventView>,
): ScheduleViewModel {
  // A failed or unattempted read leaves the published state exactly as built.
  if (live === null) return model;

  const byId = new Map(live.map((occurrence) => [occurrence.id, occurrence]));

  const cities = model.cities.map((city) => ({
    ...city,
    upcoming: city.upcoming.map((event) => reconcileEvent(event, byId.get(event.id), format)),
    // Archived records are snapshot-owned and are not touched by a live read.
    archived: city.archived,
  }));

  return {
    cities,
    upcomingCount: cities.reduce(
      (total, city) => total + city.upcoming.filter((event) => event.listing !== "NOT_IN_LIVE_TOUR").length,
      0,
    ),
  };
}

/** Live ids the snapshot has never published — publication skew, for diagnostics only. */
export const unpublishedLiveIds = (
  model: ScheduleViewModel,
  live: readonly PublicOccurrence[],
): readonly string[] => {
  const known = new Set(
    model.cities.flatMap((city) => [...city.upcoming, ...city.archived]).map((event) => event.id),
  );
  return live.filter((occurrence) => !known.has(occurrence.id)).map((occurrence) => occurrence.id);
};
