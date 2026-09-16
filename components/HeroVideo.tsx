"use client";

import { useRef, useState } from "react";

import KinescopePlayer, {
  type KinescopePlayerHandle,
} from "@/components/kinescope/KinescopePlayer";
import { KINESCOPE_HERO_VIDEO_ID } from "@/components/kinescope/videoIds";

export default function HeroVideo() {
  const playerRef = useRef<KinescopePlayerHandle>(null);
  // Latches on first play rather than tracking the live playback state. The
  // overlay covers the whole player, so restoring it after pause would make
  // Kinescope's controls inaccessible just when someone wants to use them.
  const [hasStarted, setHasStarted] = useState(false);

  return (
    <section className="relative w-full aspect-video overflow-hidden shadow-[0_-10px_24px_rgb(202_255_86_/_0.3),0_10px_24px_rgb(202_255_86_/_0.3),0_-16px_48px_rgb(202_255_86_/_0.18),0_16px_48px_rgb(202_255_86_/_0.18)]">
      <KinescopePlayer
        forwardRef={playerRef}
        className="h-full w-full object-cover"
        videoId={KINESCOPE_HERO_VIDEO_ID}
        controls
        preload="metadata"
        autoPlay={false}
        autoPause={false}
        loop={false}
        muted={false}
        playsInline
        localStorage={false}
        // Fullscreen belongs to the explicit watch gesture below. Doing it on
        // every play would force a user back into fullscreen after an exit.
        onPlay={() => setHasStarted(true)}
      />
      <button
        type="button"
        aria-label="Смотреть видео"
        // Faded out but still in the DOM, so without this it stays a tab stop
        // and a screen-reader target sitting invisibly over the player.
        inert={hasStarted}
        onClick={() => {
          const player = playerRef.current;
          if (!player) return;
          // These calls stay in the explicit watch gesture. The Kinescope
          // iframe owns fullscreen now, including mobile-specific handling;
          // a browser refusal is harmless because inline playback continues.
          void player.setFullscreen(true).catch(() => {});
          void player.play().catch(() => {});
        }}
        className={`group absolute inset-0 flex cursor-pointer items-center justify-center bg-black transition-opacity duration-500 motion-reduce:transition-none ${
          hasStarted ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <svg
          className="h-32 w-32 text-acid-dim transition-colors duration-200 group-hover:text-acid motion-reduce:transition-none"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
    </section>
  );
}
