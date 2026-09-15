import {
  compareOccurrences,
  SEO_SNAPSHOT_SCHEMA_VERSION,
  type SeoDeparture,
  type SeoFulfillmentStatus,
  type SeoOccurrence,
  type SeoSnapshot,
  type SeoTombstone,
  type SeoVenueStatus,
} from "@/lib/seo/occurrence-snapshot";
import { mintEventSlug } from "@/lib/seo/event-slug";

/**
 * The `/v1/public/tour` and `/v1/public/occurrences/{id}` response contract, as
 * this repository expects to receive it.
 *
 * Declared here rather than reused from commerce/src/types.ts on purpose: this
 * is the shape of a wire response from a separately deployed service, and the
 * point of parsing against it is to notice when the two have drifted. Sharing
 * the producer's type would make that impossible by construction.
 */
export type PublicOccurrence = {
  id: string;
  city: string;
  city_title: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  price_kopecks: number;
  availability: number;
  sales_status: "OPEN" | "PAUSED" | "CLOSED";
  fulfillment_status: SeoFulfillmentStatus;
  purchase_status: "AVAILABLE" | "SOLD_OUT" | "NOT_YET_OPEN" | "TEMPORARILY_PAUSED" | "UNAVAILABLE";
  venue: {
    status: SeoVenueStatus;
    name: string | null;
    address: string | null;
    disclosure_text: string | null;
    announce_by: string | null;
  };
};

/** What the generator was handed, whether over HTTP or from a fixture file. */
export type PublicTourSource = {
  /** The `cities` array of GET /v1/public/tour. */
  readonly tour: readonly PublicOccurrence[];
  /**
   * GET /v1/public/occurrences/{id} for each previously published id that is
   * no longer in `tour`. `null` means the endpoint answered 404 — Commerce no
   * longer exposes that occurrence at all.
   */
  readonly departed: ReadonlyMap<string, PublicOccurrence | null>;
};

export class SourceContractError extends Error {
  constructor(readonly detail: string) {
    super(`SEO_SNAPSHOT_SOURCE_MALFORMED:${detail}`);
    this.name = "SourceContractError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown, at: string): string => {
  if (typeof value !== "string") throw new SourceContractError(at);
  return value;
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], at: string): T => {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new SourceContractError(at);
  }
  return value as T;
};

/**
 * Parses one wire occurrence against the contract above.
 *
 * Strict, and never best-effort: a field that is missing or the wrong type
 * means the producer changed shape, and generating a snapshot from a response
 * this code no longer understands is how a page ends up asserting `undefined`
 * as a commercial fact. It throws; the CLI turns that into a non-zero exit.
 */
export function parsePublicOccurrence(value: unknown, at: string): PublicOccurrence {
  if (!isObject(value)) throw new SourceContractError(at);
  if (!isObject(value.venue)) throw new SourceContractError(`${at}.venue`);
  if (typeof value.price_kopecks !== "number") throw new SourceContractError(`${at}.price_kopecks`);
  if (typeof value.availability !== "number") throw new SourceContractError(`${at}.availability`);

  const venue = value.venue;
  const nullable = (raw: unknown, key: string): string | null => {
    if (raw === null) return null;
    if (typeof raw === "string") return raw;
    throw new SourceContractError(`${at}.venue.${key}`);
  };

  return {
    id: str(value.id, `${at}.id`),
    city: str(value.city, `${at}.city`),
    city_title: str(value.city_title, `${at}.city_title`),
    title: str(value.title, `${at}.title`),
    starts_at: str(value.starts_at, `${at}.starts_at`),
    ends_at: str(value.ends_at, `${at}.ends_at`),
    timezone: str(value.timezone, `${at}.timezone`),
    price_kopecks: value.price_kopecks,
    availability: value.availability,
    sales_status: oneOf(value.sales_status, ["OPEN", "PAUSED", "CLOSED"] as const, `${at}.sales_status`),
    fulfillment_status: oneOf(value.fulfillment_status, ["SCHEDULED", "COMPLETED", "CANCELLED"] as const, `${at}.fulfillment_status`),
    purchase_status: oneOf(value.purchase_status, ["AVAILABLE", "SOLD_OUT", "NOT_YET_OPEN", "TEMPORARILY_PAUSED", "UNAVAILABLE"] as const, `${at}.purchase_status`),
    venue: {
      status: oneOf(venue.status, ["CONFIRMED", "TO_BE_ANNOUNCED"] as const, `${at}.venue.status`),
      name: nullable(venue.name, "name"),
      address: nullable(venue.address, "address"),
      disclosure_text: nullable(venue.disclosure_text, "disclosure_text"),
      announce_by: nullable(venue.announce_by, "announce_by"),
    },
  };
}

/** Parses a whole `GET /v1/public/tour` body. */
export function parsePublicTour(value: unknown): readonly PublicOccurrence[] {
  if (!isObject(value)) throw new SourceContractError("tour");
  if (!Array.isArray(value.cities)) throw new SourceContractError("tour.cities");
  return value.cities.map((entry, index) => parsePublicOccurrence(entry, `tour.cities[${index}]`));
}

/**
 * The single normalizer both sources feed into.
 *
 * `--source <url>` and `--input <file>` differ only in how the bytes arrive;
 * everything after that — the projection to the durable subset, the slug
 * lifecycle, the ordering — happens exactly once, here. That is what makes a
 * fixture-driven CI test meaningful evidence about the production path.
 */
const project = (
  wire: PublicOccurrence,
  eventSlug: string,
): SeoOccurrence => ({
  id: wire.id,
  event_slug: eventSlug,
  city: wire.city,
  city_title: wire.city_title,
  title: wire.title,
  starts_at: wire.starts_at,
  ends_at: wire.ends_at,
  timezone: wire.timezone,
  price_kopecks: wire.price_kopecks,
  fulfillment_status: wire.fulfillment_status,
  // Deliberately drops disclosure_text and announce_by; see SeoVenue.
  venue: { status: wire.venue.status, name: wire.venue.name, address: wire.venue.address },
});

/**
 * How an occurrence that is no longer in the tour left it.
 *
 * `null` means /v1/public/occurrences/{id} answered 404. Otherwise the record
 * still exists and says so itself — and a still-SCHEDULED record missing from
 * the tour was filtered out for having started, which `tour()` does with
 * `starts_at > now`.
 */
const departureOf = (current: PublicOccurrence | null, nowMs: number): SeoDeparture => {
  if (!current) return "WITHDRAWN";
  if (current.fulfillment_status === "CANCELLED") return "CANCELLED";
  if (current.fulfillment_status === "COMPLETED") return "COMPLETED";
  return Date.parse(current.starts_at) <= nowMs ? "PAST" : "WITHDRAWN";
};

/**
 * Builds the next snapshot from a source reading and the previously committed
 * one.
 *
 * The previous snapshot is not optional context — it is where frozen slugs
 * live. An occurrence that has ever been published keeps the `event_slug` it
 * was published under, whatever its city says today; only a genuinely new
 * occurrence gets a freshly minted one.
 */
export function buildSnapshot({
  source,
  previous,
  nowMs,
}: {
  source: PublicTourSource;
  previous: SeoSnapshot;
  nowMs: number;
}): SeoSnapshot {
  const frozenSlugs = new Map<string, string>();
  for (const entry of [...previous.occurrences, ...previous.tombstones]) {
    frozenSlugs.set(entry.id, entry.event_slug);
  }

  const slugFor = (wire: PublicOccurrence): string =>
    frozenSlugs.get(wire.id) ?? mintEventSlug(wire.city, wire.id);

  const occurrences = source.tour.map((wire) => project(wire, slugFor(wire)));

  const live = new Set(occurrences.map((entry) => entry.id));
  const tombstones: SeoTombstone[] = [];
  for (const previousEntry of [...previous.occurrences, ...previous.tombstones]) {
    if (live.has(previousEntry.id)) continue;
    // `has` before `get`, and the distinction is the whole point of the source
    // contract. An explicit `null` means the endpoint was queried and answered
    // 404 — Commerce no longer exposes this occurrence. An ABSENT key means
    // nothing was ever looked up, which is a different fact entirely and one
    // this function cannot repair.
    //
    // `?? null` collapsed the two, so a fixture that simply forgot to record a
    // re-fetch silently produced a WITHDRAWN tombstone — a claim about
    // production state manufactured out of a gap in the input. The production
    // --source path always records an entry for every previously published id
    // missing from the tour, so this only ever fires on a malformed --input.
    if (!source.departed.has(previousEntry.id)) {
      throw new SourceContractError(`departed.${previousEntry.id}:NOT_RECORDED`);
    }
    const current = source.departed.get(previousEntry.id) ?? null;
    // Re-projecting from the live record rather than carrying the previous one
    // forward verbatim: a cancelled event may have had its venue confirmed or
    // its title corrected since, and the page should say what is true now. Only
    // the slug is frozen.
    const record = current
      ? project(current, previousEntry.event_slug)
      : previousEntry;
    tombstones.push({ ...record, departed: departureOf(current, nowMs) });
  }

  return {
    schema_version: SEO_SNAPSHOT_SCHEMA_VERSION,
    occurrences: [...occurrences].sort(compareOccurrences),
    tombstones: tombstones.sort(compareOccurrences),
  };
}
