"use client";

import { useEffect, useRef } from "react";

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
      // Verbatim from their docs; `position: fixed` resolves against the
      // viewport here because no ancestor establishes a containing block.
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
    // bg-black stands in for the player while it has nothing to paint. The
    // iframe is transparent until Kinescope has its poster, and with no cover
    // over it any gap would show the page's own backdrop through the video
    // well — which is also what fills the player's rounded corners.
    <section
      ref={sectionRef}
      className="relative w-full aspect-video overflow-hidden bg-black shadow-[0_-10px_24px_rgb(202_255_86_/_0.3),0_10px_24px_rgb(202_255_86_/_0.3),0_-16px_48px_rgb(202_255_86_/_0.18),0_16px_48px_rgb(202_255_86_/_0.18)]"
    >
      {/* No cover and no watch button of our own any more. The press has to
          land inside the iframe to count as a user gesture there: activation is
          not propagated into a cross-origin frame, so anything handled out here
          could not start an unmuted video on iOS, and proxying it through
          player.play() is what used to fail silently. The player's own button
          carries the brand colour from the Kinescope dashboard instead. */}
      <KinescopePlayer
        className="h-full w-full"
        videoId={KINESCOPE_HERO_VIDEO_ID}
        controls
        // The only control there is now, so it must not be left to a default.
        mainPlayButton
        preload="metadata"
        autoPlay={false}
        autoPause={false}
        loop={false}
        muted={false}
        playsInline
        localStorage={false}
      />
    </section>
  );
}
