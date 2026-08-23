import { describe, expect, it } from "vitest";
import {
  ANALYTICS_CONSENT_PROMPT_DELAY_MS,
  scheduleAnalyticsConsentPrompt,
} from "./analytics-consent-prompt";

function fakeScheduler(scrollY = 0) {
  let listener: (() => void) | undefined;
  let timeout: (() => void) | undefined;
  let timeoutDelay: number | undefined;
  let listenerOptions: AddEventListenerOptions | boolean | undefined;
  let removed = 0;
  let cleared = 0;

  return {
    scheduler: {
      clearTimeout: () => { cleared += 1; },
      getScrollY: () => scrollY,
      setTimeout: (callback: () => void, delay: number) => {
        timeout = callback;
        timeoutDelay = delay;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      target: {
        addEventListener: (
          _type: string,
          callback: EventListenerOrEventListenerObject,
          options?: AddEventListenerOptions | boolean,
        ) => {
          listener = callback as () => void;
          listenerOptions = options;
        },
        removeEventListener: () => { removed += 1; },
      },
    },
    fireScroll: () => listener?.(),
    fireTimeout: () => timeout?.(),
    setScrollY: (next: number) => { scrollY = next; },
    state: () => ({ cleared, listenerOptions, removed, timeoutDelay }),
  };
}

describe("analytics consent prompt scheduler", () => {
  it("shows once after exactly two seconds when the page has not scrolled", () => {
    const fake = fakeScheduler();
    let shown = 0;
    scheduleAnalyticsConsentPrompt(
      { consent: "UNDECIDED", pathname: "/", show: () => { shown += 1; } },
      fake.scheduler,
    );

    expect(fake.state().timeoutDelay).toBe(ANALYTICS_CONSENT_PROMPT_DELAY_MS);
    expect(fake.state().listenerOptions).toEqual({ passive: true });
    expect(shown).toBe(0);
    fake.fireTimeout();
    fake.fireTimeout();
    expect(shown).toBe(1);
    expect(fake.state().removed).toBe(1);
  });

  it("shows once after scroll beyond 60px and clears the timer", () => {
    const fake = fakeScheduler(60);
    let shown = 0;
    scheduleAnalyticsConsentPrompt(
      { consent: "UNDECIDED", pathname: "/", show: () => { shown += 1; } },
      fake.scheduler,
    );

    fake.fireScroll();
    expect(shown).toBe(0);
    fake.setScrollY(61);
    fake.fireScroll();
    fake.fireTimeout();
    expect(shown).toBe(1);
    expect(fake.state().cleared).toBe(1);
  });

  it("shows immediately when scroll restoration is already beyond the threshold", () => {
    const fake = fakeScheduler(61);
    let shown = 0;
    scheduleAnalyticsConsentPrompt(
      { consent: "UNDECIDED", pathname: "/", show: () => { shown += 1; } },
      fake.scheduler,
    );
    expect(shown).toBe(1);
    expect(fake.state().timeoutDelay).toBeUndefined();
  });

  it.each(["DENIED", "ALLOWED"] as const)("does not auto-prompt after a saved %s decision", (consent) => {
    const fake = fakeScheduler();
    let shown = 0;
    scheduleAnalyticsConsentPrompt(
      { consent, pathname: "/", show: () => { shown += 1; } },
      fake.scheduler,
    );
    fake.fireScroll();
    fake.fireTimeout();
    expect(shown).toBe(0);
    expect(fake.state().timeoutDelay).toBeUndefined();
  });

  it.each(["/ticket", "/refund/confirm"])("does not auto-prompt on %s", (pathname) => {
    const fake = fakeScheduler();
    let shown = 0;
    scheduleAnalyticsConsentPrompt(
      { consent: "UNDECIDED", pathname, show: () => { shown += 1; } },
      fake.scheduler,
    );
    fake.fireScroll();
    fake.fireTimeout();
    expect(shown).toBe(0);
    expect(fake.state().timeoutDelay).toBeUndefined();
  });

  it("cancels a pending eligible-route timer when navigation cleans it up", () => {
    const fake = fakeScheduler();
    let shown = 0;
    const cleanup = scheduleAnalyticsConsentPrompt(
      { consent: "UNDECIDED", pathname: "/", show: () => { shown += 1; } },
      fake.scheduler,
    );
    cleanup();
    fake.fireTimeout();
    expect(shown).toBe(0);
    expect(fake.state().cleared).toBe(1);
  });
});
