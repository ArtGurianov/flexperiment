export type PromoDiscountType = "NONE" | "PERCENT" | "FIXED";
import { basisPointsOf } from "./basis-points";

export class PromoPricingError extends Error {
  constructor(readonly code: "PROMO_TERMS_INVALID" | "PROMO_ZERO_PRICE_NOT_ALLOWED") { super(code); }
}

export type PromoPrice = {
  discountKopecks: number;
  finalAmountKopecks: number;
};

export function validatePromoTerms(type: unknown, value: unknown): asserts type is PromoDiscountType {
  const discountValue = Number(value);
  if (!Number.isSafeInteger(discountValue)) throw new PromoPricingError("PROMO_TERMS_INVALID");
  if (type === "NONE" && discountValue === 0) return;
  if (type === "PERCENT" && discountValue >= 1 && discountValue <= 9_999) return;
  if (type === "FIXED" && discountValue > 0) return;
  throw new PromoPricingError("PROMO_TERMS_INVALID");
}

/**
 * The one pricing authority used by checkout and the pre-cutover audit.  Keep
 * this integer-only: a floating-point percentage is not payment evidence.
 */
export function pricePromo(priceKopecks: number, type: unknown, value: unknown): PromoPrice {
  const discountType = type as PromoDiscountType;
  const discountValue = Number(value);
  if (!Number.isSafeInteger(priceKopecks) || priceKopecks < 1) throw new PromoPricingError("PROMO_TERMS_INVALID");
  validatePromoTerms(discountType, discountValue);

  let discountKopecks: number;
  if (discountType === "NONE") {
    discountKopecks = 0;
  } else if (discountType === "PERCENT") {
    discountKopecks = basisPointsOf(priceKopecks, discountValue);
  } else if (discountType === "FIXED") {
    discountKopecks = discountValue;
  } else {
    throw new PromoPricingError("PROMO_TERMS_INVALID");
  }

  if (discountKopecks < 0 || discountKopecks >= priceKopecks) throw new PromoPricingError("PROMO_ZERO_PRICE_NOT_ALLOWED");
  return { discountKopecks, finalAmountKopecks: priceKopecks - discountKopecks };
}
