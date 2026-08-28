import { describe, expect, it } from "vitest";
import { purchaseStatus } from "../src/purchase-status";

const base = { salesStatus: "OPEN" as const, fulfillmentStatus: "SCHEDULED" as const, startsAtMs: Date.parse("2030-01-01T10:00:00+07:00"), nowMs: Date.parse("2029-12-31T20:00:00Z"), availability: 1, newOrdersBlocked: false };

describe("purchaseStatus", () => {
  it("uses its public precedence order and masks internal gate causes", () => {
    expect(purchaseStatus({ ...base, availability: 0, newOrdersBlocked: true })).toBe("TEMPORARILY_PAUSED");
    expect(purchaseStatus({ ...base, salesStatus: "CLOSED" })).toBe("NOT_YET_OPEN");
    expect(purchaseStatus({ ...base, availability: 0 })).toBe("SOLD_OUT");
    expect(purchaseStatus(base)).toBe("AVAILABLE");
    expect(purchaseStatus({ ...base, fulfillmentStatus: "CANCELLED", newOrdersBlocked: true })).toBe("UNAVAILABLE");
  });

  it("compares parsed timestamps, including an offset-bearing start boundary", () => {
    expect(purchaseStatus({ ...base, nowMs: Date.parse("2030-01-01T03:00:00Z") })).toBe("UNAVAILABLE");
    expect(purchaseStatus({ ...base, nowMs: Date.parse("2030-01-01T02:59:59Z") })).toBe("AVAILABLE");
  });
});
