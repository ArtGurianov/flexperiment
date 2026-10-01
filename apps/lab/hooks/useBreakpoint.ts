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

/**
 * Copied in rather than installed, keeping upstream's API.
 *
 * The implementation differs twice over. Upstream tracks width in state and
 * writes it from an effect, which this repo's `react-hooks/set-state-in-effect`
 * rule rejects outright; reading through `useSyncExternalStore` avoids the
 * effect entirely and is tearing-safe. And the comparison is `matchMedia`
 * rather than upstream's `window.innerWidth > breakpoint`: `>` puts a viewport
 * of exactly 640px on the *narrow* side while Tailwind's own `sm:` utilities —
 * which are `min-width: 640px` — are already applying, so the two disagreed on
 * that single width. matchMedia also fires only when the query flips, instead
 * of on every resize event, which is what let upstream's 150ms throttle go.
 *
 * The server snapshot is `false`, so SSR and first paint take the narrow
 * branch. Safe for a dialog that mounts closed — nothing is on screen before
 * hydration corrects it.
 */
export const useBreakpoint = (targetBreakpoint: Breakpoint) => {
  const query = `(min-width: ${WINDOW_SIZES_MAP[targetBreakpoint]}px)`;

  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(() => window.matchMedia(query).matches, [query]);

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
};
