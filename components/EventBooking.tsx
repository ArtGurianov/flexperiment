"use client";

import { useEffect, useState } from "react";

import OccurrenceNotifyForm from "@/components/OccurrenceNotifyForm";
import PaymentCta from "@/components/PaymentCta";
import { commerceApiUrl } from "@/lib/commerce-api";
import { availabilityAnnouncement, canRequestCheckout, purchaseStatusAnnouncement, type AvailabilityStatus, type PurchaseStatus } from "@/lib/occurrence-sales";

/**
 * The one part of an event page that is NOT static.
 *
 * Seat availability, sales_status and purchase_status are derived in
 * commerce/src/domain.ts from `this.clock()`, a live `COUNT(*)` over bookings
 * and the sales gate. They are correct for the instant they were computed and
 * for no other instant, which is exactly why lib/seo/occurrence-snapshot.ts
 * refuses to carry them: a static page that said "мест нет" would keep saying
 * it after a cancellation freed a seat, and one that said "есть места" would
 * keep saying it after the last one went.
 *
 * So EventView server-renders every durable fact and this fetches
 * the volatile ones on mount. Until the answer arrives the booking CTA is shown
 * unconditionally — it opens the checkout dialog, which does its own
 * authoritative check, so an optimistic CTA can never sell a seat that is not
 * there. That keeps the primary action available immediately rather than behind
 * a spinner.
 *
 * That optimism is only safe for a date still in the public tour, which is why
 * EventView mounts this ONLY when the view model carries no archivalNotice. For
 * a departed record — a WITHDRAWN tombstone especially, where the endpoint
 * below is known to answer 404 — the swallowed failure would leave the CTA up
 * permanently. Those render the archival banner and no booking panel.
 */
type LiveState = {
  purchase_status: PurchaseStatus;
  availability_status: AvailabilityStatus;
  fulfillment_status: "SCHEDULED" | "COMPLETED" | "CANCELLED";
};

export default function EventBooking({ occurrenceId }: { occurrenceId: string }) {
  const [live, setLive] = useState<LiveState | null>(null);
  const [notificationsAvailable, setNotificationsAvailable] = useState(false);

  useEffect(() => {
    let current = true;
    const refresh = () => fetch(commerceApiUrl(`/v1/public/occurrences/${encodeURIComponent(occurrenceId)}`), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("OCCURRENCE_UNAVAILABLE"))))
      .then((data: LiveState) => { if (current) setLive(data); })
      // Swallowed on purpose: a failed refresh leaves the optimistic CTA in
      // place, which is strictly better than replacing a working booking path
      // with an error nobody can act on.
      .catch(() => {});
    refresh();
    const onFocus = () => { refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    fetch(commerceApiUrl("/v1/public/legal-config"), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { occurrence_notifications_available: false }))
      .then((data: { occurrence_notifications_available?: boolean }) => {
        if (current) setNotificationsAvailable(data.occurrence_notifications_available === true);
      })
      .catch(() => {});
    return () => {
      current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [occurrenceId]);

  const bookable = live === null || canRequestCheckout(live);

  return (
    <div className="mt-[6cqw]">
      {bookable ? (
        <>
          {live?.purchase_status === "AVAILABLE" && <p role="status" className="mb-[4cqw] border border-bone/50 px-[4cqw] py-[3cqw] text-center text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone/80">{availabilityAnnouncement(live.availability_status)}</p>}
          <div className="flex justify-center">
            {/* The occurrence is already chosen — this opens booking for it,
                not the catalogue the visitor just came from. */}
            <PaymentCta
              occurrenceId={occurrenceId}
              className="w-fit max-w-full px-[6cqw] text-[clamp(1.2rem,5.5cqw,2rem)]"
            >
              Забронировать место
            </PaymentCta>
          </div>
        </>
      ) : (
        <>
          <p role="status" className="border border-bone/50 px-[4cqw] py-[3cqw] text-center text-[clamp(0.9rem,3.5cqw,1.1rem)] text-bone/80">
            {purchaseStatusAnnouncement(live.purchase_status)}
          </p>
          {notificationsAvailable && live.purchase_status !== "UNAVAILABLE" ? (
            <div className="mt-[4cqw]">
              <OccurrenceNotifyForm occurrenceId={occurrenceId} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
