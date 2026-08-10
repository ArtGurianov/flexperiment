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

const loadDialog = () => import("@/components/DialogDrawer");

// Isolates the open state to this leaf so the sections that host the CTA stay
// server components. Failure presentation is deliberately not local — see
// paymentNoticeStore, which all three CTAs share.
export default function PaymentCta({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  // Latches on the first open. Rendering the dialog only from that point is
  // what actually defers the chunk — a dynamic() component still fetches as
  // soon as it is rendered, even closed.
  const [hasOpened, setHasOpened] = useState(false);
  const [isPending, setIsPending] = useState(false);
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

  return (
    <>
      <CtaButton
        // A visible treatment, not just `cursor: wait` — a touch user has no
        // cursor to see. Dimming is enough to read as "working" without
        // introducing a spinner into a button whose height is set by its type.
        className={cn(className, isPending && "cursor-wait opacity-60")}
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
          title="Оплата"
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
