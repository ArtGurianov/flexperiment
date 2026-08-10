"use client";

import { useSyncExternalStore } from "react";

/** How long the failure notice stays up before clearing itself. */
const ERROR_TIMEOUT_MS = 8000;

/**
 * One notice for the whole page, rather than one per CTA.
 *
 * The three PaymentCta instances each used to own a `hasFailed` flag and render
 * their own banner. Two of them failing inside the timeout window — an offline
 * visitor tapping the navbar CTA, scrolling, then tapping the one in the FAQ —
 * stacked two pixel-identical banners at the same fixed position. Invisible as
 * a layout problem, since they overlap exactly, but `role="alert"` announced
 * the same sentence twice and the two independent timers then expired out of
 * step.
 *
 * A module-level store keeps the triggers stateless about presentation: any of
 * them can call `showPaymentFailure()`, and exactly one <PaymentNotice /> shows
 * it. A single timer means a second failure also refreshes the countdown rather
 * than racing it.
 */
let isVisible = false;
let timer = 0;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

export function showPaymentFailure() {
  isVisible = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(hidePaymentFailure, ERROR_TIMEOUT_MS);
  emit();
}

export function hidePaymentFailure() {
  window.clearTimeout(timer);
  if (!isVisible) return;
  isVisible = false;
  emit();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function usePaymentFailure() {
  // Server snapshot is `false`: nothing can have failed before hydration.
  return useSyncExternalStore(
    subscribe,
    () => isVisible,
    () => false,
  );
}
