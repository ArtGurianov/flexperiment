import { POLL_INTERVAL, REQUESTS_PER_MINUTE } from "./polling";

export type ScreenName =
  | "dashboard" | "cities" | "occurrences" | "orders" | "refunds"
  | "settlements" | "email-attention" | "incidents" | "audit";

export const SCREEN_NAMES: readonly ScreenName[] = [
  "dashboard", "cities", "occurrences", "orders", "refunds",
  "settlements", "email-attention", "incidents", "audit",
];

/**
 * Resources each screen keeps polling while visible, at the worst case for
 * that screen: Orders counts cities + occurrences (needed for its filter
 * selects) + the orders list + one open evidence panel; Occurrences counts
 * the occurrences list + one expanded cancellation-financials row (accordion
 * semantics bound this to O(1), never O(rows) — see F2). Cities and Audit
 * don't poll at all.
 */
const SCREEN_RESOURCES: Record<ScreenName, (keyof typeof POLL_INTERVAL)[]> = {
  dashboard: ["dashboard"],
  cities: ["cities"],
  occurrences: ["occurrences", "cancellationFinancials"],
  orders: ["cities", "occurrences", "orders", "orderEvidence"],
  refunds: ["refunds"],
  settlements: ["settlements"],
  "email-attention": ["emailAttention"],
  incidents: ["incidents"],
  audit: ["audit"],
};

/** Active queries per screen, for the refetchOnWindowFocus burst. */
const ACTIVE_QUERIES: Record<ScreenName, number> = {
  dashboard: 1, cities: 1, occurrences: 2, orders: 4, refunds: 1,
  settlements: 1, "email-attention": 1, incidents: 1, audit: 1,
};

// The widest invalidationKeysFor() result (lib/invalidation.ts), incl. the
// dashboard summary every mutation invalidates.
const MUTATION_FANOUT_MAX = 4;
// One retry each for at most two simultaneously in-flight polls (§1: polled
// queries use retry:false, so this covers only the non-polled fetches a
// screen also makes, e.g. cities/occurrences lists on first mount).
const RETRY_BUDGET_MAX = 2;
// One manual Refresh, bounded by the busier screen's active-query count.
const MANUAL_REFRESH_MAX = 4;

export const REQUEST_CEILING = 95;

export function screenRequestsPerMinute(screen: ScreenName): number {
  return SCREEN_RESOURCES[screen].reduce((sum, resource) => sum + REQUESTS_PER_MINUTE[resource], 0);
}

/**
 * The admin-scope rolling 60s request count for two simultaneously visible
 * screens (which may be the same screen in two browser windows — see the
 * P0 exit criterion's cross-window polling check). This is what the
 * `admin:${session.sub}` rate-limit bucket actually sees (commerce/src/api.ts:231):
 * one bucket per admin, not per tab, so this must be asserted as a sum, not
 * as two independent per-screen budgets.
 */
export function rollingSixtySecondBudget(screenA: ScreenName, screenB: ScreenName): number {
  const polling = screenRequestsPerMinute(screenA) + screenRequestsPerMinute(screenB);
  const focusBurst = ACTIVE_QUERIES[screenA] + ACTIVE_QUERIES[screenB];
  return polling + focusBurst + MUTATION_FANOUT_MAX + RETRY_BUDGET_MAX + MANUAL_REFRESH_MAX;
}
