"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import loaderAcid from "@/public/loader-acid.webp";
import loaderBack from "@/public/loader-back.webp";
import loaderFront from "@/public/loader-front.webp";

/**
 * Backgrounds referenced from globals.css. A CSS background image is only
 * requested once the rule matches an element, which is late — hence gating on
 * them here even though both are now local.
 *
 * Both are also preloaded from the document head, so by the time this runs they
 * are usually already in flight or cached; fetching them again is what keeps
 * them represented on the progress bar, and a cache hit costs nothing.
 */
const IMAGE_ASSETS = [
  // bg-site
  "/background.webp",
  // bg-pattern
  "/noize.webp",
];

/** Hard ceiling on how long the loader may ever be shown. */
const SAFETY_TIMEOUT_MS = 10000;
/** Lets the bar reach 100% before the overlay fades, rather than cutting away. */
const SETTLE_MS = 250;

export default function AssetPreloader() {
  const [progress, setProgress] = useState(0);
  const [isHidden, setIsHidden] = useState(false);
  const [isRemoved, setIsRemoved] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // One slot per asset holding its own 0..1 fraction. Averaging fractions
    // rather than summing bytes is what lets a 29MB video and a 21KB image
    // share a bar without the image being invisible on it.
    const TASK_COUNT = IMAGE_ASSETS.length + 1;
    const fraction = new Array<number>(TASK_COUNT).fill(0);

    const report = () => {
      if (cancelled) return;
      setProgress(fraction.reduce((a, b) => a + b, 0) / TASK_COUNT);
    };

    const finish = () => {
      if (cancelled) return;
      setProgress(1);
      window.setTimeout(() => {
        if (!cancelled) setIsHidden(true);
      }, SETTLE_MS);
    };

    const loadImage = async (url: string, slot: number) => {
      try {
        const res = await fetch(url);
        const length = Number(res.headers.get("content-length"));

        // No Content-Length or no stream means nothing to measure, so the
        // asset is a single step that flips straight to done.
        if (!res.body || !Number.isFinite(length) || length <= 0) {
          await res.arrayBuffer();
          fraction[slot] = 1;
          report();
          return;
        }

        const reader = res.body.getReader();
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          fraction[slot] = Math.min(1, received / length);
          report();
        }
      } finally {
        // Failures count as complete: a 404 or blocked request must never hold
        // the page hostage behind the loader.
        fraction[slot] = 1;
        report();
      }
    };

    // Reads the real <video> rather than fetching the URL again. A media
    // element loads through range requests into its own cache, so a parallel
    // fetch() would download all 29MB a second time instead of priming it.
    const trackVideo = (slot: number) =>
      new Promise<void>((resolve) => {
        const video = document.querySelector<HTMLVideoElement>("[data-hero-video]");
        if (!video) {
          fraction[slot] = 1;
          report();
          resolve();
          return;
        }

        const settle = () => {
          fraction[slot] = 1;
          report();
          video.removeEventListener("progress", update);
          video.removeEventListener("canplay", settle);
          video.removeEventListener("error", settle);
          resolve();
        };

        const update = () => {
          const { buffered, duration } = video;
          if (duration > 0 && buffered.length > 0) {
            fraction[slot] = Math.min(1, buffered.end(buffered.length - 1) / duration);
            report();
          }
        };

        // HAVE_FUTURE_DATA or better means it is already playable.
        if (video.readyState >= 3) {
          settle();
          return;
        }
        video.addEventListener("progress", update);
        // `canplay` rather than `canplaythrough`: browsers stop buffering once
        // playback is safe, so waiting for the whole file would stall here.
        video.addEventListener("canplay", settle);
        video.addEventListener("error", settle);
      });

    const timeout = window.setTimeout(finish, SAFETY_TIMEOUT_MS);
    void Promise.all([
      ...IMAGE_ASSETS.map(loadImage),
      trackVideo(IMAGE_ASSETS.length),
    ]).then(finish);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, []);

  // Unmounted only after the fade finishes, so it can never intercept a click.
  if (isRemoved) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={isHidden}
      onTransitionEnd={() => {
        if (isHidden) setIsRemoved(true);
      }}
      // Same repeating noise as <html>, so the loader and the page share one
      // surface and the handover is seamless. The solid colour underneath is
      // load-bearing rather than decorative: the pattern is itself one of the
      // assets being fetched, so without a background-color the overlay would
      // be transparent for the first moments and show the page it is meant to
      // be covering.
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-[#12100e] bg-pattern bg-repeat font-display transition-opacity duration-500 ${
        isHidden ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      {/* overflow-clip is belt-and-braces now that the fill is clipped in
          place; kept because it costs nothing and, unlike overflow-hidden,
          does not turn this into a scroll container. */}
      <div className="relative w-[min(18rem,70vw)] overflow-clip">
        {/* Back sits in normal flow — it is what gives the stack its height, so
            the two absolute layers have a box to fill. */}
        <Image
          src={loaderBack}
          alt=""
          aria-hidden="true"
          priority
          sizes="288px"
          className="h-auto w-full select-none"
        />

        {/* Revealed in place with clip-path rather than slid in from the left.
            Sliding leaks: loader-front is transparent around its ornament, so a
            translated acid layer shows through that margin as a tail past the
            frame's left tip — the container's overflow cannot stop it, because
            the tail is still inside the container, just outside the frame.
            Clipping the layer where it already sits keeps it registered with
            the window and makes a stray tail impossible. */}
        <Image
          src={loaderAcid}
          alt=""
          aria-hidden="true"
          priority
          sizes="288px"
          className="absolute inset-0 h-full w-full select-none transition-[clip-path] duration-200 ease-out"
          style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}
        />

        <Image
          src={loaderFront}
          alt=""
          aria-hidden="true"
          priority
          sizes="288px"
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
        />
      </div>

      <span className="sr-only">{`Загрузка ${Math.round(progress * 100)}%`}</span>
    </div>
  );
}
