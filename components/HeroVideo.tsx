"use client";

import { useEffect, useRef, useState } from "react";

import KinescopePlayer from "@/components/kinescope/KinescopePlayer";
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
  const sectionRef = useRef<HTMLElement>(null);
  // Purely decorative: it fades the branded cover out once playback has begun.
  // Nothing about reaching the player depends on it — the cover never takes
  // pointer events — so a signal that never arrives cannot lock anyone out.
  const [hasStarted, setHasStarted] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    // The press that starts playback happens inside the player's own iframe, so
    // this document never sees the click. What it does see is focus leaving for
    // that iframe, which is the one reliable local signal that someone has
    // engaged with the player. `onPlay` below is preferred when it arrives, but
    // it travels over Kinescope's message bridge and cannot be counted on.
    const onBlur = () => {
      if (section.contains(document.activeElement)) setHasStarted(true);
    };

    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

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
        className="h-full w-full"
        videoId={KINESCOPE_HERO_VIDEO_ID}
        controls
        // Explicit rather than inherited: this is the control that actually
        // starts playback now, so it must not depend on a library default.
        mainPlayButton
        preload="metadata"
        autoPlay={false}
        autoPause={false}
        loop={false}
        muted={false}
        playsInline
        localStorage={false}
        onPlay={() => setHasStarted(true)}
      />
      {/* Branded cover over the player's own play button. It is inert in every
          sense: the click passes straight through to the iframe, where it still
          counts as a user gesture. Proxying it through player.play() did not —
          user activation is never propagated into a cross-origin frame, so iOS
          refused the unmuted play outright and the call fell into a silent
          catch. */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 flex items-center justify-center bg-black transition-opacity duration-500 motion-reduce:transition-none ${
          hasStarted ? "opacity-0" : "opacity-100"
        }`}
      >
        <svg
          className="h-32 w-32 text-acid-dim"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </div>
    </section>
  );
}
