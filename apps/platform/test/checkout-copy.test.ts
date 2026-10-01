import { describe, expect, it } from "vitest";
import { checkoutCodeMessage } from "../components/checkout/checkout-copy";

describe("checkout code feedback", () => {
  it.each([
    ["APPLIED", "Код Refref применён."],
    ["NOT_RECOGNIZED", "Код не распознан; цена без скидки Refref."],
    ["NOT_APPLICABLE", "Код неприменим к этому предложению."],
    ["NOT_APPLIED_ATTRIBUTION_LOCKED", "Код не применён: текущая атрибуция зафиксирована."],
    ["NOT_APPLIED_CUSTOMER_KEPT_CURRENT", "Сохранена текущая атрибуция."],
  ] as const)("shows %s without turning it into a checkout error", (outcome, copy) => {
    expect(checkoutCodeMessage(null, outcome)).toBe(copy);
  });

  it("prefers the locally applied merchant promotion evidence", () => {
    expect(checkoutCodeMessage("FX-LAUNCH", "NONE")).toBe("Промокод FX-LAUNCH применён.");
  });
});
