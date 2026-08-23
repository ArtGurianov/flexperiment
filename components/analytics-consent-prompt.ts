import type { AnalyticsConsent } from "@/lib/analytics-consent";
import { isAnalyticsEligibleRoute } from "@/lib/analytics-location";

export const ANALYTICS_CONSENT_PROMPT_DELAY_MS = 4_000;
export const ANALYTICS_CONSENT_PROMPT_SCROLL_Y = 60;

type ScrollTarget = Pick<Window, "addEventListener" | "removeEventListener">;

type PromptScheduler = {
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  getScrollY: () => number;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  target: ScrollTarget;
};

/**
 * Defers the first consent prompt without granting analytics in the interim.
 * It is deliberately limited to scroll and time: clicks and keyboard input
 * must keep their original page action instead of opening a modal.
 */
export function scheduleAnalyticsConsentPrompt(
  input: {
    consent: AnalyticsConsent;
    pathname: string;
    show: () => void;
  },
  scheduler: PromptScheduler = {
    clearTimeout: window.clearTimeout.bind(window),
    getScrollY: () => window.scrollY,
    setTimeout: window.setTimeout.bind(window),
    target: window,
  },
) {
  if (input.consent !== "UNDECIDED" || !isAnalyticsEligibleRoute(input.pathname)) {
    return () => undefined;
  }

  let shown = false;
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    cancelled = true;
    scheduler.target.removeEventListener("scroll", onScroll);
    if (timeout !== null) scheduler.clearTimeout(timeout);
    timeout = null;
  };

  const showOnce = () => {
    if (cancelled || shown) return;
    shown = true;
    scheduler.target.removeEventListener("scroll", onScroll);
    if (timeout !== null) scheduler.clearTimeout(timeout);
    timeout = null;
    input.show();
  };

  const onScroll = () => {
    if (scheduler.getScrollY() > ANALYTICS_CONSENT_PROMPT_SCROLL_Y) showOnce();
  };

  if (scheduler.getScrollY() > ANALYTICS_CONSENT_PROMPT_SCROLL_Y) {
    showOnce();
    return cleanup;
  }

  scheduler.target.addEventListener("scroll", onScroll, { passive: true });
  timeout = scheduler.setTimeout(showOnce, ANALYTICS_CONSENT_PROMPT_DELAY_MS);
  return cleanup;
}
