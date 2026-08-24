import { describe, expect, it } from "vitest";
import { AdminApiError } from "./api";
import { ADMIN_COMMAND_ERROR_CODES, IDEMPOTENCY_DISPOSITION, REFRESH_DISPOSITION, safeToMintNewKey, shouldRefreshAuthoritativeState } from "./idempotency";

describe("admin command idempotency", () => {
  it("requires every reviewed command error to have an explicit classification", () => {
    expect(Object.keys(IDEMPOTENCY_DISPOSITION).sort()).toEqual([...ADMIN_COMMAND_ERROR_CODES].sort());
    expect(Object.keys(REFRESH_DISPOSITION).sort()).toEqual([...ADMIN_COMMAND_ERROR_CODES].sort());
  });

  it("refreshes rejected stale-state commands independently of key safety", () => {
    const error = new AdminApiError(409, "OCCURRENCE_REVISION_CONFLICT");
    expect(safeToMintNewKey(error)).toBe(true);
    expect(shouldRefreshAuthoritativeState(error)).toBe(true);
  });

  it("treats unknown and provider-side results as ambiguous", () => {
    const unknown = new AdminApiError(409, "FUTURE_DOMAIN_CODE");
    expect(safeToMintNewKey(unknown)).toBe(false);
    expect(shouldRefreshAuthoritativeState(unknown)).toBe(true);
    expect(safeToMintNewKey(new AdminApiError(503, "PROVIDER_RECONCILIATION_UNAVAILABLE"))).toBe(false);
  });

  it("only allows a fresh key for middleware or explicitly safe validation failures", () => {
    expect(safeToMintNewKey(new AdminApiError(429, "RATE_LIMITED"))).toBe(true);
    expect(safeToMintNewKey(new AdminApiError(422, "VALIDATION_ERROR"))).toBe(true);
    expect(safeToMintNewKey(new AdminApiError(409, "IDEMPOTENCY_CONFLICT"))).toBe(false);
  });
});
