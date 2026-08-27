import { describe, expect, it } from "vitest";
import { PromoPricingError, pricePromo, validatePromoTerms } from "../src/promo-pricing";

describe("Promo Codes v0 pricing", () => {
  it("keeps percentage half-up arithmetic in integer kopecks", () => {
    expect(pricePromo(101, "PERCENT", 50)).toEqual({ discountKopecks: 1, finalAmountKopecks: 100 });
    expect(pricePromo(101, "FIXED", 1)).toEqual({ discountKopecks: 1, finalAmountKopecks: 100 });
    expect(pricePromo(101, "NONE", 0)).toEqual({ discountKopecks: 0, finalAmountKopecks: 101 });
  });

  it("rejects terms that could create a free order", () => {
    expect(() => pricePromo(1, "PERCENT", 9_999)).toThrow(new PromoPricingError("PROMO_ZERO_PRICE_NOT_ALLOWED"));
    expect(() => pricePromo(101, "FIXED", 101)).toThrow(new PromoPricingError("PROMO_ZERO_PRICE_NOT_ALLOWED"));
  });

  it("validates terms without needing an occurrence price", () => {
    expect(() => validatePromoTerms("NONE", 1)).toThrow(new PromoPricingError("PROMO_TERMS_INVALID"));
    expect(() => validatePromoTerms("PERCENT", 0)).toThrow(new PromoPricingError("PROMO_TERMS_INVALID"));
    expect(() => validatePromoTerms("FIXED", 0)).toThrow(new PromoPricingError("PROMO_TERMS_INVALID"));
  });
});
