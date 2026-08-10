"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { Drawer as DrawerPrimitive } from "vaul";

import { useBreakpoint } from "@/hooks/useBreakpoint";
import { cn } from "@/lib/cn";

export interface DialogDrawerProps {
  className?: string;
  children?: ReactNode;
  title: string;
  isOpen: boolean;
  onClose: () => void;
  /** Blocks Escape, outside-click and drag dismissal — for use mid-payment,
   *  where an accidental tap shouldn't discard an in-flight transaction. */
  preventOutsideClose?: boolean;
}

const SURFACE = "flex flex-col bg-[#12100e] text-bone";
const TITLE = "text-center font-display text-[1.6rem] leading-none uppercase text-acid";

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="size-6" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function DialogVariant({
  className,
  children,
  title,
  isOpen,
  onClose,
  preventOutsideClose,
}: DialogDrawerProps) {
  const block = preventOutsideClose
    ? (event: Event | KeyboardEvent) => event.preventDefault()
    : undefined;

  return (
    <DialogPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          onEscapeKeyDown={block}
          onInteractOutside={block}
          className={cn(
            SURFACE,
            "fixed top-1/2 left-1/2 z-50 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-hidden rounded-2xl border-4 border-acid p-6",
            className,
          )}
        >
          <DialogPrimitive.Title className={TITLE}>{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {`Диалог: ${title}`}
          </DialogPrimitive.Description>

          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
            {children}
          </div>

          <DialogPrimitive.Close
            aria-label="Закрыть"
            className="absolute top-4 right-4 rounded-full p-1 text-acid transition-colors hover:bg-acid hover:text-[#12100e] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acid"
          >
            <CloseIcon />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DrawerVariant({
  className,
  children,
  title,
  isOpen,
  onClose,
  preventOutsideClose,
}: DialogDrawerProps) {
  return (
    <DrawerPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      // `dismissible` covers drag-to-close, outside click and Escape in one
      // flag, so the drawer needs no per-event guards.
      dismissible={!preventOutsideClose}
      repositionInputs={false}
      shouldScaleBackground={false}
      autoFocus={isOpen}
    >
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <DrawerPrimitive.Content
          className={cn(
            SURFACE,
            "fixed inset-x-0 bottom-0 z-50 mt-24 max-h-[90dvh] rounded-t-3xl border-t-4 border-acid px-5 pb-6",
            className,
          )}
        >
          <div
            aria-hidden="true"
            className="mx-auto mt-3 mb-4 h-1.5 w-24 shrink-0 rounded-full bg-bone/40"
          />

          <DrawerPrimitive.Title className={TITLE}>{title}</DrawerPrimitive.Title>
          <DrawerPrimitive.Description className="sr-only">
            {`Диалог: ${title}`}
          </DrawerPrimitive.Description>

          {/* data-vaul-no-drag keeps a scroll gesture inside the body from
              being read as a drag-to-dismiss. */}
          <div
            data-vaul-no-drag
            className="mt-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
          >
            {children}
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}

/**
 * One dialog, centred on desktop and a bottom sheet on phones.
 *
 * Simplified from the upstream component: there is no shell registrar, so this
 * renders its own chrome in place rather than portalling into a host, and the
 * drag-dismiss remount recovery is gone with it — that existed only to undo a
 * stranded vaul transform when a shell guard *refused* a close, which cannot
 * happen when `onClose` is the only thing driving `isOpen`. No back button and
 * no stacking, so the dialog is also properly modal (upstream ran
 * `modal={false}` to let a stack coexist), which restores focus trapping and
 * background inerting for free.
 */
export default function DialogDrawer(props: DialogDrawerProps) {
  const isWindowOverSM = useBreakpoint("sm");
  const Variant = isWindowOverSM ? DialogVariant : DrawerVariant;

  return <Variant {...props} />;
}
