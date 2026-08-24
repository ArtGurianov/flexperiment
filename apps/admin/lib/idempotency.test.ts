import { describe, expect, it } from "vitest";
import { AdminApiError } from "./api";
import { ADMIN_COMMAND_ERROR_SAFETY, safeToMintNewKey } from "./idempotency";

describe("admin command idempotency", () => {
  it("requires every reviewed command error to have an explicit classification", () => {
    expect(Object.keys(ADMIN_COMMAND_ERROR_SAFETY)).toEqual(expect.arrayContaining([
      "IDEMPOTENCY_CONFLICT", "REFUND_AMOUNT_EXCEEDS_AVAILABLE",
      "SETTLEMENT_RECOVERY_EXCEEDS_REMAINING", "VALIDATION_ERROR",
    ]));
  });

  it("treats unknown and provider-side results as ambiguous", () => {
    expect(safeToMintNewKey(new AdminApiError(409, "FUTURE_DOMAIN_CODE"))).toBe(false);
    expect(safeToMintNewKey(new AdminApiError(503, "PROVIDER_RECONCILIATION_UNAVAILABLE"))).toBe(false);
  });

  it("only allows a fresh key for middleware or explicitly safe validation failures", () => {
    expect(safeToMintNewKey(new AdminApiError(429, "RATE_LIMITED"))).toBe(true);
    expect(safeToMintNewKey(new AdminApiError(422, "VALIDATION_ERROR"))).toBe(true);
    expect(safeToMintNewKey(new AdminApiError(409, "IDEMPOTENCY_CONFLICT"))).toBe(false);
  });
});
