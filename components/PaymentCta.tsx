"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

import CtaButton from "@/components/CtaButton";

// Radix Dialog and vaul are only ever needed once someone reaches for the
// booking flow, so they load as their own chunk on demand rather than riding
// along in the initial bundle of a page whose whole job is to render fast.
// ssr: false because the dialog has nothing to contribute to the server HTML —
// it is mounted closed and portals out of the tree when it opens.
const DialogDrawer = dynamic(() => import("@/components/DialogDrawer"), {
  ssr: false,
});

// Isolates the open state to this leaf so the sections that host the CTA stay
// server components.
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

  // Fetches the chunk on the intent signal that precedes the click, so the
  // dialog is usually already resolved by the time it is asked for.
  const warm = useCallback(() => {
    void import("@/components/DialogDrawer");
  }, []);

  return (
    <>
      <CtaButton
        className={className}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => {
          setHasOpened(true);
          setIsOpen(true);
        }}
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
