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
/** Announcement granularity for screen readers — see the live region below. */
const ANNOUNCE_STEP = 25;

/** Fade duration of the overlay, mirrored from `duration-500` below. */
const FADE_MS = 500;

/**
 * `canplay` rather than `canplaythrough`, because browsers stop buffering once
 * playback is safe and waiting for the whole file would stall here.
 */
const SETTLE_EVENTS = ["canplay", "error"] as const;

/**
 * `suspend` is the escape hatch for iOS Low Power Mode, where the browser
 * declines to buffer a preload="auto" source until a user gesture — `canplay`
 * never fires and the loader would otherwise sit out the whole safety timeout
 * for every visitor in that mode.
 *
 * It is not iOS-specific though: desktop browsers fire it on any ordinary
 * "buffered enough for now" pause, which can land just before `canplay`. Hence
 * the grace period rather than settling outright — where `canplay` is coming it
 * arrives well inside this window and wins, so the strict gate is preserved
 * everywhere the browser is actually still loading.
 */
const SUSPEND_GRACE_MS = 600;

export default function AssetPreloader() {
  const [progress, setProgress] = useState(0);
  const [isHidden, setIsHidden] = useState(false);
  const [isRemoved, setIsRemoved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Latches on the first finish() so nothing can move the bar afterwards.
    // Without it the safety timeout could push the bar to 100% and a still-open
    // stream would then report() a lower fraction, running it backwards during
    // the fade.
    let finished = false;

    // One slot per asset holding its own 0..1 fraction. Averaging fractions
    // rather than summing bytes is what lets a 29MB video and a 21KB image
    // share a bar without the image being invisible on it.
    const TASK_COUNT = IMAGE_ASSETS.length + 1;
    const fraction = new Array<number>(TASK_COUNT).fill(0);
    const controller = new AbortController();
    // Declared up front so finish() can clear it whichever path gets there
    // first — previously the timeout stayed armed after a normal finish and
    // fired a second, redundant finish ten seconds later.
    let timeout = 0;
    let hideTimer = 0;
    let removeTimer = 0;

    const report = () => {
      if (cancelled || finished) return;
      setProgress(fraction.reduce((a, b) => a + b, 0) / TASK_COUNT);
    };

    const finish = () => {
      if (cancelled || finished) return;
      finished = true;
      window.clearTimeout(timeout);
      // Nothing else is waited on past this point, so drop any still-open
      // stream rather than letting it read to the end behind the fade.
      controller.abort();
      setProgress(1);
      hideTimer = window.setTimeout(() => {
        if (cancelled) return;
        setIsHidden(true);
        // Unmounting hangs off `transitionend` below, which is the right signal
        // when there is a transition — but `motion-reduce:transition-none`
        // removes it outright, and a backgrounded tab can swallow it too. Left
        // to the event alone the overlay stayed mounted forever for exactly the
        // reduced-motion visitors the variant is there to serve.
        removeTimer = window.setTimeout(() => {
          if (!cancelled) setIsRemoved(true);
        }, FADE_MS + 200);
      }, SETTLE_MS);
    };

    const loadImage = async (url: string, slot: number) => {
      try {
        const res = await fetch(url, { signal: controller.signal });
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
      } catch {
        // Swallowed rather than rethrown, and this is the whole point of the
        // catch: a rejection here used to propagate out of Promise.all, so the
        // `.then(finish)` below never ran and an offline or blocked request
        // held the page behind the loader for the full safety timeout — the
        // exact outcome the `finally` was written to prevent.
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
        const video =
          document.querySelector<HTMLVideoElement>("[data-hero-video]");
        if (!video) {
          fraction[slot] = 1;
          report();
          resolve();
          return;
        }

        let suspendTimer = 0;

        const settle = () => {
          fraction[slot] = 1;
          report();
          window.clearTimeout(suspendTimer);
          video.removeEventListener("progress", update);
          video.removeEventListener("suspend", onSuspend);
          for (const event of SETTLE_EVENTS) {
            video.removeEventListener(event, settle);
          }
          resolve();
        };

        const onSuspend = () => {
          window.clearTimeout(suspendTimer);
          suspendTimer = window.setTimeout(settle, SUSPEND_GRACE_MS);
        };

        const update = () => {
          const { buffered, duration } = video;
          if (duration > 0 && buffered.length > 0) {
            fraction[slot] = Math.min(
              1,
              buffered.end(buffered.length - 1) / duration,
            );
            report();
          }
        };

        // HAVE_FUTURE_DATA or better means it is already playable.
        if (video.readyState >= 3) {
          settle();
          return;
        }
        video.addEventListener("progress", update);
        video.addEventListener("suspend", onSuspend);
        for (const event of SETTLE_EVENTS) {
          video.addEventListener(event, settle);
        }
      });

    timeout = window.setTimeout(finish, SAFETY_TIMEOUT_MS);
    void Promise.all([
      ...IMAGE_ASSETS.map(loadImage),
      trackVideo(IMAGE_ASSETS.length),
    ]).then(finish, finish);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
      controller.abort();
    };
  }, []);

  // Unmounted only after the fade finishes, so it can never intercept a click.
  if (isRemoved) return null;

  const percent = Math.round(progress * 100);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={isHidden}
      onTransitionEnd={(event) => {
        // transitionend bubbles, and the acid layer below runs its own
        // clip-path transition inside this subtree. Without the target check
        // the removal would depend on that transition finishing before the
        // settle delay rather than on this element's own fade.
        if (isHidden && event.target === event.currentTarget) setIsRemoved(true);
      }}
      // Same repeating noise as <html>, so the loader and the page share one
      // surface and the handover is seamless. The solid colour underneath is
      // load-bearing rather than decorative: the pattern is itself one of the
      // assets being fetched, so without a background-color the overlay would
      // be transparent for the first moments and show the page it is meant to
      // be covering.
      className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-ink bg-pattern bg-repeat font-display transition-opacity duration-500 motion-reduce:transition-none ${
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
          loading="eager"
          fetchPriority="high"
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
          loading="eager"
          fetchPriority="high"
          sizes="288px"
          className="absolute inset-0 h-full w-full select-none transition-[clip-path] duration-200 ease-out motion-reduce:transition-none"
          style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}
        />

        <Image
          src={loaderFront}
          alt=""
          aria-hidden="true"
          loading="eager"
          fetchPriority="high"
          sizes="288px"
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
        />
      </div>

      {/* Quantised to 25% steps. A polite live region re-announces whenever its
          text changes, and a byte-by-byte percentage changes on nearly every
          frame — which reads out as an unbroken stream of "Загрузка N %". */}
      <span className="sr-only">
        {`Загрузка ${Math.floor(percent / ANNOUNCE_STEP) * ANNOUNCE_STEP}%`}
      </span>
    </div>
  );
}
