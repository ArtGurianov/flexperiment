import { judgeOccurrence, eventStatusFor } from "@/lib/seo/occurrence-publication";
import type { SeoOccurrence } from "@/lib/seo/occurrence-snapshot";
import { SITE_ORIGIN, siteUrl } from "@/lib/seo/site";

/**
 * schema.org Event markup for one occurrence — or nothing at all.
 *
 * Returning null is a first-class outcome, not an error path. Google requires a
 * real `location` on an Event, and a page that says «Площадка уточняется» in
 * prose while asserting a venue in machine-readable markup is worse than a page
 * with no markup: one is incomplete, the other is false. So whenever
 * judgeOccurrence says NOT_SCHEMA_ELIGIBLE, this emits nothing and the page
 * still renders every fact it does know.
 *
 * `eventStatus` comes from fulfillment_status alone (see eventStatusFor).
 * Sales state never enters: NOT_YET_OPEN, SOLD_OUT and a paused gate all
 * describe a scheduled event that is not currently selling, and reading any of
 * them as a cancellation would mark a live event cancelled in search results.
 *
 * There is deliberately no `offers`. An Offer carries `availability` and
 * `validFrom`, which are exactly the clock- and gate-dependent values the
 * snapshot refuses to freeze — a static Offer would advertise seats that may
 * have gone hours ago. The price is on the page as text; it is not asserted as
 * a live, purchasable offer.
 */
export default function EventStructuredData({ occurrence }: { occurrence: SeoOccurrence }) {
  if (judgeOccurrence(occurrence).outcome !== "PUBLISHABLE") return null;

  const url = siteUrl(`/events/${occurrence.event_slug}`);
  const event = {
    "@context": "https://schema.org",
    "@type": "Event",
    "@id": url,
    url,
    name: `${occurrence.title} — ${occurrence.city_title}`,
    startDate: occurrence.starts_at,
    endDate: occurrence.ends_at,
    eventStatus: eventStatusFor(occurrence),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    location: {
      "@type": "Place",
      name: occurrence.venue.name,
      address: {
        "@type": "PostalAddress",
        addressLocality: occurrence.city_title,
        streetAddress: occurrence.venue.address,
        addressCountry: "RU",
      },
    },
    organizer: { "@id": `${SITE_ORIGIN}/#organization` },
    performer: { "@id": `${SITE_ORIGIN}/#art-guryanov` },
  };

  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(event) }}
    />
  );
}
