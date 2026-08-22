export const ANALYTICS_CONSENT_COOKIE = "fx_consent";
export const ANALYTICS_CONSENT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export type AnalyticsConsent = "UNDECIDED" | "DENIED" | "ALLOWED";
export type StoredAnalyticsConsent = Exclude<AnalyticsConsent, "UNDECIDED">;

const markerByConsent: Record<StoredAnalyticsConsent, string> = {
  DENIED: "v1:a0",
  ALLOWED: "v1:a1",
};

export function parseAnalyticsConsentMarker(
  value: string | null | undefined,
): AnalyticsConsent {
  if (value === "v1:a0") return "DENIED";
  if (value === "v1:a1") return "ALLOWED";
  return "UNDECIDED";
}

export function analyticsConsentFromCookie(cookie: string): AnalyticsConsent {
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ANALYTICS_CONSENT_COOKIE}=`))
    ?.slice(`${ANALYTICS_CONSENT_COOKIE}=`.length);

  try {
    return parseAnalyticsConsentMarker(value && decodeURIComponent(value));
  } catch {
    return "UNDECIDED";
  }
}

export function serializeAnalyticsConsent(consent: StoredAnalyticsConsent) {
  return markerByConsent[consent];
}

export function analyticsConsentSetCookie(consent: StoredAnalyticsConsent) {
  return `${ANALYTICS_CONSENT_COOKIE}=${encodeURIComponent(serializeAnalyticsConsent(consent))}; Path=/; Max-Age=${ANALYTICS_CONSENT_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}
