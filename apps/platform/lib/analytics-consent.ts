export const ANALYTICS_CONSENT_COOKIE = "fx_consent";
export type AnalyticsConsent = "UNDECIDED" | "DENIED" | "ALLOWED";
export type StoredAnalyticsConsent = Exclude<AnalyticsConsent, "UNDECIDED">;

export function analyticsConsentFromCookie(cookie: string): AnalyticsConsent {
  const encoded = cookie.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith(`${ANALYTICS_CONSENT_COOKIE}=`))[0]
    ?.slice(`${ANALYTICS_CONSENT_COOKIE}=`.length);
  try {
    const value = encoded ? decodeURIComponent(encoded) : "";
    return value === "v1:a1" ? "ALLOWED" : value === "v1:a0" ? "DENIED" : "UNDECIDED";
  } catch {
    return "UNDECIDED";
  }
}

export function analyticsConsentSetCookie(consent: StoredAnalyticsConsent) {
  const marker = consent === "ALLOWED" ? "v1:a1" : "v1:a0";
  return `${ANALYTICS_CONSENT_COOKIE}=${marker}; Path=/; Max-Age=${365 * 24 * 60 * 60}; SameSite=Lax; Secure`;
}

const marketingParameters = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "yclid", "gclid"]);

export function safeAnalyticsLocation(pathname: string, search: string) {
  if (!pathname.startsWith("/") || pathname.startsWith("/admin") || pathname.startsWith("/account")) return null;
  const params = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) if (marketingParameters.has(key)) params.append(key, value);
  params.sort();
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
