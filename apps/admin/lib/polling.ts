/**
 * Per-resource poll intervals in ms, or `false` for no polling. Values come
 * from the plan's request-budget analysis (lib/polling.test.ts asserts the
 * admin-scope rolling-60s aggregate stays under the 120 req/60s server limit
 * — see commerce/src/api.ts:231, keyed per-admin, not per-tab or per-screen).
 */
export const POLL_INTERVAL = {
  refunds: 10_000,
  orderEvidence: 10_000,
  cancellationFinancials: 15_000,
  orders: 20_000,
  dashboard: 30_000,
  emailAttention: 30_000,
  incidents: 30_000,
  settlements: 30_000,
  occurrences: 30_000,
  cities: false,
  audit: false,
} as const;

/** Hidden tabs don't poll (refetchIntervalInBackground stays off, the default),
 * so req/min figures below assume the tab is visible. */
export const REQUESTS_PER_MINUTE = Object.fromEntries(
  Object.entries(POLL_INTERVAL).map(([key, interval]) => [key, interval === false ? 0 : 60_000 / interval]),
) as Record<keyof typeof POLL_INTERVAL, number>;
