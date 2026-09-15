import type { MetadataRoute } from "next";

import { SITE_ORIGIN } from "@/lib/seo/site";

/**
 * There was no robots.txt at all — the live URL 404ed.
 *
 * Supported under `output: "export"`: robots.ts is a Route Handler that Next
 * renders to a static file at build time, and it is absent from the
 * unsupported-features list in
 * node_modules/next/dist/docs/01-app/02-guides/static-exports.md.
 *
 * Note what is deliberately NOT here. The non-indexable surfaces — the RSC
 * `.txt` payloads, the raw legal `.md` sources and `/legal/archive/**` — are
 * suppressed with an `X-Robots-Tag: noindex` response header in
 * deploy/frontend.nginx.conf, not with `Disallow`. The two cannot be combined:
 * a crawler that obeys `Disallow` never fetches the URL and therefore never
 * sees the header, while a `Disallow`ed URL can still be indexed URL-only from
 * inbound links. The header is the stronger control, and crawl budget is not a
 * constraint at this size.
 *
 * The utility routes (/ticket, /payment/success, /refund*) carry their own
 * `noindex` meta for exactly the same reason.
 */
/**
 * Required under `output: "export"`. Next treats robots.ts/sitemap.ts as Route
 * Handlers, and a GET handler is uncached by default — which a static export
 * cannot represent, so the build fails outright with
 * "export const dynamic = \"force-static\" ... not configured". This opts the
 * handler into prerendering, which is what writes the file into `out/`.
 */
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
