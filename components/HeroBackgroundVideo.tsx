"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

import KinescopePlayer from "@/components/kinescope/KinescopePlayer";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

type SaveDataNavigator = Navigator & {
  connection?: { saveData?: boolean };
};

const prefersSavedData = () =>
  (navigator as SaveDataNavigator).connection?.saveData === true;

/**
 * How long after mounting the player the backdrop fades in without ever having
 * heard from it. `onPlaying` is the fast path, but it arrives over Kinescope's
 * iframe message bridge, which has been observed to deliver the initial
 * handshake and then nothing at all — and a backdrop gated solely on that event
 * stays invisible forever. Long enough for the player to have painted its own
 * poster over the local one, short enough not to read as a stall.
 */
const REVEAL_FALLBACK_MS = 2000;

/**
 * Decorative hero backdrop. It always paints the local poster first. Kinescope
 * is mounted only after the first-paint idle boundary, and never for people
 * who requested reduced motion or data saving.
 */
export default function HeroBackgroundVideo({ videoId }: { videoId: string }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [shouldMountPlayer, setShouldMountPlayer] = useState(false);
  const [isRevealed, setIsRevealed] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion || prefersSavedData()) return;

    // Safari has no requestIdleCallback. A macrotask still runs after the first
    // paint, keeping the same safe fallback as the previous native player.
    const hasIdle = typeof window.requestIdleCallback === "function";
    const handle = hasIdle
      ? window.requestIdleCallback(() => setShouldMountPlayer(true), { timeout: 3000 })
      : window.setTimeout(() => setShouldMountPlayer(true), 0);

    return () => {
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (!shouldMountPlayer) return;
    const handle = window.setTimeout(() => setIsRevealed(true), REVEAL_FALLBACK_MS);
    return () => window.clearTimeout(handle);
  }, [shouldMountPlayer]);

  return (
    <>
      {/* Same local LCP-safe still the document head already preloads. */}
      <Image
        src="/background.webp"
        alt=""
        aria-hidden="true"
        fill
        sizes="(min-width: 512px) 512px, 100vw"
        className="object-cover"
      />
      {shouldMountPlayer ? (
        <div
          className={`pointer-events-none absolute inset-0 transition-opacity duration-300 motion-reduce:transition-none ${
            isRevealed ? "opacity-100" : "opacity-0"
          }`}
        >
          <KinescopePlayer
            videoId={videoId}
            className="h-full w-full"
            autoPlay
            autoPause={false}
            loop
            muted
            playsInline
            preload={false}
            // The square container and the 16:9 source used to be reconciled by
            // object-fit on the element itself. That now lives inside a
            // cross-origin iframe, so the player has to be told: without this it
            // letterboxes and paints the bands opaque over the poster. Not
            // surfaced by the React wrapper — see patches/.
            videoFit="cover"
            controls={false}
            mainPlayButton={false}
            localStorage={false}
            onPlaying={() => setIsRevealed(true)}
          />
        </div>
      ) : null}
    </>
  );
}
