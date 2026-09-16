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
 * Decorative hero backdrop. It always paints a local still first, and the video
 * fades in over it once it is actually playing — so the player is never on
 * screen with nothing in it.
 *
 * The still is frame 0 of this same video, which is what makes the arrangement
 * work. It used to be /background.webp, the site's cloud texture, and that made
 * the reveal a visible cut from clouds to a stage however well it was timed.
 * With the video's own first frame underneath, the handover is invisible — and
 * that is what lets the loader hand over on a ceiling without anybody noticing,
 * and what reduced-motion and Save-Data visitors, who never get a player at
 * all, are left looking at.
 *
 * Kinescope is never mounted for those visitors. For everyone else it is
 * mounted immediately and held by the loader gate until it is playing.
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

  // Eligibility is re-derived here rather than read off shouldMountPlayer.
  // That value depends on isClient, which is false for the hydration pass —
  // the very pass whose effects run first and whose registrations are the only
  // ones the loader will see. Deriving from it registered a slot and released
  // it again in the same tick, every time, so the gate held nothing at all.
  // Effects never run on the server, so no isClient guard is needed in here.
  useEffect(() => {
    if (!loaderGate) return;
    if (prefersReducedMotion || prefersSavedData()) return;

    const release = loaderGate.register();
    releaseGate.current = release;
    return () => {
      release();
      releaseGate.current = null;
    };
  }, [loaderGate, prefersReducedMotion]);

  return (
    <>
      {/* Frame 0 of the video above it, and preloaded from the document head
          so it is on screen before the player has anything to show. */}
      <Image
        src="/hero-backdrop.webp"
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
            // One event, two jobs: reveal this backdrop and let the page in.
            // They have to be the same event. Releasing on init instead meant
            // the loader lifted when a player object existed, which says
            // nothing about pixels — measured on the built export, that ran
            // 2.9s ahead of the reveal, so the page opened onto the still and
            // the video cut in afterwards.
            onPlaying={() => {
              setIsPlaying(true);
              releaseGate.current?.();
            }}
            // A blocked script or a stream this browser cannot play never
            // reaches Playing, and the gate must not hold the page for
            // something that is not coming. The still stays, which is the
            // whole fallback.
            onError={() => releaseGate.current?.()}
          />
        </div>
      ) : null}
    </>
  );
}
