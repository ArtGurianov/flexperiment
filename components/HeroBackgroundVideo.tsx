"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";

import { useLoaderGate } from "@/components/AssetPreloader";
import KinescopePlayer from "@/components/kinescope/KinescopePlayer";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

type SaveDataNavigator = Navigator & {
  connection?: { saveData?: boolean };
};

const prefersSavedData = () =>
  (navigator as SaveDataNavigator).connection?.saveData === true;

const subscribeNever = () => () => {};

/**
 * False while rendering on the server, true once running in the browser. The
 * player touches browser APIs as it loads, so the decision to mount it cannot
 * be made during the server pass — and expressing that as a snapshot rather
 * than as state set from an effect keeps it out of a second render pass.
 */
const useIsClient = () =>
  useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

/**
 * Decorative hero backdrop. It always paints the local poster first, and the
 * video fades in over it once it is actually playing — so the player is never
 * on screen with nothing in it.
 *
 * Kinescope is never mounted at all for people who requested reduced motion or
 * data saving. For everyone else it is mounted immediately and held by the
 * loader gate until the player reports ready.
 */
export default function HeroBackgroundVideo({ videoId }: { videoId: string }) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const isClient = useIsClient();
  const loaderGate = useLoaderGate();
  const releaseGate = useRef<(() => void) | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Derived rather than held: the player is mounted immediately for everyone
  // eligible. The idle deferral this replaces existed to keep it off the
  // critical path, which is the opposite of what is wanted now that the loader
  // waits for it — idle work does not run while the loader is fetching, so the
  // wait would have been spent reaching the safety ceiling instead of loading
  // the player.
  const shouldMountPlayer =
    isClient && !prefersReducedMotion && !prefersSavedData();

  useEffect(() => {
    if (!loaderGate) return;
    const release = loaderGate.register();
    releaseGate.current = release;
    return () => {
      release();
      releaseGate.current = null;
    };
  }, [loaderGate]);

  // Visitors who never get a player must not be held for the safety timeout.
  useEffect(() => {
    if (!shouldMountPlayer) releaseGate.current?.();
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
            // Fit is not set here. The square container and the 16:9 source
            // are reconciled by `ui.videoFit: "cover"`, which is configured
            // account-wide in the Kinescope dashboard and arrives with the
            // embed — object-fit itself is inside a cross-origin iframe and out
            // of reach. Without that setting this letterboxes and paints the
            // bands opaque over the poster.
            controls={false}
            mainPlayButton={false}
            localStorage={false}
            // Releasing on ready, not on playing: the loader is waiting for a
            // player that exists and can paint, never for buffered video.
            onReady={() => releaseGate.current?.()}
            onPlaying={() => setIsPlaying(true)}
          />
        </div>
      ) : null}
    </>
  );
}
