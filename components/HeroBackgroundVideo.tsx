"use client";

import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/**
 * Chrome/Edge expose the user's data-saver preference here. Not in the DOM
 * typings, and absent entirely on Safari and Firefox — `undefined` there, which
 * reads as "not asking to save data" and is the correct default.
 */
type SaveDataNavigator = Navigator & {
  connection?: { saveData?: boolean };
};

const prefersSavedData = () =>
  (navigator as SaveDataNavigator).connection?.saveData === true;

/**
 * The looping hero backdrop.
 *
 * This is a ~29MB remote file sitting at the very top of the home page, and it
 * used to declare `preload="auto"` with its `src` in the server HTML — so the
 * browser's preload scanner started buffering it before the page had painted,
 * competing with the stylesheet, the fonts and every above-the-fold image. It
 * was also what AssetPreloader gated the whole page on.
 *
 * Neither is true any more. The element renders with a poster still and no
 * source at all; the source is attached only after first paint, from an idle
 * callback, so the video can never compete with the initial render. Nothing on
 * screen waits for it — it fades in over its own poster whenever it is ready.
 *
 * Two classes of visitor never pay for it at all:
 *
 *   prefers-reduced-motion   a looping backdrop is a vestibular trigger, and a
 *                            paused video still costs the full download. The
 *                            poster still is the whole experience for them.
 *   Save-Data                someone who has asked their browser to conserve
 *                            data should not be handed 29MB of decoration.
 *
 * `poster` doubles as the LCP-safe representation of this element: it is the
 * same local `background.webp` the page already preloads from the document
 * head, so it costs nothing extra and is decoded by the time this paints.
 */
export default function HeroBackgroundVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    if (prefersReducedMotion || prefersSavedData()) return;

    // requestIdleCallback rather than a bare effect: an effect runs in the same
    // frame as hydration, which is exactly the moment the browser is still
    // fetching and decoding everything above the fold. Safari has no
    // requestIdleCallback, so it falls back to a macrotask, which is still
    // after paint.
    // lib.dom types requestIdleCallback as always present, so the guard has to
    // be a runtime typeof check rather than a truthiness test TS folds away.
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle
      ? window.requestIdleCallback(() => setSource(src), { timeout: 3000 })
      : window.setTimeout(() => setSource(src), 0);

    return () => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [prefersReducedMotion, src]);

  useEffect(() => {
    const video = ref.current;
    if (!video || !source) return;
    // autoPlay is not in the markup any more: the element is mounted without a
    // source, so there is nothing for it to act on, and attaching the source
    // later would not re-trigger it. This is what starts playback instead, and
    // it only ever runs for a visitor who was eligible to load the video.
    void video.play().catch(() => {});
  }, [source]);

  return (
    <video
      ref={ref}
      // The still frame every visitor sees, and the only thing a reduced-motion
      // or Save-Data visitor ever sees. Same file the document head already
      // preloads for bg-site, so it is a cache hit.
      poster="/background.webp"
      // No `preload="auto"`. With no src there is nothing to preload; once the
      // source is attached after first paint, "metadata" keeps the browser from
      // racing ahead of the play() call below.
      preload="metadata"
      className="h-full w-full object-cover"
      {...(source ? { src: source } : {})}
      loop
      muted
      playsInline
    />
  );
}
