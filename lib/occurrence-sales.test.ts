import { describe, expect, it } from "vitest";
import { canRequestCheckout, purchaseStatusAnnouncement } from "./occurrence-sales";

describe("public occurrence sales UX", () => {
  it("keeps a published closed occurrence selectable as an announcement without checkout", () => {
    expect(canRequestCheckout({ purchase_status: "NOT_YET_OPEN" })).toBe(false);
    expect(purchaseStatusAnnouncement("NOT_YET_OPEN")).toBe("Продажи пока закрыты.");
  });

  it("permits checkout only for open occurrences with availability", () => {
    expect(canRequestCheckout({ purchase_status: "AVAILABLE" })).toBe(true);
    expect(canRequestCheckout({ purchase_status: "SOLD_OUT" })).toBe(false);
    expect(canRequestCheckout({ purchase_status: "TEMPORARILY_PAUSED" })).toBe(false);
  });
});
