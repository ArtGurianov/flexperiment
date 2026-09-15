import { findCityBySlug } from "@/lib/city-catalog";
import { isOccurrenceId, parseEventSlug } from "@/lib/seo/event-slug";
import {
  compareOccurrences,
  type SeoOccurrence,
  type SeoSnapshot,
} from "@/lib/seo/occurrence-snapshot";

/**
 * Whether an occurrence may be published, and how far.
 *
 *   INVALID              The record contradicts itself or the city catalogue.
 *                        No page is generated, and the generator FAILS rather
 *                        than skipping it when the source is production — a
 *                        contradiction in live inventory is an operator
 *                        problem to fix, not a record to quietly drop.
 *   NOT_SCHEMA_ELIGIBLE  The record is sound but cannot carry Event structured
 *                        data. The page is generated; the JSON-LD is withheld.
 *                        Google requires a real `location` on an Event, and a
 *                        page that says "площадка уточняется" in prose while
 *                        asserting a venue in markup is the one outcome worse
 *                        than emitting nothing.
 *   PUBLISHABLE          Page and Event JSON-LD.
 *
 * Note what does NOT appear anywhere below: `sales_status` and
 * `purchase_status`. Sales state and fulfillment state are orthogonal
 * dimensions — a SCHEDULED event with sales CLOSED is a real, correct, very
 * common state, and reading "no sales" as "not happening" is how a live event
 * ends up marked EventCancelled in search results.
 */
export type PublicationOutcome = "INVALID" | "NOT_SCHEMA_ELIGIBLE" | "PUBLISHABLE";

export type PublicationVerdict = {
  readonly outcome: PublicationOutcome;
  /** SCREAMING_SNAKE reason codes, stable enough to assert on. Sorted. */
  readonly reasons: readonly string[];
};

const timestampMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
};

/**
 * Judges one occurrence in isolation.
 *
 * `event_slug` is checked here too, because a slug that does not belong to this
 * record is as much a contradiction as a bad date: it would publish this
 * occurrence at another one's URL.
 */
export function judgeOccurrence(occurrence: SeoOccurrence): PublicationVerdict {
  const invalid: string[] = [];

  if (!isOccurrenceId(occurrence.id)) invalid.push("ID_NOT_A_UUID");

  const city = findCityBySlug(occurrence.city);
  if (!city) {
    invalid.push("CITY_NOT_IN_CATALOGUE");
  } else {
    // The catalogue is the authority on a city's zone — every entry in it is
    // asserted against Intl.supportedValuesOf("timeZone") by
    // lib/city-catalog.test.ts, so this comparison has a real oracle behind it.
    // A record claiming Asia/Novosibirsk for saint-petersburg is not a
    // formatting preference; it is wrong, and it would render a wrong time on
    // a page that people plan travel around.
    if (occurrence.timezone !== city.timezone) invalid.push("TIMEZONE_CONTRADICTS_CATALOGUE");
    if (occurrence.city_title !== city.title) invalid.push("CITY_TITLE_CONTRADICTS_CATALOGUE");
  }

  const startsAt = timestampMs(occurrence.starts_at);
  const endsAt = timestampMs(occurrence.ends_at);
  if (Number.isNaN(startsAt)) invalid.push("STARTS_AT_UNPARSEABLE");
  if (Number.isNaN(endsAt)) invalid.push("ENDS_AT_UNPARSEABLE");
  if (!Number.isNaN(startsAt) && !Number.isNaN(endsAt) && endsAt <= startsAt) {
    invalid.push("ENDS_AT_NOT_AFTER_STARTS_AT");
  }

  if (!Number.isSafeInteger(occurrence.price_kopecks) || occurrence.price_kopecks <= 0) {
    invalid.push("PRICE_NOT_A_POSITIVE_INTEGER");
  }

  if (occurrence.title.trim().length === 0) invalid.push("TITLE_BLANK");

  const parsedSlug = parseEventSlug(occurrence.event_slug);
  if (!parsedSlug) invalid.push("EVENT_SLUG_MALFORMED");
  else if (parsedSlug.id !== occurrence.id) invalid.push("EVENT_SLUG_ID_MISMATCH");

  if (invalid.length > 0) return { outcome: "INVALID", reasons: invalid.sort() };

  // Sound, but is there a location to put in the markup?
  const withheld: string[] = [];
  if (occurrence.venue.status === "TO_BE_ANNOUNCED") withheld.push("VENUE_TO_BE_ANNOUNCED");
  else if (!occurrence.venue.name || !occurrence.venue.address) withheld.push("VENUE_INCOMPLETE");

  return withheld.length > 0
    ? { outcome: "NOT_SCHEMA_ELIGIBLE", reasons: withheld }
    : { outcome: "PUBLISHABLE", reasons: [] };
}

/**
 * The schema.org `eventStatus` for an occurrence.
 *
 * Derived from `fulfillment_status` and nothing else. See the note on
 * PublicationOutcome above: sales state is a different dimension, and
 * NOT_YET_OPEN, SOLD_OUT or a paused gate must never imply EventCancelled.
 *
 * COMPLETED is the awkward one, and the decision is explicit rather than
 * incidental: schema.org has no "this already happened" event status.
 * EventScheduled with a start date in the past is the truthful reading —
 * the event was scheduled, and it occurred — so that is what is emitted, and
 * the page is dropped from the sitemap instead (see app/sitemap.ts).
 *
 * KNOWN GAP, documented rather than worked around: EventRescheduled with
 * `previousStartDate` can never be emitted from this data. commerce/migrations/
 * 0001_initial.sql:27 constrains fulfillment_status to SCHEDULED | COMPLETED |
 * CANCELLED, with no postponed/rescheduled state, so a date change mutates
 * `starts_at` in place and the previous start time is not retained anywhere the
 * snapshot can see.
 */
export const eventStatusFor = (occurrence: SeoOccurrence): string =>
  occurrence.fulfillment_status === "CANCELLED"
    ? "https://schema.org/EventCancelled"
    : "https://schema.org/EventScheduled";

/**
 * Whether a record belongs in the sitemap.
 *
 * Present-tense pages only: a cancelled or finished event keeps its URL (so an
 * indexed link and a printed ticket keep working) but stops being something to
 * offer a crawler as fresh content.
 */
export const belongsInSitemap = (occurrence: SeoOccurrence): boolean =>
  occurrence.fulfillment_status === "SCHEDULED" &&
  judgeOccurrence(occurrence).outcome !== "INVALID";

export type SnapshotDefect = { readonly code: string; readonly detail: string };

/**
 * Whole-snapshot rules — the ones no single record can violate on its own.
 *
 * Returns every defect rather than the first, because an operator fixing a
 * snapshot wants the list, not a game of whack-a-mole.
 */
export function findSnapshotDefects(snapshot: SeoSnapshot): readonly SnapshotDefect[] {
  const defects: SnapshotDefect[] = [];
  const all: readonly SeoOccurrence[] = [...snapshot.occurrences, ...snapshot.tombstones];

  const bySlug = new Map<string, string>();
  const ids = new Set<string>();
  for (const entry of all) {
    const existing = bySlug.get(entry.event_slug);
    if (existing !== undefined && existing !== entry.id) {
      defects.push({ code: "SLUG_COLLISION", detail: `${entry.event_slug} (${existing} vs ${entry.id})` });
    }
    bySlug.set(entry.event_slug, entry.id);

    if (ids.has(entry.id)) defects.push({ code: "DUPLICATE_ID", detail: entry.id });
    ids.add(entry.id);

    const verdict = judgeOccurrence(entry);
    if (verdict.outcome === "INVALID") {
      defects.push({ code: "OCCURRENCE_INVALID", detail: `${entry.id}: ${verdict.reasons.join(",")}` });
    }
  }

  // A live record and a tombstone for the same occurrence are contradictory
  // states: it is either in the public tour or it has left it.
  const liveIds = new Set(snapshot.occurrences.map((entry) => entry.id));
  for (const tombstone of snapshot.tombstones) {
    if (liveIds.has(tombstone.id)) {
      defects.push({ code: "TOMBSTONE_FOR_LIVE_OCCURRENCE", detail: tombstone.id });
    }
  }

  for (const [label, list] of [
    ["occurrences", snapshot.occurrences],
    ["tombstones", snapshot.tombstones],
  ] as const) {
    for (let index = 1; index < list.length; index += 1) {
      if (compareOccurrences(list[index - 1], list[index]) > 0) {
        defects.push({ code: "OUT_OF_ORDER", detail: `${label}[${index}]` });
      }
    }
  }

  return defects;
}

export type TransitionDefect = SnapshotDefect;

/**
 * Rules that only exist relative to what was previously published.
 *
 * The generator runs this before writing, so a regeneration that would break a
 * live URL fails instead of producing the breakage. It is a separate function
 * from `findSnapshotDefects` because the validate-only CLI reads one committed
 * file and has no previous version to compare against — the two questions are
 * genuinely different, and pretending otherwise would mean the standalone
 * validator could never be run at all.
 */
export function findTransitionDefects(
  previous: SeoSnapshot,
  next: SeoSnapshot,
): readonly TransitionDefect[] {
  const defects: TransitionDefect[] = [];
  const publishedSlugs = new Map<string, string>();
  for (const entry of [...previous.occurrences, ...previous.tombstones]) {
    publishedSlugs.set(entry.id, entry.event_slug);
  }

  const nextById = new Map<string, SeoOccurrence>();
  for (const entry of [...next.occurrences, ...next.tombstones]) nextById.set(entry.id, entry);

  for (const [id, slug] of publishedSlugs) {
    const current = nextById.get(id);
    if (!current) {
      // The URL is already public. Dropping the record outright would 404 it;
      // a tombstone is the only sanctioned way for an occurrence to leave the
      // live list.
      defects.push({ code: "PUBLISHED_ID_MISSING_TOMBSTONE", detail: id });
      continue;
    }
    if (current.event_slug !== slug) {
      // Almost always this means the city changed and the slug was recomputed.
      // The page content follows the move; the URL does not.
      defects.push({ code: "PUBLISHED_SLUG_CHANGED", detail: `${id}: ${slug} -> ${current.event_slug}` });
    }
  }

  return defects;
}

/** Every tombstone reachable as a page, ordered for stable route generation. */
export const publishableRecords = (snapshot: SeoSnapshot): readonly SeoOccurrence[] =>
  [...snapshot.occurrences, ...snapshot.tombstones]
    .filter((entry) => judgeOccurrence(entry).outcome !== "INVALID")
    .sort(compareOccurrences);
