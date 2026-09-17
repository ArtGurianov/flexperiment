import { describe, expect, it } from "vitest";

import { reconcileSchedule, unpublishedLiveIds } from "./schedule-reconciliation";
import { toScheduleViewModel } from "./schedule-view-model";
import type { ScheduleEventView } from "./schedule-view-model";
import type { PublicOccurrence } from "./public-occurrence";
import { publicOccurrence, seoOccurrence } from "./public-occurrence-fixture";
import type { SeoTombstone } from "./occurrence-snapshot";

/** Stands in for the real formatter; asserts only that live values flow through. */
const format = (occurrence: PublicOccurrence): Partial<ScheduleEventView> => ({
  priceLabel: `LIVE:${occurrence.price_kopecks}`,
  venueLabel: occurrence.venue.name ?? "LIVE:TBA",
  startsAt: occurrence.starts_at,
});

const built = () => toScheduleViewModel([seoOccurrence()]);
const KNOWN = seoOccurrence().id;

describe("reconcileSchedule", () => {
  it("leaves the published state untouched when the live read failed", () => {
    // null means "no successful read", not "the tour is empty". Treating those
    // the same would blank the schedule whenever Commerce is briefly
    // unreachable.
    expect(reconcileSchedule(built(), null, format)).toEqual(built());
  });

  it("updates presentation for an id the snapshot already published", () => {
    const live = publicOccurrence({ id: KNOWN, price_kopecks: 999900, starts_at: "2030-05-01T04:00:00.000Z" });
    const [city] = reconcileSchedule(built(), [live], format).cities;
    expect(city.upcoming[0].priceLabel).toBe("LIVE:999900");
    expect(city.upcoming[0].startsAt).toBe("2030-05-01T04:00:00.000Z");
    expect(city.upcoming[0].listing).toBe("ACTIONABLE");
    // The route-bearing identity is the snapshot's and must not move.
    expect(city.upcoming[0].href).toBe(`/events/${seoOccurrence().event_slug}`);
  });

  it("stops an absent id being actionable or counted, without archiving it", () => {
    // tour() filters to SCHEDULED and future, so absence is ambiguous. Deciding
    // it is cancelled needs the generator's per-id re-fetch, which a browser
    // does not perform. Archival stays snapshot-owned.
    const reconciled = reconcileSchedule(built(), [], format);
    const [city] = reconciled.cities;
    expect(city.upcoming[0].listing).toBe("NOT_IN_LIVE_TOUR");
    expect(city.upcoming[0].departedLabel).toBeNull();
    expect(city.archived).toHaveLength(0);
    expect(reconciled.upcomingCount).toBe(0);
    // Still present, still linkable — its page exists and its URL is permanent.
    expect(city.upcoming).toHaveLength(1);
  });

  it("never invents a route for a live id the snapshot has not published", () => {
    // Publication skew. Minting city+uuid here would link to a document the
    // static export does not contain. It is closed by regenerating the snapshot
    // and releasing — not in the browser.
    const stranger = publicOccurrence({ id: "44444444-2222-4333-8444-555555555555" });
    const reconciled = reconcileSchedule(built(), [publicOccurrence({ id: KNOWN }), stranger], format);
    const ids = reconciled.cities.flatMap((city) => city.upcoming.map((event) => event.id));
    expect(ids).toEqual([KNOWN]);
    expect(JSON.stringify(reconciled)).not.toContain(stranger.id);
  });

  it("surfaces publication skew for diagnostics without acting on it", () => {
    const stranger = publicOccurrence({ id: "44444444-2222-4333-8444-555555555555" });
    expect(unpublishedLiveIds(built(), [publicOccurrence({ id: KNOWN }), stranger])).toEqual([stranger.id]);
    expect(unpublishedLiveIds(built(), [publicOccurrence({ id: KNOWN })])).toEqual([]);
  });

  it("leaves archived snapshot records alone even when live disagrees", () => {
    const tombstone: SeoTombstone = { ...seoOccurrence(), departed: "CANCELLED", fulfillment_status: "CANCELLED" };
    const model = toScheduleViewModel([tombstone]);
    // Commerce reporting it again does not un-archive it; only regeneration can.
    const reconciled = reconcileSchedule(model, [publicOccurrence({ id: KNOWN })], format);
    expect(reconciled.cities[0].archived).toEqual(model.cities[0].archived);
    expect(reconciled.cities[0].archived[0].departedLabel).toBe("Отменён");
  });

  it("stays serializable after reconciliation, since the drawer receives it", () => {
    const reconciled = reconcileSchedule(built(), [publicOccurrence({ id: KNOWN })], format);
    expect(JSON.parse(JSON.stringify(reconciled))).toEqual(reconciled);
  });
});
