"use client";

import { useCallback, useSyncExternalStore } from "react";

export const BREAKPOINTS = {
  xs: "xs",
  sm: "sm",
  md: "md",
  lg: "lg",
  xl: "xl",
  xxl: "xxl",
} as const;

type Breakpoint = (typeof BREAKPOINTS)[keyof typeof BREAKPOINTS];

const WINDOW_SIZES_MAP: Record<Breakpoint, number> = {
  [BREAKPOINTS.xs]: 0,
  [BREAKPOINTS.sm]: 640,
  [BREAKPOINTS.md]: 768,
  [BREAKPOINTS.lg]: 1024,
  [BREAKPOINTS.xl]: 1280,
  [BREAKPOINTS.xxl]: 1536,
};

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/**
 * Copied in rather than installed, keeping upstream's API and its `width >
 * breakpoint` comparison exactly.
 *
 * The implementation differs: upstream tracks width in state and writes it from
 * an effect, which this repo's `react-hooks/set-state-in-effect` rule rejects
 * outright. Reading through `useSyncExternalStore` avoids the effect entirely
 * and is tearing-safe. Snapshotting the *boolean* rather than the width also
 * removes the need for upstream's 150ms resize throttle: React bails out of
 * re-rendering when a snapshot is `Object.is`-equal, so a resize only costs a
 * render on the frame the breakpoint is actually crossed.
 *
 * The server snapshot is `false`, so SSR and first paint take the narrow
 * branch. Safe for a dialog that mounts closed — nothing is on screen before
 * hydration corrects it.
 */
export const useBreakpoint = (targetBreakpoint: Breakpoint) => {
  const threshold = WINDOW_SIZES_MAP[targetBreakpoint];

  const getSnapshot = useCallback(
    () => window.innerWidth > threshold,
    [threshold],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
};
