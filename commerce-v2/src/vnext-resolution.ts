import { z } from "zod";
import { digest, resolutionInputHash } from "./refref-contract/shared-checkout-snapshot";
import type { PaymentResolveInput, RailResolution } from "./checkout";

export const vnextCodeOutcomes = ["NONE", "APPLIED", "ALREADY_APPLIED_BY_ARRIVAL", "NOT_APPLIED_ARRIVAL_PRIORITY",
  "NOT_APPLIED_CAMPAIGN_PAUSED", "NOT_APPLICABLE", "NOT_RECOGNIZED"] as const;
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const degraded = z.union([z.strictObject({ degraded: z.literal(false) }),
  z.strictObject({ degraded: z.literal(true), reason: z.enum(["TIMEOUT", "FAILED", "EXPIRED"]) })]);
// Exact BrowserContextResolution in Refref docs/openapi-vnext.yaml (93b6a41).
export const vnextResolutionSchema = z.strictObject({
  referralResolutionId: z.uuid(), merchantOrderRef: z.string(), storefrontOrigin: z.url(), browserContextId: z.string(),
  attributionSource: z.enum(["ARRIVAL", "PROMO", "UNATTRIBUTED"]), campaignId: z.uuid().nullable(), termsVersionId: z.uuid().nullable(),
  checkoutCodeOutcome: z.enum(vnextCodeOutcomes), deliveryDegraded: degraded, inputHash: z.string(), currency: z.literal("RUB"),
  lines: z.array(z.strictObject({ lineRef: z.string(), eligible: z.boolean(), referralDiscountAmountKopecks: money })).min(1).max(100),
  totals: z.strictObject({ merchantOfferAmountKopecks: money, referralDiscountAmountKopecks: money, payableAmountKopecks: money }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export function consumeVnextResolution(input: PaymentResolveInput, merchantId: string,
  resolved: z.infer<typeof vnextResolutionSchema>): RailResolution {
  const request = input.request;
  const hash = resolutionInputHash({ schema: "refref.referral-resolution-input/1", merchantId,
    merchantOrderRef: request.merchantOrderRef, currency: request.currency, lines: request.lines });
  if (resolved.merchantOrderRef !== request.merchantOrderRef || resolved.storefrontOrigin !== request.storefrontOrigin
    || resolved.browserContextId !== request.browserContextId || resolved.inputHash !== hash
    || digest(resolved.deliveryDegraded) !== digest(request.deliveryDegraded)
    || resolved.lines.length !== request.lines.length || new Set(resolved.lines.map(l => l.lineRef)).size !== resolved.lines.length) {
    throw new Error("REFREF_RESPONSE_INVALID:VNEXT_BINDING");
  }
  let gross = 0, discount = 0;
  for (const line of request.lines) {
    const resolvedLine = resolved.lines.find(l => l.lineRef === line.lineRef);
    if (!resolvedLine || (!resolvedLine.eligible && resolvedLine.referralDiscountAmountKopecks !== 0)
      || resolvedLine.referralDiscountAmountKopecks > line.merchantOfferAmountKopecks) throw new Error("REFREF_RESPONSE_INVALID:VNEXT_LINE");
    gross += line.merchantOfferAmountKopecks;
    discount += resolvedLine.referralDiscountAmountKopecks;
  }
  if (!Number.isSafeInteger(gross) || !Number.isSafeInteger(discount) || gross !== resolved.totals.merchantOfferAmountKopecks
    || discount !== resolved.totals.referralDiscountAmountKopecks || gross - discount !== resolved.totals.payableAmountKopecks) {
    throw new Error("REFREF_RESPONSE_INVALID:VNEXT_TOTALS");
  }
  if (gross - discount <= 0) throw new Error("REFREF_ZERO_PAYMENT_UNSUPPORTED");
  return { state: "PRICE_REVIEW_REQUIRED", quote: { resolutionId: resolved.referralResolutionId, termsVersionId: resolved.termsVersionId,
    baseAmountKopecks: gross, discountKopecks: discount, finalAmountKopecks: gross - discount,
    checkoutCodeOutcome: resolved.checkoutCodeOutcome, expiresAt: resolved.expiresAt } };
}
