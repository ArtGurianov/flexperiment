"use client";

import { useRef, useState } from "react";

// iOS Safari never got the standard element Fullscreen API — on iPhone the only
// way in is the video-specific webkitEnterFullscreen, which hands off to the
// native player. Neither vendor method is in the DOM typings.
type FullscreenCapableVideo = HTMLVideoElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  webkitEnterFullscreen?: () => void;
};

function enterFullscreen(video: HTMLVideoElement) {
  if (document.fullscreenElement) return;

  const el = video as FullscreenCapableVideo;

  // Rejection is expected and harmless — the browser refuses when the call has
  // drifted outside the user gesture that triggered it, and playback should
  // carry on inline rather than surface an error.
  if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => {});
    return;
  }
  if (el.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
    return;
  }
  // Throws on iOS if metadata has not loaded yet, so playback still wins.
  try {
    el.webkitEnterFullscreen?.();
  } catch {}
}

export default function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Latches on the first play rather than tracking the live playing state. The
  // overlay covers the whole element, native controls included, so bringing it
  // back on pause put the controls out of reach exactly when someone wanted to
  // scrub or change the volume.
  const [hasStarted, setHasStarted] = useState(false);

  return (
    // The same acid glow the DarkPanel containers carry, mirrored onto the
    // vertical axis: this section is full-bleed, so its left and right edges sit
    // under the column clip and only the top and bottom ever show. Offsets,
    // blurs and alphas are DARK_PANEL_SURFACE's, doubled to both sides — it
    // cannot reuse the constant itself, which also carries the panel fill.
    <section className="relative w-full aspect-video overflow-hidden shadow-[0_-10px_24px_rgb(202_255_86_/_0.3),0_10px_24px_rgb(202_255_86_/_0.3),0_-16px_48px_rgb(202_255_86_/_0.18),0_16px_48px_rgb(202_255_86_/_0.18)]">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        src="https://flexperiment.s3.cloud.ru/flexperiment.webm"
        controls
        preload="metadata"
        playsInline
        // Deliberately does not request fullscreen. Fullscreen belongs to the
        // explicit "watch" gesture on the overlay below; requesting it from
        // every play event also yanked the user back into fullscreen when they
        // exited it and pressed play again to resume inline.
        onPlay={() => setHasStarted(true)}
      />
      <button
        type="button"
        aria-label="Смотреть видео"
        // Faded out but still in the DOM, so without this it stays a tab stop
        // and a screen-reader target sitting invisibly over the player.
        inert={hasStarted}
        onClick={() => {
          const video = videoRef.current;
          if (!video) return;
          // Requested straight from the click rather than after play()
          // resolves: the promise settles asynchronously, by which point the
          // user gesture has expired and the browser would refuse fullscreen.
          enterFullscreen(video);
          // play() resolves only once playback starts; a pause() arriving
          // before that rejects it with a harmless AbortError.
          video.play().catch(() => {});
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
