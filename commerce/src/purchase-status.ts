export type PurchaseStatus =
  | "AVAILABLE"
  | "SOLD_OUT"
  | "NOT_YET_OPEN"
  | "TEMPORARILY_PAUSED"
  | "UNAVAILABLE";

export type AvailabilityStatus = "AVAILABLE" | "FEW_LEFT" | "SOLD_OUT";
export const FEW_LEFT_THRESHOLD = 5;
export const availabilityStatus = (available: number): AvailabilityStatus =>
  available <= 0 ? "SOLD_OUT" : available <= FEW_LEFT_THRESHOLD ? "FEW_LEFT" : "AVAILABLE";

/**
 * Public purchase availability. This is intentionally pure: callers decide
 * whether the globally authoritative new-order gate is blocking once, then
 * share the same precedence with reads and notification lifecycle work.
 */
export const purchaseStatus = (input: {
  salesStatus: "OPEN" | "PAUSED" | "CLOSED";
  fulfillmentStatus: "SCHEDULED" | "COMPLETED" | "CANCELLED";
  startsAtMs: number;
  nowMs: number;
  availability: number;
  newOrdersBlocked: boolean;
}): PurchaseStatus => {
  if (input.fulfillmentStatus !== "SCHEDULED" || input.startsAtMs <= input.nowMs) return "UNAVAILABLE";
  if (input.newOrdersBlocked || input.salesStatus === "PAUSED") return "TEMPORARILY_PAUSED";
  if (input.salesStatus === "CLOSED") return "NOT_YET_OPEN";
  if (input.availability <= 0) return "SOLD_OUT";
  return "AVAILABLE";
};
