import type { MetadataRoute } from "next";

import { LEGAL_DOCUMENTS } from "@/lib/legal";
import { belongsInSitemap } from "@/lib/seo/occurrence-publication";
import { siteUrl } from "@/lib/seo/site";
import { citiesWithUpcomingDates, publishedRecords } from "@/lib/seo/snapshot-source";

/**
 * There was no sitemap.xml either — the live URL 404ed.
 *
 * The inclusion rule is narrow and stated as a rule rather than a list: a URL
 * belongs here only if it is a canonical, indexable HTML page. That excludes,
 * permanently:
 *
 *   /ticket, /payment/success, /refund, /refund/confirm
 *       They carry `noindex`. Listing a noindex URL in a sitemap is a direct
 *       contradiction, and search consoles report it as an error.
 *   the RSC `.txt` payloads and the raw legal `.md` sources
 *       Not pages. Suppressed at the nginx layer with X-Robots-Tag.
 *   /legal/archive/**
 *       Superseded document versions, retained for evidence, never canonical.
 *   cancelled, completed and past event pages
 *       Their URLs stay live so an indexed link or a printed ticket keeps
 *       working, but they are not fresh content to offer a crawler.
 *       belongsInSitemap is the single rule; the page is generated either way.
 *   any occurrence the validator rejects
 *       Out of the snapshot's publishable set entirely, so it has no page to
 *       list in the first place.
 *
 * `priority` and `changefreq` are skipped on purpose: Google ignores both, and
 * a fabricated `changefreq` on a page that has not changed is noise.
 *
 * `lastModified` is likewise omitted rather than filled with a build timestamp.
 * `new Date()` here would claim every page changed on every deploy, which is
 * false and trains crawlers to distrust the signal.
 */
/**
 * Required under `output: "export"`. Next treats robots.ts/sitemap.ts as Route
 * Handlers, and a GET handler is uncached by default — which a static export
 * cannot represent, so the build fails outright with
 * "export const dynamic = \"force-static\" ... not configured". This opts the
 * handler into prerendering, which is what writes the file into `out/`.
 */
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  // belongsInSitemap excludes every tombstone, not only the cancelled ones: a
  // PAST or WITHDRAWN record still carries fulfillment_status SCHEDULED, so a
  // status check alone would offer archival pages to a crawler as upcoming
  // events.
  const events = publishedRecords().filter(belongsInSitemap);
  // A city page is worth listing only while it has an upcoming date. A city
  // whose dates have all been cancelled or have all passed keeps its page — its
  // event pages link back to it — and leaves the sitemap.
  const cities = citiesWithUpcomingDates();

  return [
    { url: siteUrl("/") },
    // The canonical catalogue of cities and dates. Always listed: it is a fixed
    // route that exists even with an empty snapshot, where it honestly says
    // nothing is announced yet.
    { url: siteUrl("/schedule") },
    ...cities.map((city) => ({ url: siteUrl(`/cities/${city.slug}`) })),
    ...events.map((record) => ({ url: siteUrl(`/events/${record.event_slug}`) })),
    ...LEGAL_DOCUMENTS.map(({ slug }) => ({ url: siteUrl(`/legal/${slug}`) })),
  ];
}
