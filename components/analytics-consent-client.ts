"use client";

import {
  analyticsConsentSetCookie,
  analyticsConsentFromCookie,
  type AnalyticsConsent,
  type StoredAnalyticsConsent,
} from "@/lib/analytics-consent";

export const ANALYTICS_CONSENT_CHANGE_EVENT = "flexperiment:analytics-consent";

export function readAnalyticsConsent(): AnalyticsConsent {
  return analyticsConsentFromCookie(document.cookie);
}

export function persistAnalyticsConsent(consent: StoredAnalyticsConsent) {
  document.cookie = analyticsConsentSetCookie(consent);
}

export function notifyAnalyticsConsentChange() {
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_CHANGE_EVENT));
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
