"use client";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

// head.svg animates with SMIL (<animate>, 2s loop, repeatCount="indefinite").
// SMIL runs when the file is loaded as its own image document, which a plain
// <img> does — but next/image would route it through the optimizer and flatten
// the animation away, so this one deliberately stays an <img>.
//
// That same choice is why the reduced-motion variant is a second file rather
// than a runtime pause: an <img>'s document is not scriptable, so there is no
// handle to call pauseAnimations() on. head-still.svg is generated from the
// same payloads with the <animate> elements removed, which leaves exactly the
// t=0 frame the animated file paints first anyway. Only one of the two is ever
// fetched, and this sits far below the fold, so the choice is settled long
// before it enters the viewport.
//
// Intrinsic dimensions are passed to reserve layout space and avoid a shift
// once the file lands.
export default function TeacherHead({ className = "" }: { className?: string }) {
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={prefersReducedMotion ? "/head-still.svg" : "/head.svg"}
      alt=""
      aria-hidden="true"
      width={480}
      height={680}
      loading="lazy"
      className={`pointer-events-none block h-auto max-w-none select-none ${className}`}
    />
  );
}
