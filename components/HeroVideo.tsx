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
  const [isPlaying, setIsPlaying] = useState(false);

  return (
    <section className="relative w-full aspect-video overflow-hidden">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        src="https://zhjrb3dyh4.ufs.sh/f/kTOk4z0nYjRr8kW0TNEsMwcZpq1Dai2oXAgYWPIV0GOkKF64"
        controls
        preload="metadata"
        playsInline
        onPlay={(event) => {
          setIsPlaying(true);
          // Covers a play started from the native controls rather than the
          // overlay. Browsers still hold transient activation from that click,
          // so the request is normally honoured.
          enterFullscreen(event.currentTarget);
        }}
        onPause={() => setIsPlaying(false)}
      />
      <button
        type="button"
        aria-label="Play video"
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
        className={`group absolute inset-0 flex cursor-pointer items-center justify-center bg-black transition-opacity duration-500 ${
          isPlaying ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
      >
        <svg
          className="h-32 w-32 text-[#B1E36D] transition-colors duration-200 group-hover:text-[#CAFF56]"
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
