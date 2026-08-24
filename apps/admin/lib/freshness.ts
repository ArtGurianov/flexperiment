/**
 * A5-adjacent truthfulness contract for panels backed by TanStack Query.
 * Polling alone doesn't make a screen truthful — the client keeps the last
 * successful `data` when a background refetch fails, so a table can sit
 * indefinitely on stale rows while nothing on screen says the connection is
 * gone. This is the same failure as A1/A2 approached from the other
 * direction, so no panel may render server data without going through this.
 *
 * Two v5 behaviours make the naive implementation wrong:
 *  - `isPlaceholderData` reports `dataUpdatedAt === 0` during a filter
 *    transition, so the caller must track the last non-zero timestamp
 *    itself (see useLastKnownGoodAt) rather than trusting dataUpdatedAt raw.
 *  - `placeholderData` forces status "success", so a failed background
 *    refetch might not flip isRefetchError while a placeholder is showing.
 *    `errorUpdatedAt > lastKnownGoodAt` is the backstop for that one case;
 *    the DOM test is the arbiter of whether it's ever load-bearing.
 */
export type FreshnessState =
  | { kind: "placeholder" }
  | { kind: "failedRefetch"; errorAt: number; lastGoodAt: number }
  | { kind: "loadingError" }
  | { kind: "fetching" }
  | { kind: "fresh"; updatedAt: number };

export type FreshnessInput = {
  isPlaceholderData: boolean;
  isFetching: boolean;
  isRefetchError: boolean;
  isLoadingError: boolean;
  errorUpdatedAt: number;
  hasData: boolean;
  /** The last dataUpdatedAt that was ever non-zero — never the raw,
   * possibly-placeholder-zeroed dataUpdatedAt. */
  lastKnownGoodAt: number;
};

export function classifyFreshness(input: FreshnessInput): FreshnessState {
  if (input.isPlaceholderData && input.isFetching) return { kind: "placeholder" };
  const staleAfterFailure = input.isRefetchError || input.errorUpdatedAt > input.lastKnownGoodAt;
  if (staleAfterFailure && input.hasData) return { kind: "failedRefetch", errorAt: input.errorUpdatedAt, lastGoodAt: input.lastKnownGoodAt };
  if (input.isLoadingError) return { kind: "loadingError" };
  if (input.isFetching) return { kind: "fetching" };
  return { kind: "fresh", updatedAt: input.lastKnownGoodAt };
}
