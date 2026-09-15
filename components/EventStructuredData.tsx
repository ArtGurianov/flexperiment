import { eventStatusFor, mayEmitEventSchema } from "@/lib/seo/occurrence-publication";
import type { PublishedRecord } from "@/lib/seo/occurrence-snapshot";
import { serializeJsonLd } from "@/lib/seo/json-ld";
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
 * The second gate is WITHDRAWN. Commerce answered 404 for that occurrence, so
 * the snapshot is holding the last data it ever saw with no way to know if any
 * of it is still true — and the record's stale `fulfillment_status: SCHEDULED`
 * would otherwise produce EventScheduled markup for an event the authoritative
 * system no longer serves. See mayEmitEventSchema.
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
export default function EventStructuredData({ occurrence }: { occurrence: PublishedRecord }) {
  if (!mayEmitEventSchema(occurrence)) return null;

  const url = siteUrl(`/events/${occurrence.event_slug}`);
  // Commerce may legitimately name an occurrence after the city it is in — the
  // Saint Petersburg record does exactly that, with title and city_title both
  // "Санкт-Петербург" — which composed into "Санкт-Петербург — Санкт-Петербург".
  //
  // Exact equality on purpose. Anything fuzzier (case folding, trimming,
  // normalising dashes) would start changing the name of legitimately distinct
  // titles, which is a naming-semantics decision this has no business making;
  // the defect being fixed is only ever the identical-strings case.
  const eventName =
    occurrence.title === occurrence.city_title
      ? occurrence.title
      : `${occurrence.title} — ${occurrence.city_title}`;

  const event = {
    "@context": "https://schema.org",
    "@type": "Event",
    "@id": url,
    url,
    name: eventName,
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
      // serializeJsonLd, not JSON.stringify: name, city_title, venue.name and
      // venue.address are Commerce-controlled strings, and `</script>` survives
      // JSON escaping intact. See lib/seo/json-ld.ts.
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(event) }}
    />
  );
}
