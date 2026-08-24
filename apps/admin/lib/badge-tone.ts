export type BadgeTone = "good" | "warn" | "neutral";

const good = new Set([
  "ACCEPTED", "ACTIVE", "AUTHENTICATED", "COMPLETED", "CONFIRMED", "DELIVERED",
  "FULFILLED", "OPEN", "PAID", "PUBLISHED", "REFUNDED", "SENT", "SUCCEEDED", "VALID",
]);

const warn = new Set([
  "ABANDONED", "BOUNCED", "CANCELLED", "CLOSED", "CREATE_FAILED", "CREATE_UNKNOWN",
  "FAILED", "HIDDEN", "LATE_PAYMENT_REVIEW_REQUIRED", "PARTIALLY_REFUNDED", "PAUSED",
  "REVIEW_REQUIRED", "SEND_UNKNOWN", "SUBMIT_UNKNOWN", "UNKNOWN", "VOID",
]);

/** Known in-flight states deliberately stay neutral until the provider or domain
 * establishes a terminal outcome. */
export function badgeTone(value: unknown): BadgeTone {
  const status = typeof value === "string" ? value : "";
  if (good.has(status)) return "good";
  if (warn.has(status)) return "warn";
  return "neutral";
}
