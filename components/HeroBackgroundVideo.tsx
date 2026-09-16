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
 * Decorative hero backdrop. It always paints the local poster first. Kinescope
 * is mounted only after the first-paint idle boundary, and never for people
 * who requested reduced motion or data saving.
 */
export default function HeroBackgroundVideo({ videoId }: { videoId: string }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [shouldMountPlayer, setShouldMountPlayer] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);

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
            isPlaying ? "opacity-100" : "opacity-0"
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
            controls={false}
            mainPlayButton={false}
            localStorage={false}
            onPlaying={() => setIsPlaying(true)}
          />
        </div>
      ) : null}
    </>
  );
}
