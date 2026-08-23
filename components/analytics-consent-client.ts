"use client";

import {
  analyticsConsentSetCookie,
  analyticsConsentFromCookie,
  type AnalyticsConsent,
  type StoredAnalyticsConsent,
} from "@/lib/analytics-consent";

export const ANALYTICS_CONSENT_CHANGE_EVENT = "flexperiment:analytics-consent";
export const ANALYTICS_SETTINGS_OPEN_EVENT = "flexperiment:analytics-settings-open";

export function readAnalyticsConsent(): AnalyticsConsent {
  return analyticsConsentFromCookie(document.cookie);
}

export function persistAnalyticsConsent(consent: StoredAnalyticsConsent) {
  document.cookie = analyticsConsentSetCookie(consent);
}

export function notifyAnalyticsConsentChange() {
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_CHANGE_EVENT));
}

/** Opens the root-owned settings dialog from a small client island in Footer. */
export function requestAnalyticsSettings(target: Pick<EventTarget, "dispatchEvent"> = window) {
  target.dispatchEvent(new Event(ANALYTICS_SETTINGS_OPEN_EVENT));
}

export function applyAnalyticsConsentChoice(
  consent: StoredAnalyticsConsent,
  controls: {
    persist: (value: StoredAnalyticsConsent) => void;
    revoke: () => void;
    notify: () => void;
  },
) {
  controls.persist(consent);
  if (consent === "DENIED") controls.revoke();
  controls.notify();
}
