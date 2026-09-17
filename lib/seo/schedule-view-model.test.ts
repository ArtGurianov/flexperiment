import { describe, expect, it } from "vitest";

import { toScheduleViewModel } from "./schedule-view-model";
import type { PublishedRecord, SeoTombstone } from "./occurrence-snapshot";
import { seoOccurrence } from "./public-occurrence-fixture";

const OTHER = "99999999-2222-4333-8444-555555555555";

const spb = (over: Partial<PublishedRecord> = {}): PublishedRecord =>
  seoOccurrence({
    id: OTHER,
    event_slug: `saint-petersburg-${OTHER}`,
    city: "saint-petersburg",
    city_title: "Санкт-Петербург",
    timezone: "Europe/Moscow",
    ...over,
  });

describe("toScheduleViewModel", () => {
  it("formats every field in the occurrence's own timezone, not the ambient one", () => {
    // 04:00Z is 11:00 in Asia/Novosibirsk. If this ever reads 04:00 or the CI
    // runner's local time, the view model has started formatting with the
    // ambient zone — the exact defect occurrenceDateLabelInZone exists to stop.
    const [city] = toScheduleViewModel([
      seoOccurrence({ starts_at: "2030-03-14T04:00:00.000Z", ends_at: "2030-03-14T08:00:00.000Z" }),
    ]).cities;
    expect(city.upcoming[0].timeLabel).toBe("11:00");
    expect(city.upcoming[0].dateLabel).toContain("2030");
    expect(city.upcoming[0].startsAt).toBe("2030-03-14T04:00:00.000Z");
  });

  it("produces only serializable primitives, so it can cross to the client", () => {
    // The drawer receives this object as props. A Date or a snapshot record
    // would render fine on the server and fail at the boundary.
    const model = toScheduleViewModel([seoOccurrence()]);
    const walk = (value: unknown): void => {
      // null is serializable and is the documented "still in the tour" value of
      // departedLabel, so it passes; a Date or a class instance would not.
      if (value === null) return;
      if (Array.isArray(value)) return value.forEach(walk);
      if (typeof value === "object") {
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
        return Object.values(value).forEach(walk);
      }
      expect(["string", "number", "boolean"]).toContain(typeof value);
    };
    walk(model);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it("splits upcoming from archived, and labels only the archived", () => {
    const tombstone: SeoTombstone = { ...spb(), departed: "CANCELLED", fulfillment_status: "CANCELLED" };
    const [city] = toScheduleViewModel([seoOccurrence(), tombstone]).cities.filter(
      (entry) => entry.slug === "novosibirsk",
    );
    expect(city.upcoming).toHaveLength(1);
    expect(city.upcoming[0].departedLabel).toBeNull();

    const [spbCity] = toScheduleViewModel([tombstone]).cities;
    expect(spbCity.upcoming).toHaveLength(0);
    expect(spbCity.archived[0].departedLabel).toBe("Отменён");
  });

  it("orders cities by their soonest upcoming date", () => {
    const later = spb({ starts_at: "2030-09-01T04:00:00.000Z", ends_at: "2030-09-01T08:00:00.000Z" });
    const model = toScheduleViewModel([later, seoOccurrence()]);
    // novosibirsk is 2030-03-14, saint-petersburg 2030-09-01.
    expect(model.cities.map((city) => city.slug)).toEqual(["novosibirsk", "saint-petersburg"]);
    expect(model.upcomingCount).toBe(2);
  });

  it("sorts a city with nothing upcoming last, without dropping it", () => {
    // Its event URLs are permanent and still link here, so it keeps an entry —
    // it just stops competing for the top of a page that means "where next".
    const archived: SeoTombstone = { ...spb(), departed: "PAST" };
    const model = toScheduleViewModel([archived, seoOccurrence()]);
    expect(model.cities.map((city) => city.slug)).toEqual(["novosibirsk", "saint-petersburg"]);
    expect(model.cities[1].upcoming).toHaveLength(0);
    expect(model.cities[1].archived).toHaveLength(1);
    expect(model.upcomingCount).toBe(1);
  });

  it("links each event at its frozen slug", () => {
    const [city] = toScheduleViewModel([seoOccurrence()]).cities;
    expect(city.upcoming[0].href).toBe(`/events/${seoOccurrence().event_slug}`);
  });

  it("carries no live commerce state", () => {
    // Availability, sales status and purchase eligibility are not the
    // snapshot's to publish, so they must not appear even by accident.
    const serialized = JSON.stringify(toScheduleViewModel([seoOccurrence()]));
    for (const forbidden of ["availability", "sales_status", "purchase_status", "AVAILABLE"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("returns an empty model for an empty snapshot rather than throwing", () => {
    expect(toScheduleViewModel([])).toEqual({ cities: [], upcomingCount: 0 });
  });
});
