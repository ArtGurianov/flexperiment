"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";

import CtaButton from "@/components/CtaButton";
import {
  hidePaymentFailure,
  showPaymentFailure,
} from "@/components/paymentNoticeStore";
import { cn } from "@/lib/cn";

// Radix Dialog and vaul are only ever needed once someone reaches for the
// booking flow, so they load as their own chunk on demand rather than riding
// along in the initial bundle of a page whose whole job is to render fast.
// ssr: false because the dialog has nothing to contribute to the server HTML —
// it is mounted closed and portals out of the tree when it opens.
const DialogDrawer = dynamic(() => import("@/components/DialogDrawer"), {
  ssr: false,
});
const CheckoutFlow = dynamic(() => import("@/components/CheckoutFlow"), { ssr: false });

const loadDialog = () => import("@/components/DialogDrawer");

/**
 * "Start checkout for this occurrence."
 *
 * After /schedule this is the component's ONLY meaning. It used to double as
 * "show me the list of cities", which is now ScheduleLink — a real
 * <a href="/schedule">. Conflating the two would make the booking button on an
 * event page send the visitor back to the catalogue they just came from.
 *
 * `occurrenceId` is the occurrence the visitor has already chosen by
 * navigating to its URL, and it is passed straight through to CheckoutFlow so
 * booking opens on that date. The host (EventBooking) therefore does not need
 * to know anything about how CheckoutFlow is structured.
 *
 * Isolates the open state to this leaf so the sections that host the CTA stay
 * server components. Failure presentation is deliberately not local — see
 * paymentNoticeStore, which every CTA shares.
 */
export default function PaymentCta({
  children,
  className,
  occurrenceId,
}: {
  children: React.ReactNode;
  className?: string;
  /** Omitted only where the catalogue itself is the entry point. */
  occurrenceId?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  // Latches on the first open. Rendering the dialog only from that point is
  // what actually defers the chunk — a dynamic() component still fetches as
  // soon as it is rendered, even closed.
  const [hasOpened, setHasOpened] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [view, setView] = useState<"booking" | "city-interest" | null>(null);
  const [bookingTitle, setBookingTitle] = useState<string | null>(null);
  const [flowKey, setFlowKey] = useState(0);
  // A ref rather than the state above: a second tap can land before React has
  // committed the pending render, and state would still read stale there.
  const inFlight = useRef(false);

  // Fetches the chunk on the intent signal that precedes the click, so the
  // dialog is usually already resolved by the time it is asked for. Only
  // desktop gets that lead time, though — a tap has no hover before it, which
  // is what the pending state below covers. The catch is required: a bare
  // floating promise here becomes an unhandled rejection when the chunk cannot
  // be fetched, and a warm-up failing is not worth reporting — the click path
  // retries and surfaces it there.
  const warm = useCallback(() => {
    loadDialog().catch(() => {});
  }, []);

  const open = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setIsPending(true);
    hidePaymentFailure();

    try {
      await loadDialog();
    } catch (error) {
      // Offline, a CDN failure, or deploy skew where this page asks for a chunk
      // hash that no longer exists. Without the catch the rejection escaped the
      // discarded promise as an unhandled rejection and the tap did nothing at
      // all. The button returns to idle, so pressing again retries — and
      // `hasOpened` stays false, so nothing half-mounted is left behind.
      console.error("Не удалось загрузить диалог оплаты", error);
      showPaymentFailure();
      setIsPending(false);
      inFlight.current = false;
      return;
    }

    // Cleared in the same batch that opens the dialog. Clearing it before the
    // await settles would leave the button reading as idle while nothing was on
    // screen yet — which is what happened when a tap's focus event had already
    // warmed the chunk and the import resolved in a microtask.
    setIsPending(false);
    setHasOpened(true);
    setIsOpen(true);
    inFlight.current = false;
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setView(null);
    setBookingTitle(null);
    setFlowKey((key) => key + 1);
  }, []);

  const backToCities = useCallback(() => {
    setView(null);
    setBookingTitle(null);
    setFlowKey((key) => key + 1);
  }, []);

  return (
    <>
      <CtaButton
        // A visible treatment, not just `cursor: wait` — a touch user has no
        // cursor to see. Dimming is enough to read as "working" without
        // introducing a spinner into a button whose height is set by its type.
        className={cn(className, isPending && "cursor-not-allowed opacity-60")}
        onPointerEnter={warm}
        onFocus={warm}
        aria-busy={isPending}
        // Not `disabled`: that would drop focus and silence the button for
        // assistive tech mid-press. Repeat activation is guarded in `open`.
        onClick={() => void open()}
      >
        {children}
      </CtaButton>

      {hasOpened && (
        <DialogDrawer
          title={view === "city-interest" ? "Не нашли свой город?" : view === "booking" ? bookingTitle ?? "ГОРОДА × ДАТЫ" : "ГОРОДА × ДАТЫ"}
          isOpen={isOpen}
          // Opaque, unlike the shared bg-ink/90 surface. This dialog is the top
          // of the stack: opened from an event drawer it sits on ANOTHER
          // dialog, and at 90% the date, price and headings underneath read
          // straight through a payment form as a double exposure. The overlay
          // still dims what is behind, so "there is a page under this" survives
          // — only the see-through does not.
          className="bg-ink"
          onClose={close}
          // No Back for the single-occurrence entry. `backToCities` remounts
          // CheckoutFlow, whose tour effect immediately re-opens booking for
          // `initialOccurrenceId` — so the control rendered, was announced, and
          // did nothing. There is no catalogue behind this entry point to
          // return to: the visitor chose the date by navigating to its URL, and
          // the way out is Close, which returns them to it. The catalogue is
          // /schedule, reached by ScheduleLink, which is the whole point of
          // splitting the two.
          onBack={view && !(occurrenceId && view === "booking") ? backToCities : undefined}
        >
          <CheckoutFlow key={flowKey} onViewChange={setView} onBookingTitle={setBookingTitle} initialOccurrenceId={occurrenceId} />
        </DialogDrawer>
      )}
    </>
  );
}
