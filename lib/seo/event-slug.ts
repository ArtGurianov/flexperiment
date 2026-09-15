import { isCitySlug } from "@/lib/city-catalog";

/**
 * The canonical shape of an occurrence id as Commerce issues it.
 *
 * Lowercase hex with dashes, matched exactly. A slug is parsed by splitting on
 * the last 36 characters, so anything looser here would let a city slug
 * containing a dash be mis-split.
 */
export const OCCURRENCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Length of a canonical UUID, including dashes. */
const ID_LENGTH = 36;

export const isOccurrenceId = (value: string): boolean =>
  OCCURRENCE_ID_PATTERN.test(value);

/**
 * Mints the URL an event page is published at: `<city>-<full uuid>`.
 *
 * Two properties are load-bearing and neither is negotiable later:
 *
 *   The city component is frozen at first publication. It is minted once, from
 *   the city the occurrence had when its page first went live, and then carried
 *   forward in the snapshot itself rather than recomputed. If an occurrence
 *   moves city, the page content updates and the URL does not — recomputing it
 *   would silently break every inbound link and every indexed result.
 *
 *   The uuid is full, never truncated. A truncated id is a collision waiting
 *   for a second occurrence, and the URL is the permanent public identity of a
 *   commercial event.
 *
 * Callers mint a slug exactly once, for an occurrence that has no slug yet;
 * everything afterwards reads `event_slug` off the snapshot record.
 */
export const mintEventSlug = (city: string, id: string): string => {
  if (!isCitySlug(city)) throw new Error(`SEO_EVENT_SLUG_UNKNOWN_CITY:${city}`);
  if (!isOccurrenceId(id)) throw new Error(`SEO_EVENT_SLUG_INVALID_ID:${id}`);
  return `${city}-${id}`;
};

export type ParsedEventSlug = {
  /** The city as it was at first publication — not necessarily the current one. */
  readonly city: string;
  readonly id: string;
};

/**
 * The inverse of `mintEventSlug`, returning null for anything that is not a
 * well-formed slug.
 *
 * Splits from the right, because a city slug may itself contain dashes
 * ("saint-petersburg", "rostov-on-don", "komsomolsk-on-amur"). The uuid's fixed
 * 36-character length is what makes the split unambiguous.
 */
export const parseEventSlug = (slug: string): ParsedEventSlug | null => {
  if (slug.length < ID_LENGTH + 2) return null;
  const id = slug.slice(-ID_LENGTH);
  const separator = slug.charAt(slug.length - ID_LENGTH - 1);
  const city = slug.slice(0, slug.length - ID_LENGTH - 1);
  if (separator !== "-") return null;
  if (!isOccurrenceId(id) || !isCitySlug(city)) return null;
  return { city, id };
};
