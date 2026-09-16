"use client";

import { useEffect, useRef, useState } from "react";

import KinescopePlayer, {
  type KinescopePlayerHandle,
} from "@/components/kinescope/KinescopePlayer";
import { KINESCOPE_HERO_VIDEO_ID } from "@/components/kinescope/videoIds";

const FULLSCREEN_CHANGE = "KINESCOPE_PLAYER_FULLSCREEN_CHANGE";

type FullscreenMessage = {
  type: typeof FULLSCREEN_CHANGE;
  value: boolean;
};

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isFullscreenMessage = (data: unknown): data is FullscreenMessage =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  "value" in data &&
  data.type === FULLSCREEN_CHANGE &&
  typeof data.value === "boolean";

export default function HeroVideo() {
  const playerRef = useRef<KinescopePlayerHandle>(null);
  const sectionRef = useRef<HTMLElement>(null);
  // Latches on first play rather than tracking the live playback state. The
  // overlay covers the whole player, so restoring it after pause would make
  // Kinescope's controls inaccessible just when someone wants to use them.
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    if (!isIOS()) return;
    const section = sectionRef.current;
    if (!section) return;

    const restore = (frame: HTMLIFrameElement) => {
      const originalStyles = frame.dataset.kinescopeOriginalStyles;
      if (originalStyles === undefined) return;
      frame.style.cssText = originalStyles;
      delete frame.dataset.kinescopeOriginalStyles;
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isFullscreenMessage(event.data)) return;

      const frame = section.querySelector("iframe");
      // The player posts this event from its own frame. Checking the source
      // means unrelated window messages cannot alter this page's layout.
      if (!frame || event.source !== frame.contentWindow) return;

      if (!event.data.value) {
        restore(frame);
        return;
      }

      if (frame.dataset.kinescopeOriginalStyles === undefined) {
        frame.dataset.kinescopeOriginalStyles = frame.style.cssText;
      }
      // Kinescope's documented iOS pseudo-fullscreen bridge preserves its
      // iframe controls without invoking the incompatible native fullscreen API.
      frame.style.cssText = "background:#000;border:none;position:fixed;z-index:9999;width:100%;height:100%;bottom:0;right:0;top:0;left:0";
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      const frame = section.querySelector("iframe");
      if (frame) restore(frame);
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      className="relative w-full aspect-video overflow-hidden shadow-[0_-10px_24px_rgb(202_255_86_/_0.3),0_10px_24px_rgb(202_255_86_/_0.3),0_-16px_48px_rgb(202_255_86_/_0.18),0_16px_48px_rgb(202_255_86_/_0.18)]"
    >
      <KinescopePlayer
        forwardRef={playerRef}
        className="h-full w-full"
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
