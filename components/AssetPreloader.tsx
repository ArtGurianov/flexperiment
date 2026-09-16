"use client";

import Image from "next/image";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

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

/**
 * What this waits for beyond the images above: anything that registers itself
 * through the gate below.
 *
 * The overlay used to hold the entire page behind `bg.webm` reaching `canplay`
 * — a ~29MB remote file — with a 10s safety timeout as the only floor. That
 * inverted the critical path, and the gate is deliberately not a way back to
 * it: what a registrant reports is that its player exists and is initialised,
 * never that the video has buffered or started. The distinction is the whole
 * reason this is safe, and SAFETY_TIMEOUT_MS is the ceiling either way.
 *
 * Nothing is waited for unless it registers, so pages without a registrant are
 * unaffected — and a registrant that never releases costs the safety timeout,
 * not the page.
 */

type LoaderGate = {
  /** Registers one slot. The returned callback releases it, and is idempotent. */
  register: () => () => void;
};

const LoaderGateContext = createContext<LoaderGate | null>(null);

/**
 * Null outside AssetPreloader — which is the ordinary case, since the loader is
 * home-page-only. Callers treat that as "nothing to wait for me".
 */
export function useLoaderGate() {
  return useContext(LoaderGateContext);
}

/**
 * Hard ceiling on how long the loader may ever be shown.
 *
 * This used to be 10s, because the gate also waited on a ~29MB remote
 * `bg.webm` buffering over the network — which put a media-readiness race in
 * front of the first paint of every visit, with a ten-second worst case.
 *
 * What is waited for now is two small same-origin images the document head has
 * already preloaded, plus whatever registers through the gate — and a
 * registrant reports initialisation, not buffering. The ceiling is sized for
 * that. A slow connection that cannot get there in time simply hands over
 * without it, which is the pre-gate behaviour rather than a failure.
 */
const SAFETY_TIMEOUT_MS = 2500;
/** Lets the bar reach 100% before the overlay fades, rather than cutting away. */
const SETTLE_MS = 250;
/** Announcement granularity for screen readers — see the live region below. */
const ANNOUNCE_STEP = 25;

/** Fade duration of the overlay, mirrored from `duration-500` below. */
const FADE_MS = 500;

export default function AssetPreloader({
  children,
}: {
  /** The page itself. Held here so the overlay can inert it while it is
   *  covered — see the wrapper in the return below. */
  children: ReactNode;
}) {
  const [progress, setProgress] = useState(0);
  const [isHidden, setIsHidden] = useState(false);
  const [isRemoved, setIsRemoved] = useState(false);

  // Registrants are children, and a child's effect runs before its parent's, so
  // everything that wants to be waited for is already in this set by the time
  // the effect below reads it. Anything arriving later is deliberately ignored:
  // the bar's denominator is fixed when the run starts, and a slot appearing
  // mid-run would make it jump backwards.
  const gateRef = useRef<{
    pending: Set<object>;
    onRelease: ((token: object) => void) | null;
  }>({ pending: new Set(), onRelease: null });

  const gate = useMemo<LoaderGate>(
    () => ({
      register: () => {
        const token = {};
        gateRef.current.pending.add(token);
        return () => {
          if (!gateRef.current.pending.delete(token)) return;
          gateRef.current.onRelease?.(token);
        };
      },
    }),
    [],
  );

  useEffect(() => {
    // Captured once: the cleanup below must clear the callback on the same
    // object this run installed it on, not on whatever the ref holds later.
    const gateState = gateRef.current;
    let cancelled = false;
    // Latches on the first finish() so nothing can move the bar afterwards.
    // Without it the safety timeout could push the bar to 100% and a still-open
    // stream would then report() a lower fraction, running it backwards during
    // the fade.
    let finished = false;

    // One slot per asset holding its own 0..1 fraction. Averaging fractions
    // rather than summing bytes is what keeps a 50KB and a 21KB image
    // contributing equally to the bar.
    // Snapshotted rather than read live, so a late registrant cannot change
    // the denominator underneath a bar that is already moving.
    const gated = new Set(gateState.pending);
    const gateSlot = new Map<object, number>();
    for (const token of gated) gateSlot.set(token, IMAGE_ASSETS.length + gateSlot.size);

    const TASK_COUNT = IMAGE_ASSETS.length + gated.size;
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

    let imagesDone = false;
    // The images and the gate finish independently and in either order, so
    // neither may call finish() on its own.
    const maybeFinish = () => {
      if (imagesDone && gated.size === 0) finish();
    };

    gateState.onRelease = (token) => {
      const slot = gateSlot.get(token);
      if (slot === undefined || !gated.delete(token)) return;
      fraction[slot] = 1;
      report();
      maybeFinish();
    };

    timeout = window.setTimeout(finish, SAFETY_TIMEOUT_MS);
    void Promise.all(IMAGE_ASSETS.map(loadImage)).then(
      () => { imagesDone = true; maybeFinish(); },
      () => { imagesDone = true; maybeFinish(); },
    );

    return () => {
      cancelled = true;
      gateState.onRelease = null;
      window.clearTimeout(timeout);
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
      controller.abort();
    };
  }, []);

  const percent = Math.round(progress * 100);

  return (
    <>
      {/* The page is behind an opaque overlay, so it must not be reachable by
          keyboard either — otherwise Tab walked an invisible focus ring through
          a navbar and four accordions nobody could see. `inert` lifts the
          moment the fade starts, in step with the overlay's own
          pointer-events-none, so the page never feels locked once it is
          visible.

          `display: contents` keeps this wrapper out of layout entirely: nav and
          main stay direct flex children of the centred column. inert is a DOM
          property, not a rendered one, so it still applies to the subtree.

          Note this ships set in the server HTML, so a visitor without JS gets a
          page that is inert as well as covered by an overlay that will never
          clear — and no <noscript> stylesheet can remove an attribute. Accepted
          knowingly: the overlay, the dialog, the accordion and the hero video
          all require JS already, so there is no working no-JS experience for
          this to degrade. */}
      <div className="contents" inert={!isHidden}>
        <LoaderGateContext.Provider value={gate}>
          {children}
        </LoaderGateContext.Provider>
      </div>

      {/* Unmounted only after the fade finishes, so it can never intercept a
          click. */}
      {!isRemoved && (
        <div
          role="status"
          aria-live="polite"
          aria-hidden={isHidden}
          // Coupled to FADE_MS rather than a `duration-500` class, so the
          // fallback removal timer above and the fade it is racing cannot
          // drift apart. `transition-none` under motion-reduce still wins:
          // it sets transition-property, which this does not touch.
          style={{ transitionDuration: `${FADE_MS}ms` }}
          onTransitionEnd={(event) => {
            // transitionend bubbles, and the acid layer below runs its own
            // clip-path transition inside this subtree. Without the target
            // check the removal would depend on that transition finishing
            // before the settle delay rather than on this element's own fade.
            if (isHidden && event.target === event.currentTarget) {
              setIsRemoved(true);
            }
          }}
          // Same repeating noise as <html>, so the loader and the page share
          // one surface and the handover is seamless. The solid colour
          // underneath is load-bearing rather than decorative: the pattern is
          // itself one of the assets being fetched, so without a
          // background-color the overlay would be transparent for the first
          // moments and show the page it is meant to be covering.
          className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-ink bg-pattern bg-repeat font-display transition-opacity motion-reduce:transition-none ${
            isHidden ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          {/* The three frames are `loading="eager"` but deliberately NOT
              fetchPriority="high" any more. They were the only high-priority
              imagery on the whole site, and 352KB of loader artwork at the head
              of the queue outranked /background.webp — the actual LCP resource,
              which paints the moment this overlay fades. Eager is enough: they
              are in the initial markup, so they are discovered immediately and
              simply queue behind the page's own critical image.

              overflow-clip is belt-and-braces now that the fill is clipped in
              place; kept because it costs nothing and, unlike overflow-hidden,
              does not turn this into a scroll container. */}
          <div className="relative w-[min(18rem,70vw)] overflow-clip">
            {/* Back sits in normal flow — it is what gives the stack its
                height, so the two absolute layers have a box to fill. */}
            <Image
              src={loaderBack}
              alt=""
              aria-hidden="true"
              loading="eager"
              sizes="288px"
              className="h-auto w-full select-none"
            />

            {/* Revealed in place with clip-path rather than slid in from the
                left. Sliding leaks: loader-front is transparent around its
                ornament, so a translated acid layer shows through that margin
                as a tail past the frame's left tip — the container's overflow
                cannot stop it, because the tail is still inside the container,
                just outside the frame. Clipping the layer where it already sits
                keeps it registered with the window and makes a stray tail
                impossible. */}
            <Image
              src={loaderAcid}
              alt=""
              aria-hidden="true"
              loading="eager"
              sizes="288px"
              className="absolute inset-0 h-full w-full select-none transition-[clip-path] duration-200 ease-out motion-reduce:transition-none"
              style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}
            />

            <Image
              src={loaderFront}
              alt=""
              aria-hidden="true"
              loading="eager"
              sizes="288px"
              className="pointer-events-none absolute inset-0 h-full w-full select-none"
            />
          </div>

          {/* Quantised to 25% steps. A polite live region re-announces whenever
              its text changes, and a byte-by-byte percentage changes on nearly
              every frame — which reads out as an unbroken stream of
              "Загрузка N %". */}
          <span className="sr-only">
            {`Загрузка ${Math.floor(percent / ANNOUNCE_STEP) * ANNOUNCE_STEP}%`}
          </span>
        </div>
      )}
    </>
  );
}
