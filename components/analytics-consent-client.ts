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

export function storeAnalyticsConsent(consent: StoredAnalyticsConsent) {
  document.cookie = analyticsConsentSetCookie(consent);
  window.dispatchEvent(new Event(ANALYTICS_CONSENT_CHANGE_EVENT));
}
