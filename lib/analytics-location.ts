const MARKETING_QUERY_PARAMETERS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "yclid",
]);

export const isAnalyticsEligibleRoute = (pathname: string) => !(
  pathname === "/ticket" ||
  pathname.startsWith("/ticket/") ||
  pathname === "/refund" ||
  pathname.startsWith("/refund/") ||
  pathname === "/payment/success" ||
  pathname.startsWith("/payment/success/") ||
  pathname === "/admin" ||
  pathname.startsWith("/admin/")
);

/**
 * The only page address passed to Metrika. Query values are opt-in marketing
 * fields only; hashes are deliberately not accepted by this API at all.
 */
export function safeAnalyticsLocation(
  pathname: string,
  search: string,
): string | null {
  if (!pathname.startsWith("/") || !isAnalyticsEligibleRoute(pathname)) return null;

  const hashFreeSearch = search.split("#", 1)[0];
  const entries = [...new URLSearchParams(hashFreeSearch).entries()]
    .filter(([key]) => MARKETING_QUERY_PARAMETERS.has(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
  const query = new URLSearchParams(entries).toString();
  return query ? `${pathname}?${query}` : pathname;
}
