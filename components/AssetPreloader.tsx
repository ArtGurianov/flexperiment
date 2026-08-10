"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import loaderMark from "@/public/loader.webp";

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
      {/* `priority` makes Next emit a preload link for it. Worth it here: this
          is the one thing visible while everything else is still downloading,
          so discovering it late would leave the loader empty exactly when it
          matters. */}
      <Image
        src={loaderMark}
        alt=""
        aria-hidden="true"
        priority
        sizes="112px"
        className="h-32 w-32 animate-spin select-none [animation-duration:2.4s]"
      />

      <div className="h-1 w-40 overflow-hidden bg-acid/20">
        <div
          className="h-full bg-acid transition-[width] duration-200 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>

      <span className="sr-only">{`Загрузка ${Math.round(progress * 100)}%`}</span>
    </div>
  );
}
