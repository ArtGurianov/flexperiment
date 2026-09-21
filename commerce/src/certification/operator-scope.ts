import { readFileSync } from "node:fs";
import type { OccurrenceDraft } from "./run";

/**
 * The occurrence the operator prepared, read from their own file.
 *
 * Its timing is the operator's; its title, price and capacity are not theirs to
 * choose and are fixed in the source. Read here rather than accepted as
 * arguments so nothing about a certification occurrence arrives over a network.
 */
export const readOperatorOccurrence = (path: string): Omit<OccurrenceDraft, "cityId"> => {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`CERTIFICATION_OCCURRENCE_SCOPE_UNREADABLE: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const fields = ["starts_at", "ends_at", "venue_disclosure_text", "venue_announce_by"] as const;
  for (const field of fields) {
    if (typeof parsed[field] !== "string" || !String(parsed[field]).trim()) {
      throw new Error(`CERTIFICATION_OCCURRENCE_SCOPE_INVALID: ${field}`);
    }
  }
  return {
    startsAt: String(parsed.starts_at), endsAt: String(parsed.ends_at),
    venueDisclosureText: String(parsed.venue_disclosure_text), venueAnnounceBy: String(parsed.venue_announce_by),
  };
};
