import { useState } from "react";

/**
 * v5's `placeholderData` reports `dataUpdatedAt === 0` while a placeholder is
 * showing (unlike the old `keepPreviousData`, which kept the previous
 * query's timestamp). This tracks the last genuinely non-zero timestamp
 * across renders so freshness classification never dates rows at the epoch.
 *
 * Uses the "adjusting state during render" pattern rather than a ref read
 * during render (React's react-hooks/refs rule forbids the latter — refs
 * aren't render inputs).
 */
export function useLastKnownGoodAt(dataUpdatedAt: number): number {
  const [lastKnownGoodAt, setLastKnownGoodAt] = useState(dataUpdatedAt);
  if (dataUpdatedAt > 0 && dataUpdatedAt !== lastKnownGoodAt) {
    setLastKnownGoodAt(dataUpdatedAt);
  }
  return lastKnownGoodAt || dataUpdatedAt;
}
