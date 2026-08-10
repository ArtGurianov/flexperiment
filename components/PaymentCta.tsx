"use client";

import { useState } from "react";

import CtaButton from "@/components/CtaButton";
import DialogDrawer from "@/components/DialogDrawer";

// Isolates the open state to this leaf so the sections that host the CTA stay
// server components. The dialog is mounted closed and opens on click.
export default function PaymentCta({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <CtaButton className={className} onClick={() => setIsOpen(true)}>
        {children}
      </CtaButton>

      <DialogDrawer
        title="Оплата"
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
      />
    </>
  );
}
