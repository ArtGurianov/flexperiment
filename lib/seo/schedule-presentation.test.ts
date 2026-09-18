import { describe, expect, it } from "vitest";

import { getCityBySlug, type CitySlug } from "@/lib/city-catalog";
import type { SeoDeparture, SeoTombstone } from "@/lib/seo/occurrence-snapshot";
import { seoOccurrence } from "@/lib/seo/public-occurrence-fixture";
import {
  actionableUpcomingEvents,
  archivedEvents,
  scheduledCitySlugs,
} from "@/lib/seo/schedule-presentation";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import type { ScheduleViewModel } from "@/lib/seo/schedule-view-model";

/**
 * The ordering contract the two catalogue surfaces share.
 *
 * These are unit tests over a pure function, and they are deliberately NOT the
 * whole story: the previous version of this feature had a green model suite
 * while the rendered drawer showed something else entirely, because nothing
 * asserted what reached the screen. ScheduleDrawerView.dom.test.tsx is the
 * other half, and it is the half that would have caught that.
 */
const at = (city: CitySlug, cityTitle: string, startsAt: string, id: string) =>
  seoOccurrence({
    id,
    event_slug: `${city}-${id}`,
    city,
    city_title: cityTitle,
    starts_at: startsAt,
    // Two hours later, and the city's OWN zone: the snapshot validator rejects
    // a record whose end is not after its start, or whose timezone contradicts
    // its city, and a rejected record is never `upcoming` at all.
    ends_at: new Date(Date.parse(startsAt) + 2 * 60 * 60 * 1000).toISOString(),
    timezone: getCityBySlug(city).timezone,
  });

/** A date that has left the tour — which is what puts it in the archive. */
const departed = (
  city: CitySlug,
  cityTitle: string,
  startsAt: string,
  id: string,
  reason: SeoDeparture = "PAST",
): SeoTombstone => ({ ...at(city, cityTitle, startsAt, id), departed: reason });

const SPB_SEP = at("saint-petersburg", "Санкт-Петербург", "2030-09-25T10:00:00.000Z", "aaaaaaaa-0000-4000-8000-000000000001");
const NSK_OCT_2 = at("novosibirsk", "Новосибирск", "2030-10-02T10:00:00.000Z", "bbbbbbbb-0000-4000-8000-000000000002");
const SPB_OCT_18 = at("saint-petersburg", "Санкт-Петербург", "2030-10-18T10:00:00.000Z", "cccccccc-0000-4000-8000-000000000003");
const TOMSK_OCT_25 = at("tomsk", "Томск", "2030-10-25T10:00:00.000Z", "dddddddd-0000-4000-8000-000000000004");

const tour = () => toScheduleViewModel([SPB_SEP, NSK_OCT_2, SPB_OCT_18, TOMSK_OCT_25]);

const labels = (model: ScheduleViewModel) =>
  actionableUpcomingEvents(model).map((event) => `${event.cityTitle} ${event.startsAt.slice(0, 10)}`);

describe("actionableUpcomingEvents", () => {
  it("flattens every city into one global chronology, not a city index", () => {
    // The model groups by city because publication does; the picker must not.
    expect(labels(tour())).toEqual([
      "Санкт-Петербург 2030-09-25",
      "Новосибирск 2030-10-02",
      "Санкт-Петербург 2030-10-18",
      "Томск 2030-10-25",
    ]);
  });

  it("breaks a tie on id, so two cities on the same evening have one order", () => {
    const sameInstant = "2030-07-01T10:00:00.000Z";
    const later = at("kazan", "Казань", sameInstant, "ffffffff-0000-4000-8000-000000000009");
    const earlier = at("omsk", "Омск", sameInstant, "00000000-0000-4000-8000-000000000008");
    // Fed in the opposite order to the one expected, so a comparator returning
    // 0 for equal instants would leave them as given and fail.
    const model = toScheduleViewModel([later, earlier]);
    expect(actionableUpcomingEvents(model).map((event) => event.id)).toEqual([earlier.id, later.id]);
  });

  it("drops NOT_IN_LIVE_TOUR without moving it into the archive", () => {
    const model = tour();
    const downgraded: ScheduleViewModel = {
      ...model,
      cities: model.cities.map((city) => ({
        ...city,
        upcoming: city.upcoming.map((event) =>
          event.id === NSK_OCT_2.id ? { ...event, listing: "NOT_IN_LIVE_TOUR" as const } : event,
        ),
      })),
    };

    expect(labels(downgraded)).toEqual([
      "Санкт-Петербург 2030-09-25",
      "Санкт-Петербург 2030-10-18",
      "Томск 2030-10-25",
    ]);
    // Absence from the live tour is ambiguous; it is not a cancellation.
    expect(archivedEvents(downgraded)).toEqual([]);
  });

  it("never reorders the model it was given", () => {
    const model = tour();
    const before = model.cities.map((city) => city.upcoming.map((event) => event.id));
    actionableUpcomingEvents(model);
    archivedEvents(model);
    expect(model.cities.map((city) => city.upcoming.map((event) => event.id))).toEqual(before);
  });
});

describe("archivedEvents", () => {
  it("collects departed dates across cities, most recent first", () => {
    const past = departed("moscow", "Москва", "2020-01-01T10:00:00.000Z", "eeeeeeee-0000-4000-8000-000000000005");
    const morePast = departed("kazan", "Казань", "2021-01-01T10:00:00.000Z", "eeeeeeee-0000-4000-8000-000000000006", "CANCELLED");
    const model = toScheduleViewModel([past, morePast, SPB_SEP]);

    expect(archivedEvents(model).map((event) => event.id)).toEqual([morePast.id, past.id]);
    // And they stay out of the picker.
    expect(actionableUpcomingEvents(model).map((event) => event.id)).toEqual([SPB_SEP.id]);
  });
});

describe("scheduledCitySlugs", () => {
  it("names only cities that still have a bookable date", () => {
    expect([...scheduledCitySlugs(tour())].sort()).toEqual([
      "novosibirsk",
      "saint-petersburg",
      "tomsk",
    ]);
  });

  it("omits a city whose only dates have departed", () => {
    const past = departed("moscow", "Москва", "2020-01-01T10:00:00.000Z", "eeeeeeee-0000-4000-8000-000000000007");
    expect(scheduledCitySlugs(toScheduleViewModel([past]))).toEqual([]);
  });
});
