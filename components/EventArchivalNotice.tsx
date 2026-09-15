import { departureNotice } from "@/lib/occurrence-format";
import type { SeoTombstone } from "@/lib/seo/occurrence-snapshot";

/**
 * What an event page shows in place of a booking panel once its date has left
 * the public tour.
 *
 * Static, and that is the point. The live counterpart, EventBooking, starts
 * optimistically bookable while its fetch is in flight and swallows a failure,
 * which is correct for a scheduled date — the checkout dialog does its own
 * authoritative check, so an optimistic CTA cannot oversell. It is exactly
 * wrong for a WITHDRAWN record, where `/v1/public/occurrences/{id}` is *known*
 * to answer 404: the fetch would fail, the failure would be swallowed, and
 * «Забронировать место» would sit there permanently on a date nothing can sell.
 *
 * So a departed record never mounts the client panel at all. There is nothing
 * to hydrate: the answer does not depend on seat counts or the sales gate.
 */
export default function EventArchivalNotice({ record }: { record: SeoTombstone }) {
  return (
    <p
      role="status"
      className="mt-[6cqw] border border-bone/50 px-[4cqw] py-[3cqw] text-center text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone/80"
    >
      {departureNotice(record.departed)}
    </p>
  );
}
