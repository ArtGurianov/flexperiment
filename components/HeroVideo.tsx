"use client";

import { useRef, useState } from "react";

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
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />
      <button
        type="button"
        aria-label="Play video"
        onClick={() => videoRef.current?.play()}
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
