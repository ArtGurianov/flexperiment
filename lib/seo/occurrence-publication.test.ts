import { describe, expect, it } from "vitest";

import {
  belongsInSitemap,
  eventStatusFor,
  findSnapshotDefects,
  findTransitionDefects,
  isUpcoming,
  judgeOccurrence,
  mayEmitEventSchema,
  publishableRecords,
} from "./occurrence-publication";
import { mintEventSlug, parseEventSlug } from "./event-slug";
import {
  isDeparted,
  SEO_SNAPSHOT_SCHEMA_VERSION,
  type SeoDeparture,
  type SeoSnapshot,
  type SeoTombstone,
} from "./occurrence-snapshot";
import { seoOccurrence } from "./public-occurrence-fixture";

const snapshot = (over: Partial<SeoSnapshot> = {}): SeoSnapshot => ({
  schema_version: SEO_SNAPSHOT_SCHEMA_VERSION,
  occurrences: [],
  tombstones: [],
  ...over,
});
const OTHER_ID = "99999999-2222-4333-8444-555555555555";

describe("judgeOccurrence", () => {
  it("publishes a sound occurrence with a confirmed venue", () => {
    expect(judgeOccurrence(seoOccurrence())).toEqual({ outcome: "PUBLISHABLE", reasons: [] });
  });

  it("rejects the timezone contradiction today's production record actually carries", () => {
    // The live /v1/public/tour fixture is a saint-petersburg occurrence whose
    // timezone says Asia/Novosibirsk. The catalogue says Europe/Moscow, and
    // city-catalog.test.ts already proves every catalogue zone is a real IANA
    // zone — so the catalogue is the oracle and this record is wrong.
    const verdict = judgeOccurrence(
      seoOccurrence({
        id: "727b3860-598c-43a3-8739-fd70d2e9deae",
        event_slug: "saint-petersburg-727b3860-598c-43a3-8739-fd70d2e9deae",
        city: "saint-petersburg",
        city_title: "Санкт-Петербург",
        timezone: "Asia/Novosibirsk",
      }),
    );
    expect(verdict.outcome).toBe("INVALID");
    expect(verdict.reasons).toContain("TIMEZONE_CONTRADICTS_CATALOGUE");
  });

  it("rejects an end that is not after the start, including an equal one", () => {
    const equal = seoOccurrence({ ends_at: seoOccurrence().starts_at });
    expect(judgeOccurrence(equal).reasons).toContain("ENDS_AT_NOT_AFTER_STARTS_AT");
    const before = seoOccurrence({ ends_at: "2030-03-14T09:00:00.000Z" });
    expect(judgeOccurrence(before).reasons).toContain("ENDS_AT_NOT_AFTER_STARTS_AT");
  });

  it("rejects a city outside the catalogue, an unparseable date and a non-positive price", () => {
    expect(judgeOccurrence(seoOccurrence({ city: "atlantis", event_slug: "atlantis-x" })).reasons)
      .toContain("CITY_NOT_IN_CATALOGUE");
    expect(judgeOccurrence(seoOccurrence({ starts_at: "не дата" })).reasons)
      .toContain("STARTS_AT_UNPARSEABLE");
    expect(judgeOccurrence(seoOccurrence({ price_kopecks: 0 })).reasons)
      .toContain("PRICE_NOT_A_POSITIVE_INTEGER");
  });

  it("rejects a slug that belongs to a different occurrence", () => {
    const stolen = seoOccurrence({
      event_slug: mintEventSlug("novosibirsk", "99999999-2222-4333-8444-555555555555"),
    });
    expect(judgeOccurrence(stolen).reasons).toContain("EVENT_SLUG_ID_MISMATCH");
  });

  it("withholds Event structured data for an unannounced venue but still publishes the page", () => {
    const tba = seoOccurrence({ venue: { status: "TO_BE_ANNOUNCED", name: null, address: null } });
    expect(judgeOccurrence(tba)).toEqual({
      outcome: "NOT_SCHEMA_ELIGIBLE",
      reasons: ["VENUE_TO_BE_ANNOUNCED"],
    });
  });

  it("withholds Event structured data for a confirmed venue with nothing to say", () => {
    const half = seoOccurrence({ venue: { status: "CONFIRMED", name: "Студия", address: null } });
    expect(judgeOccurrence(half).outcome).toBe("NOT_SCHEMA_ELIGIBLE");
  });
});

describe("eventStatusFor", () => {
  it("derives status from fulfillment only, never from sales state", () => {
    // This is the whole point of the function. A scheduled event whose sales
    // have not opened, are paused, or have sold out is still scheduled — the
    // snapshot does not even carry those fields, and nothing here may infer a
    // cancellation from them.
    expect(eventStatusFor(seoOccurrence())).toBe("https://schema.org/EventScheduled");
    expect(eventStatusFor(seoOccurrence({ fulfillment_status: "CANCELLED" })))
      .toBe("https://schema.org/EventCancelled");
    // Explicit decision: schema.org has no "already happened" status, so a
    // completed event stays EventScheduled with a past date.
    expect(eventStatusFor(seoOccurrence({ fulfillment_status: "COMPLETED" })))
      .toBe("https://schema.org/EventScheduled");
  });
});

describe("belongsInSitemap", () => {
  it("lists a scheduled event and omits cancelled, completed and invalid ones", () => {
    expect(belongsInSitemap(seoOccurrence())).toBe(true);
    expect(belongsInSitemap(seoOccurrence({ fulfillment_status: "CANCELLED" }))).toBe(false);
    expect(belongsInSitemap(seoOccurrence({ fulfillment_status: "COMPLETED" }))).toBe(false);
    expect(belongsInSitemap(seoOccurrence({ timezone: "Europe/Moscow" }))).toBe(false);
  });

  it("still lists a scheduled event whose venue is not announced yet", () => {
    // NOT_SCHEMA_ELIGIBLE withholds JSON-LD, not the page — and a page worth
    // generating is a page worth telling a crawler about.
    const tba = seoOccurrence({ venue: { status: "TO_BE_ANNOUNCED", name: null, address: null } });
    expect(belongsInSitemap(tba)).toBe(true);
  });
});

describe("findSnapshotDefects", () => {
  it("accepts an empty snapshot", () => {
    expect(findSnapshotDefects(snapshot())).toEqual([]);
  });

  it("rejects two occurrences sharing one URL", () => {
    const other = "99999999-2222-4333-8444-555555555555";
    const defects = findSnapshotDefects(
      snapshot({
        occurrences: [
          seoOccurrence(),
          seoOccurrence({ id: other, starts_at: "2030-04-14T11:00:00.000Z", ends_at: "2030-04-14T15:00:00.000Z" }),
        ],
      }),
    );
    expect(defects.map((defect) => defect.code)).toContain("SLUG_COLLISION");
  });

  it("rejects a record that is both live and tombstoned", () => {
    const defects = findSnapshotDefects(
      snapshot({
        occurrences: [seoOccurrence()],
        tombstones: [{ ...seoOccurrence(), departed: "CANCELLED" }],
      }),
    );
    expect(defects.map((defect) => defect.code)).toContain("TOMBSTONE_FOR_LIVE_OCCURRENCE");
  });

  it("rejects records that are not in the snapshot's declared order", () => {
    const later = seoOccurrence({
      id: "99999999-2222-4333-8444-555555555555",
      event_slug: mintEventSlug("novosibirsk", "99999999-2222-4333-8444-555555555555"),
      starts_at: "2030-09-14T11:00:00.000Z",
      ends_at: "2030-09-14T15:00:00.000Z",
    });
    const defects = findSnapshotDefects(snapshot({ occurrences: [later, seoOccurrence()] }));
    expect(defects.map((defect) => defect.code)).toContain("OUT_OF_ORDER");
  });
});

describe("findTransitionDefects", () => {
  it("accepts an occurrence that keeps its slug", () => {
    const previous = snapshot({ occurrences: [seoOccurrence()] });
    const next = snapshot({ occurrences: [seoOccurrence({ title: "FLEXPERIMENT II" })] });
    expect(findTransitionDefects(previous, next)).toEqual([]);
  });

  it("refuses a published id that disappears without a tombstone", () => {
    const previous = snapshot({ occurrences: [seoOccurrence()] });
    expect(findTransitionDefects(previous, snapshot()).map((defect) => defect.code))
      .toEqual(["PUBLISHED_ID_MISSING_TOMBSTONE"]);
  });

  it("accepts the same id once it has a tombstone", () => {
    const previous = snapshot({ occurrences: [seoOccurrence()] });
    const next = snapshot({ tombstones: [{ ...seoOccurrence(), departed: "CANCELLED" }] });
    expect(findTransitionDefects(previous, next)).toEqual([]);
  });

  it("refuses a slug recomputed because the city moved", () => {
    const previous = snapshot({ occurrences: [seoOccurrence()] });
    const recomputed = snapshot({
      occurrences: [
        seoOccurrence({
          city: "moscow",
          city_title: "Москва",
          timezone: "Europe/Moscow",
          event_slug: mintEventSlug("moscow", seoOccurrence().id),
        }),
      ],
    });
    expect(findTransitionDefects(previous, recomputed).map((defect) => defect.code))
      .toEqual(["PUBLISHED_SLUG_CHANGED"]);
  });
});

const DEPARTURES: readonly SeoDeparture[] = ["CANCELLED", "COMPLETED", "PAST", "WITHDRAWN"];

/**
 * A tombstone that is sound in every respect EXCEPT that it has left the tour.
 *
 * Crucially it keeps `fulfillment_status: "SCHEDULED"` unless overridden, which
 * is exactly what PAST and WITHDRAWN records really carry: that is the last
 * state Commerce reported for them. Every test below exists because a check
 * that looked only at the status would wave those through as upcoming events.
 */
const tombstone = (departed: SeoDeparture, over: Partial<SeoTombstone> = {}): SeoTombstone => ({
  ...seoOccurrence(),
  departed,
  ...over,
});

describe("departed records are never treated as upcoming", () => {
  it.each(DEPARTURES)("%s is excluded from the sitemap", (departed) => {
    const record = tombstone(departed);
    // The trap: nothing in the record's own status says it is archival.
    expect(record.fulfillment_status).toBe("SCHEDULED");
    expect(judgeOccurrence(record).outcome).toBe("PUBLISHABLE");
    expect(belongsInSitemap(record)).toBe(false);
    expect(isUpcoming(record)).toBe(false);
  });

  it("still lists the live record the tombstones are modelled on", () => {
    expect(belongsInSitemap(seoOccurrence())).toBe(true);
    expect(isUpcoming(seoOccurrence())).toBe(true);
  });

  it("keeps its page, which is the whole reason tombstones exist", () => {
    expect(publishableRecords(snapshot({ tombstones: [tombstone("WITHDRAWN")] }))).toHaveLength(1);
  });

  it("stays narrowable after passing through publishableRecords", () => {
    // The regression this guards: publishableRecords used to return
    // SeoOccurrence[], which compiles fine — SeoTombstone is structurally an
    // SeoOccurrence — and silently erased `departed` for every consumer.
    const records = publishableRecords(
      snapshot({ occurrences: [seoOccurrence()], tombstones: [tombstone("CANCELLED", { id: OTHER_ID, event_slug: mintEventSlug("novosibirsk", OTHER_ID) })] }),
    );
    expect(records.filter(isDeparted)).toHaveLength(1);
    expect(records.filter((record) => !isDeparted(record))).toHaveLength(1);
  });
});

describe("mayEmitEventSchema", () => {
  it("emits for a live, fully specified occurrence", () => {
    expect(mayEmitEventSchema(seoOccurrence())).toBe(true);
  });

  it("withholds for WITHDRAWN, where Commerce no longer acknowledges the event", () => {
    // /v1/public/occurrences/{id} answered 404, so the snapshot is holding the
    // last data it ever saw. Its stale SCHEDULED status would otherwise produce
    // EventScheduled markup for something the authoritative system does not
    // serve at all.
    expect(mayEmitEventSchema(tombstone("WITHDRAWN"))).toBe(false);
  });

  it("keeps emitting for departures whose facts were re-read from Commerce", () => {
    // For these the re-fetch succeeded and the record was re-projected from the
    // live response, so its facts are current.
    expect(mayEmitEventSchema(tombstone("CANCELLED", { fulfillment_status: "CANCELLED" }))).toBe(true);
    expect(eventStatusFor(tombstone("CANCELLED", { fulfillment_status: "CANCELLED" })))
      .toBe("https://schema.org/EventCancelled");
    expect(mayEmitEventSchema(tombstone("COMPLETED", { fulfillment_status: "COMPLETED" }))).toBe(true);
    expect(mayEmitEventSchema(tombstone("PAST"))).toBe(true);
  });

  it("still withholds for an unannounced venue, departed or not", () => {
    const tba = { status: "TO_BE_ANNOUNCED", name: null, address: null } as const;
    expect(mayEmitEventSchema(seoOccurrence({ venue: tba }))).toBe(false);
    expect(mayEmitEventSchema(tombstone("CANCELLED", { venue: tba }))).toBe(false);
  });
});

describe("event slugs", () => {
  it("round-trips a city slug that contains dashes", () => {
    const slug = mintEventSlug("rostov-on-don", "11111111-2222-4333-8444-555555555555");
    expect(parseEventSlug(slug)).toEqual({
      city: "rostov-on-don",
      id: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("keeps the full uuid rather than truncating it", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(mintEventSlug("novosibirsk", id).endsWith(id)).toBe(true);
  });

  it("refuses to mint for an unknown city or a malformed id", () => {
    expect(() => mintEventSlug("atlantis", "11111111-2222-4333-8444-555555555555")).toThrow("UNKNOWN_CITY");
    expect(() => mintEventSlug("novosibirsk", "not-a-uuid")).toThrow("INVALID_ID");
  });

  it("returns null rather than guessing at anything malformed", () => {
    expect(parseEventSlug("novosibirsk")).toBeNull();
    expect(parseEventSlug("atlantis-11111111-2222-4333-8444-555555555555")).toBeNull();
    expect(parseEventSlug("novosibirsk-11111111222243338444555555555555")).toBeNull();
  });
});
