import { describe, expect, it } from "vitest";
import { safeAnalyticsLocation } from "./analytics-location";

describe("safe analytics location", () => {
  it("retains only an explicit, stable marketing query allowlist", () => {
    expect(safeAnalyticsLocation("/kemerovo", "?fx_ref=v1%3Aagent&promo_code=SAVE&email=a%40b.test&utm_campaign=fall&yclid=7&unknown=x")).toBe("/kemerovo?utm_campaign=fall&yclid=7");
    expect(safeAnalyticsLocation("/", "?utm_term=move&utm_source=vk")).toBe("/?utm_source=vk&utm_term=move");
  });

  it("excludes evidence-bearing routes completely", () => {
    expect(safeAnalyticsLocation("/ticket", "")).toBeNull();
    expect(safeAnalyticsLocation("/refund", "?order=FX-1")).toBeNull();
    expect(safeAnalyticsLocation("/refund/confirm", "")).toBeNull();
    expect(safeAnalyticsLocation("/payment/success", "?order=public-status")).toBeNull();
  });

  it("uses the sanitized address as a hash-free navigation identity", () => {
    expect(safeAnalyticsLocation("/kemerovo", "?fx_ref=v1%3Aagent")).toBe("/kemerovo");
    expect(safeAnalyticsLocation("not-a-path", "?utm_source=vk")).toBeNull();
  });
});
