"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const list = window.matchMedia(QUERY);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/**
 * The JS counterpart to Tailwind's `motion-reduce:` variant, for the motion CSS
 * cannot reach: an autoplaying <video>, and SMIL inside an <img> (whose document
 * is not scriptable, so `pauseAnimations()` is unavailable).
 *
 * The server snapshot is `false` — the un-reduced default — so SSR and first
 * paint match what most visitors get, and hydration corrects it for the rest.
 * Both call sites sit behind the loading overlay or below the fold at that
 * moment, so nothing animated is on screen before the correction lands.
 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
