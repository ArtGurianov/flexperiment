import { describe, expect, it } from "vitest";
import { classifyFreshness } from "./freshness";

const base = {
  isPlaceholderData: false,
  isFetching: false,
  isRefetchError: false,
  isLoadingError: false,
  errorUpdatedAt: 0,
  hasData: true,
  lastKnownGoodAt: 1000,
};

describe("classifyFreshness", () => {
  it("shows the placeholder band during a filter transition, not the new-filter's rows as current", () => {
    expect(classifyFreshness({ ...base, isPlaceholderData: true, isFetching: true })).toEqual({ kind: "placeholder" });
  });

  it("shows the failure band when isRefetchError fires, keeping the last-good timestamp", () => {
    expect(classifyFreshness({ ...base, isRefetchError: true, errorUpdatedAt: 2000 }))
      .toEqual({ kind: "failedRefetch", errorAt: 2000, lastGoodAt: 1000 });
  });

  it("uses the errorUpdatedAt > lastKnownGoodAt backstop even when isRefetchError does not fire (v5 placeholderData forces status success)", () => {
    // This is the scenario the plan flags as unverifiable from docs alone:
    // a background refetch fails *during a filter transition*. isPlaceholderData
    // is no longer true by the time the failure lands (isFetching settled to
    // false), isRefetchError may not have fired, but errorUpdatedAt moved past
    // the last known-good timestamp — that alone must trip the failure band.
    expect(classifyFreshness({ ...base, isRefetchError: false, errorUpdatedAt: 5000, lastKnownGoodAt: 1000 }))
      .toEqual({ kind: "failedRefetch", errorAt: 5000, lastGoodAt: 1000 });
  });

  it("does not show the failure band for a stale errorUpdatedAt from before the last success", () => {
    expect(classifyFreshness({ ...base, errorUpdatedAt: 500, lastKnownGoodAt: 1000 })).toEqual({ kind: "fresh", updatedAt: 1000 });
  });

  it("shows the loading-error state only when there has never been data", () => {
    expect(classifyFreshness({ ...base, isLoadingError: true, hasData: false })).toEqual({ kind: "loadingError" });
  });

  it("prefers the failure band over loading-error when data exists (a refetch failure on a previously-successful query is not a first-load failure)", () => {
    expect(classifyFreshness({ ...base, isLoadingError: true, hasData: true, isRefetchError: true })).toEqual({ kind: "failedRefetch", errorAt: 0, lastGoodAt: 1000 });
  });

  it("shows a plain fetching state mid-poll with no error", () => {
    expect(classifyFreshness({ ...base, isFetching: true })).toEqual({ kind: "fetching" });
  });

  it("shows fresh with the last-good timestamp otherwise", () => {
    expect(classifyFreshness(base)).toEqual({ kind: "fresh", updatedAt: 1000 });
  });
});
