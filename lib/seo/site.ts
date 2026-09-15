/**
 * The site-wide constants every generated crawl artifact and every route's
 * metadata is built from.
 *
 * `app/layout.tsx` sets SITE_ORIGIN as `metadataBase`, which is what resolves
 * the relative `alternates.canonical` values pages declare. robots.txt and
 * sitemap.xml need absolute URLs and are generated outside that resolution, so
 * they read it from here rather than each restating the literal.
 */
export const SITE_ORIGIN = "https://flexperiment.ru";

/** An absolute site URL for a root-relative path (`"/"` → the bare origin). */
export const siteUrl = (path: string): string =>
  path === "/" ? SITE_ORIGIN : `${SITE_ORIGIN}${path}`;

export const SITE_NAME = "FLEXPERIMENT";

/**
 * The Open Graph fields that are true of every document, to be spread into any
 * route that declares an `openGraph` object of its own.
 *
 * Spreading is not optional. Next merges metadata shallowly, so a leaf that
 * declares `openGraph: { title }` does not *add* a title to the root's object —
 * it REPLACES the whole object, silently dropping og:type, og:locale and
 * og:site_name from that one route. Exactly that happened to the home page the
 * first time its metadata was moved out of the layout.
 *
 * `type` is "website"; a route that is an article (the legal pages) overrides
 * it after the spread.
 */
export const OPEN_GRAPH_BASE = {
  type: "website",
  locale: "ru_RU",
  siteName: SITE_NAME,
} as const;

/**
 * Backed by app/twitter-image.png, which is 1200x630 — which is what this card
 * size promises. Same shallow-merge caveat as OPEN_GRAPH_BASE: a route
 * declaring its own `twitter` object must restate this or it falls back to
 * Twitter's `summary` default.
 */
export const TWITTER_CARD = "summary_large_image" as const;
