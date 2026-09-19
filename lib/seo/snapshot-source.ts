import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EMPTY_SNAPSHOT,
  parseSnapshot,
  type PublishedRecord,
  type SeoSnapshot,
} from "@/lib/seo/occurrence-snapshot";
import { publishableRecords } from "@/lib/seo/occurrence-publication";

/**
 * Reads the committed snapshot at build time.
 *
 * SERVER ONLY — it imports node:fs. Every caller (generateStaticParams,
 * generateMetadata, the event and city pages, app/sitemap.ts) is a server
 * module, and pulling this into a client component would break the build
 * loudly rather than quietly, which is the behaviour we want.
 *
 * Reading from disk rather than importing the JSON keeps `data/seo/**` out of
 * the client bundle graph entirely, the same way app/legal/[slug]/page.tsx
 * reads its Markdown instead of importing it.
 *
 * A missing file is treated as an empty snapshot, so a clean checkout that has
 * never run the generator still builds — with zero event pages, which is the
 * correct fail-closed outcome. A file that exists but does not parse is fatal:
 * half-generating pages from a corrupt artifact would publish nonsense as
 * commercial fact.
 */
const SNAPSHOT_FILE = path.join("data", "seo", "occurrences.v1.json");

let cached: SeoSnapshot | undefined;

export function readCommittedSnapshot(): SeoSnapshot {
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(path.join(process.cwd(), SNAPSHOT_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    cached = EMPTY_SNAPSHOT;
    return cached;
  }
  cached = parseSnapshot(JSON.parse(raw));
  return cached;
}

/**
 * Every record that gets a page: live occurrences plus tombstones, minus
 * anything INVALID.
 *
 * Tombstones are included deliberately — a cancelled or finished event keeps
 * its URL. They are excluded from the sitemap and from every "upcoming"
 * surface instead, and the PublishedRecord union is what lets callers tell the
 * difference. Do not widen this to SeoOccurrence[].
 */
export const publishedRecords = (): readonly PublishedRecord[] =>
  publishableRecords(readCommittedSnapshot());

export const findPublishedRecord = (slug: string): PublishedRecord | undefined =>
  publishedRecords().find((entry) => entry.event_slug === slug);

/**
 * The reserved param used when the snapshot has nothing to publish.
 *
 * Next 16 refuses an empty `generateStaticParams()` under `output: "export"`:
 * "at least one route must be generated". There is no opt-out — with no runtime
 * there is nothing to defer a path to — so a dynamic route that exists in the
 * tree must emit at least one file, even when the correct answer is none.
 *
 * The resolution is in two halves, and neither half works alone:
 *
 *   1. `generateStaticParams` falls back to this single reserved slug, whose
 *      page calls notFound() and so renders the branded 404 body. Nothing links
 *      to it, it is not in the sitemap, and it carries the 404's `noindex`.
 *   2. `pnpm build` then deletes it from `out/` (see
 *      commerce/src/prune-seo-placeholder-routes.ts), because a URL that
 *      answers 200 with a 404 body is still a fabricated URL on a public site,
 *      and this one describes an event that does not exist.
 *
 * With inventory present, no placeholder is generated and the prune is a no-op.
 * The export conformance tests assert both halves.
 *
 * The leading and trailing underscores are not decoration: `parseEventSlug`
 * rejects anything that is not `<catalogue-city>-<uuid>`, so this can never
 * collide with a real event URL.
 */
export const PLACEHOLDER_PARAM = "__placeholder__";

/** The route segments that fall back to PLACEHOLDER_PARAM when empty. */
// Only "events" remains a dynamic route family. /cities/[city] was retired in
// favour of /schedule, which is a fixed route and so has no empty
// generateStaticParams to work around.
export const PLACEHOLDER_ROUTE_SEGMENTS = ["events"] as const;
