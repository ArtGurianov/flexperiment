export const REFERRAL_MARKER_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const markerPattern = /^v1:([a-z0-9-]{2,100})$/;

export function referralSlugFromMarker(value: string | null | undefined) {
  return markerPattern.exec(value ?? "")?.[1] ?? null;
}

export function referralTouchFromLocation(search: string) {
  return referralSlugFromMarker(new URLSearchParams(search).get("fx_ref"));
}

export function storedReferralSlug(cookie: string) {
  const marker = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("fx_ref="))?.slice("fx_ref=".length);
  try { return referralSlugFromMarker(marker && decodeURIComponent(marker)); } catch { return null; }
}

export function storeReferralMarker(marker: string) {
  // This is a functional first-party marker only. It carries no customer data
  // and is intentionally unrelated to analytics consent.
  document.cookie = `fx_ref=${encodeURIComponent(marker)}; Path=/; Max-Age=${REFERRAL_MARKER_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}
