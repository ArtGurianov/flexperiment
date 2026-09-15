/**
 * The SEO occurrence snapshot: the committed, build-time-readable projection of
 * Commerce's public tour that static event and city pages are generated from.
 *
 * Server-safe and dependency-light on purpose — no `"use client"`, no `node:`
 * imports — so it can be read by a Server Component during `next build`, by the
 * commerce CLIs, and by tests in the vitest `node` project alike.
 *
 * WHAT IS IN HERE AND WHY IT IS ONLY THIS
 *
 * Every field below is a durable fact: it changes when an operator deliberately
 * changes it, and a change is expected to be accompanied by a regenerated
 * snapshot, a committed diff and a frontend release.
 *
 * Three fields of the public occurrence are deliberately excluded —
 * `availability`, `purchase_status` and `sales_status`. commerce/src/domain.ts
 * derives them from `this.clock()`, a live `COUNT(*)` over bookings and the
 * sales gate. They are correct for the instant they were computed and for no
 * other instant, so freezing them into static HTML would publish a claim about
 * seats and sales that is wrong by the time anyone reads it. They stay
 * client-hydrated, exactly as CheckoutFlow already fetches them.
 *
 * Commerce remains authoritative for all of it. Nothing here is a source of
 * truth; it is a build-time copy, and the refresh obligation
 * (docs/release/SEO_SURFACE_SNAPSHOT.md) is what keeps it honest.
 */

/** Bumped only when the on-disk shape changes incompatibly. */
export const SEO_SNAPSHOT_SCHEMA_VERSION = 1;

export type SeoVenueStatus = "CONFIRMED" | "TO_BE_ANNOUNCED";
export type SeoFulfillmentStatus = "SCHEDULED" | "COMPLETED" | "CANCELLED";

/**
 * The publicly disclosable venue.
 *
 * `disclosure_text` and `announce_by` are not carried: they are the wording
 * Commerce composes for the checkout dialog, and an event page states the venue
 * or truthfully says it is not yet announced. It never restates a promise about
 * when an email will go out.
 */
export type SeoVenue = {
  readonly status: SeoVenueStatus;
  readonly name: string | null;
  readonly address: string | null;
};

export type SeoOccurrence = {
  readonly id: string;
  /** Frozen at first publication. See lib/seo/event-slug.ts. */
  readonly event_slug: string;
  readonly city: string;
  readonly city_title: string;
  readonly title: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly timezone: string;
  readonly price_kopecks: number;
  readonly fulfillment_status: SeoFulfillmentStatus;
  readonly venue: SeoVenue;
};

/**
 * Why an occurrence is no longer in `/v1/public/tour`.
 *
 * `tour()` filters to `fulfillment_status = 'SCHEDULED'` AND `starts_at > now`,
 * so disappearing from it is ambiguous on its own — these four values are the
 * disambiguation, and each is read from `/v1/public/occurrences/{id}`, which
 * applies no such filter.
 *
 *   CANCELLED  the occurrence reports fulfillment_status CANCELLED
 *   COMPLETED  it reports COMPLETED
 *   PAST       it is still SCHEDULED, but its start time has passed
 *   WITHDRAWN  Commerce no longer exposes it at all (404 / unpublished)
 *
 * A tombstone exists so the page keeps answering. An event URL that has been
 * indexed, shared and printed on a ticket must not start 404ing because the
 * date came and went.
 */
export type SeoDeparture = "CANCELLED" | "COMPLETED" | "PAST" | "WITHDRAWN";

export type SeoTombstone = SeoOccurrence & {
  readonly departed: SeoDeparture;
};

/**
 * Anything that gets a page: a live occurrence or a tombstone.
 *
 * This union, and not a flattened `SeoOccurrence[]`, is what the rendering
 * layer must receive. A tombstone IS structurally an occurrence — it is
 * `SeoOccurrence & { departed }` — so widening it to the base type compiles
 * cleanly and silently loses the one field that says the record is archival.
 *
 * Losing it is not cosmetic. A WITHDRAWN or PAST tombstone keeps
 * `fulfillment_status: "SCHEDULED"` (that is the last state Commerce reported),
 * so with `departed` discarded it is indistinguishable from an event happening
 * next week: it would offer booking, claim a place in the sitemap, and emit
 * EventScheduled markup for an occurrence Commerce may no longer serve at all.
 *
 * `isDeparted` is the narrowing gate. Every consumer that renders, lists, links
 * to, or describes a record goes through it.
 */
export type PublishedRecord = SeoOccurrence | SeoTombstone;

export const isDeparted = (record: PublishedRecord): record is SeoTombstone =>
  "departed" in record;

export type SeoSnapshot = {
  readonly schema_version: number;
  /** Currently in `/v1/public/tour`. Sorted by starts_at, then city, then id. */
  readonly occurrences: readonly SeoOccurrence[];
  /** Previously published, no longer in the tour. Sorted identically. */
  readonly tombstones: readonly SeoTombstone[];
};

/** An empty but structurally valid snapshot — the fail-closed starting point. */
export const EMPTY_SNAPSHOT: SeoSnapshot = {
  schema_version: SEO_SNAPSHOT_SCHEMA_VERSION,
  occurrences: [],
  tombstones: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const VENUE_STATUSES: readonly string[] = ["CONFIRMED", "TO_BE_ANNOUNCED"];
const FULFILLMENT_STATUSES: readonly string[] = ["SCHEDULED", "COMPLETED", "CANCELLED"];
const DEPARTURES: readonly string[] = ["CANCELLED", "COMPLETED", "PAST", "WITHDRAWN"];

/** The message a malformed snapshot throws, so callers can match on one code. */
export class SnapshotParseError extends Error {
  constructor(readonly detail: string) {
    super(`SEO_SNAPSHOT_MALFORMED:${detail}`);
    this.name = "SnapshotParseError";
  }
}

const parseVenue = (value: unknown, at: string): SeoVenue => {
  if (!isObject(value)) throw new SnapshotParseError(`${at}.venue`);
  const { status, name, address } = value;
  if (typeof status !== "string" || !VENUE_STATUSES.includes(status)) {
    throw new SnapshotParseError(`${at}.venue.status`);
  }
  if (!nullableString(name)) throw new SnapshotParseError(`${at}.venue.name`);
  if (!nullableString(address)) throw new SnapshotParseError(`${at}.venue.address`);
  return { status: status as SeoVenueStatus, name, address };
};

const parseOccurrence = (value: unknown, at: string): SeoOccurrence => {
  if (!isObject(value)) throw new SnapshotParseError(at);
  for (const key of ["id", "event_slug", "city", "city_title", "title", "starts_at", "ends_at", "timezone"]) {
    if (!isNonEmptyString(value[key])) throw new SnapshotParseError(`${at}.${key}`);
  }
  const price = value.price_kopecks;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 0) {
    throw new SnapshotParseError(`${at}.price_kopecks`);
  }
  const fulfillment = value.fulfillment_status;
  if (typeof fulfillment !== "string" || !FULFILLMENT_STATUSES.includes(fulfillment)) {
    throw new SnapshotParseError(`${at}.fulfillment_status`);
  }
  return {
    id: value.id as string,
    event_slug: value.event_slug as string,
    city: value.city as string,
    city_title: value.city_title as string,
    title: value.title as string,
    starts_at: value.starts_at as string,
    ends_at: value.ends_at as string,
    timezone: value.timezone as string,
    price_kopecks: price,
    fulfillment_status: fulfillment as SeoFulfillmentStatus,
    venue: parseVenue(value.venue, at),
  };
};

const parseTombstone = (value: unknown, at: string): SeoTombstone => {
  const occurrence = parseOccurrence(value, at);
  const departed = (value as Record<string, unknown>).departed;
  if (typeof departed !== "string" || !DEPARTURES.includes(departed)) {
    throw new SnapshotParseError(`${at}.departed`);
  }
  return { ...occurrence, departed: departed as SeoDeparture };
};

/**
 * Parses arbitrary JSON into a snapshot, or throws `SnapshotParseError`.
 *
 * Deliberately total and deliberately strict: this is the only door into the
 * type, so a build that reads a corrupted or hand-edited snapshot fails loudly
 * at the read rather than half-generating pages from partial data. It checks
 * shape only — cross-record rules (slug uniqueness, sort order, city/timezone
 * agreement) belong to lib/seo/occurrence-publication.ts.
 */
export function parseSnapshot(value: unknown): SeoSnapshot {
  if (!isObject(value)) throw new SnapshotParseError("root");
  if (value.schema_version !== SEO_SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotParseError(`schema_version:${String(value.schema_version)}`);
  }
  if (!Array.isArray(value.occurrences)) throw new SnapshotParseError("occurrences");
  if (!Array.isArray(value.tombstones)) throw new SnapshotParseError("tombstones");
  return {
    schema_version: SEO_SNAPSHOT_SCHEMA_VERSION,
    occurrences: value.occurrences.map((entry, index) => parseOccurrence(entry, `occurrences[${index}]`)),
    tombstones: value.tombstones.map((entry, index) => parseTombstone(entry, `tombstones[${index}]`)),
  };
}

/**
 * The snapshot's total order: `starts_at`, then `city`, then `id`.
 *
 * Exported because both the generator (which produces the order) and the
 * validator (which proves it) must agree on exactly one comparison, and a
 * second, subtly different copy of it is how a "deterministic" artifact starts
 * churning between runs.
 */
export const compareOccurrences = (a: SeoOccurrence, b: SeoOccurrence): number =>
  a.starts_at < b.starts_at ? -1
    : a.starts_at > b.starts_at ? 1
      : a.city < b.city ? -1
        : a.city > b.city ? 1
          : a.id < b.id ? -1
            : a.id > b.id ? 1
              : 0;
