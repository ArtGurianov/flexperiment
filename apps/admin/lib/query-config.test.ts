import { describe, expect, it } from "vitest";
import { AdminApiError } from "./api";
import { shouldRetryQuery } from "./query-config";

describe("shouldRetryQuery", () => {
  it("never retries a deterministic 4xx, including 401 and 429", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryQuery(0, new AdminApiError(status, "X"))).toBe(false);
    }
  });

  it("retries a network failure (status 0) exactly once", () => {
    expect(shouldRetryQuery(0, new AdminApiError(0, "NETWORK_AMBIGUOUS"))).toBe(true);
    expect(shouldRetryQuery(1, new AdminApiError(0, "NETWORK_AMBIGUOUS"))).toBe(false);
  });

  it("retries a 5xx exactly once", () => {
    expect(shouldRetryQuery(0, new AdminApiError(503, "X"))).toBe(true);
    expect(shouldRetryQuery(1, new AdminApiError(503, "X"))).toBe(false);
  });

  it("treats a non-AdminApiError as status 0 (one retry)", () => {
    expect(shouldRetryQuery(0, new Error("boom"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("boom"))).toBe(false);
  });
});
