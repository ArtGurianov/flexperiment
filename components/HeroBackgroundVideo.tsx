"use client";

import { useEffect, useRef } from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * The looping hero backdrop.
 *
 * `autoPlay` stays in the markup so the common case starts without waiting for
 * hydration; the pause below is what honours a reduced-motion preference, since
 * that is an attribute CSS cannot reach. A paused video holds its current frame,
 * so those visitors get the hero as a still rather than a black box — and the
 * loading overlay covers this element for the whole first second anyway, so the
 * loop is never on screen before the pause lands.
 */
export default function HeroBackgroundVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (prefersReducedMotion) video.pause();
    else void video.play().catch(() => {});
  }, [prefersReducedMotion]);

  return (
    // data-hero-video is the handle AssetPreloader reads buffering progress
    // from — it watches this element instead of re-fetching the URL, which
    // would download the file twice.
    <video
      ref={ref}
      data-hero-video
      preload="auto"
      className="h-full w-full object-cover"
      src={src}
      autoPlay
      loop
      muted
      playsInline
    />
  );
}
