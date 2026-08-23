import { describe, expect, it } from "vitest";
import { canRequestCheckout, isPublicOccurrenceSelectable, salesAnnouncement } from "./occurrence-sales";

describe("public occurrence sales UX", () => {
  it("keeps a published closed occurrence selectable as an announcement without checkout", () => {
    const occurrence = { id: "closed", sales_status: "CLOSED" as const, availability: 0 };
    expect(isPublicOccurrenceSelectable(occurrence)).toBe(true);
    expect(canRequestCheckout(occurrence)).toBe(false);
    expect(salesAnnouncement(occurrence.sales_status)).toBe("Продажи пока закрыты.");
  });

  it("permits checkout only for open occurrences with availability", () => {
    expect(canRequestCheckout({ sales_status: "OPEN", availability: 1 })).toBe(true);
    expect(canRequestCheckout({ sales_status: "OPEN", availability: 0 })).toBe(false);
    expect(canRequestCheckout({ sales_status: "PAUSED", availability: 1 })).toBe(false);
  });
});
