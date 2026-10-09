import type { CollectionBeforeChangeHook } from "payload";
import { validPaymentPurpose } from "../../../commerce-v2/src/payment-purpose";
import { freshPurposeSummary } from "./merchant-offer-facts";
export { freshPurposeSummary } from "./merchant-offer-facts";

export const requirePublishedOfferPurpose: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  if ((req.context as Record<string, unknown>).__lmsDraftOperation === true
    || (data._status ?? originalDoc?._status) !== "published") return data;
  const courseRef = data.courseRef ?? originalDoc?.courseRef;
  if (typeof courseRef !== "string" || !courseRef) return data; // no configured offer before its stable ref exists
  const summary = await freshPurposeSummary(courseRef);
  if (summary?.accessModel === "PAID" && summary.offerRef && !validPaymentPurpose(summary.paymentPurpose)) {
    throw new Error("PAYMENT_PURPOSE_REQUIRED");
  }
  return data;
};
