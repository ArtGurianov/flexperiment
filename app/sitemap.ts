import type { MetadataRoute } from "next";

import { LEGAL_DOCUMENTS } from "@/lib/legal";
import { siteUrl } from "@/lib/seo/site";

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
  return [
    { url: siteUrl("/") },
    ...LEGAL_DOCUMENTS.map(({ slug }) => ({ url: siteUrl(`/legal/${slug}`) })),
  ];
}
