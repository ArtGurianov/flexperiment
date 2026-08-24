import type { DefaultOptions } from "@tanstack/react-query";
import { AdminApiError } from "./api";

/**
 * v5 defaults to `retry: 3` with exponential backoff on the client. That would
 * triple every failing poll and blow the request budget in lib/polling.ts, so
 * every query goes through this predicate instead. Deterministic server
 * answers (4xx, including 429 and the 401 the middleware returns before the
 * handler runs) are never retried — only network failures (status 0) and 5xx
 * get a single retry.
 */
export const shouldRetryQuery = (failureCount: number, error: unknown) => {
  const status = error instanceof AdminApiError ? error.status : 0;
  if (status >= 400 && status < 500) return false;
  return failureCount < 1;
};

export const defaultQueryOptions: DefaultOptions = {
  queries: {
    retry: shouldRetryQuery,
    refetchOnWindowFocus: true,
  },
  mutations: {
    // A NETWORK_AMBIGUOUS mutation must never auto-retry — that is precisely
    // the case the idempotency key exists to survive. See lib/idempotency.ts.
    retry: 0,
  },
};
