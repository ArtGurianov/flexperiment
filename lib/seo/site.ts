/**
 * The canonical origin, shared by every generated crawl artifact.
 *
 * `app/layout.tsx` sets the same value as `metadataBase`, which is what
 * resolves the relative `alternates.canonical` values pages declare. robots.txt
 * and sitemap.xml need absolute URLs and are generated outside that resolution,
 * so they read it from here rather than each restating the literal.
 */
export const SITE_ORIGIN = "https://flexperiment.ru";

/** An absolute site URL for a root-relative path (`"/"` → the bare origin). */
export const siteUrl = (path: string): string =>
  path === "/" ? SITE_ORIGIN : `${SITE_ORIGIN}${path}`;
