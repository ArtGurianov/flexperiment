/** FLEX-122: the buyer-facing payment projection (contract C §8, fixture `buyer-states.json`).
 *
 * The UI shows only these values and never infers payment from a redirect: a provider return only
 * triggers an authoritative status read. Two response shapes are accepted: the proposed order-status
 * DTO of C §8 (`payment`, `paymentUrl`, `supportReference`) and the current `GET /v1/checkout/:id`
 * reconcile answer (`state`, `checkoutUrl`). */
export type CheckoutKind = "COURSE" | "LAB";
export type BuyerPaymentStatus = "CONFIRMING" | "AWAITING_PAYMENT" | "ACCESS_GRANTED" | "TICKET_ISSUED"
  | "DECLINED" | "EXPIRED" | "SUPPORT_REVIEW";
export type BuyerRefundStatus = "REFUND_PROCESSING" | "REFUNDED" | "SUPPORT_REVIEW";

export type BuyerStatus = {
  orderPublicId: string;
  payment: BuyerPaymentStatus;
  refund?: BuyerRefundStatus;
  paymentUrl?: string;
  supportReference?: string;
};

const BUYER_PAYMENT = new Set<BuyerPaymentStatus>(["CONFIRMING", "AWAITING_PAYMENT", "ACCESS_GRANTED", "TICKET_ISSUED",
  "DECLINED", "EXPIRED", "SUPPORT_REVIEW"]);
const BUYER_REFUND = new Set<BuyerRefundStatus>(["REFUND_PROCESSING", "REFUNDED", "SUPPORT_REVIEW"]);
export const TERMINAL = new Set<BuyerPaymentStatus>(["ACCESS_GRANTED", "TICKET_ISSUED", "DECLINED", "EXPIRED", "SUPPORT_REVIEW"]);

/** Native payment states (C §3) and the current rail/attempt states, projected per C §8. */
export function projectPaymentState(state: string, kind: CheckoutKind): BuyerPaymentStatus {
  switch (state) {
    case "PAID": return kind === "LAB" ? "TICKET_ISSUED" : "ACCESS_GRANTED";
    case "PENDING": case "CUSTOMER_ACTION_REQUIRED": return "AWAITING_PAYMENT";
    case "DECLINED": return "DECLINED";
    case "EXPIRED": return "EXPIRED";
    case "REVIEW_REQUIRED": return "SUPPORT_REVIEW";
    // CREATING, CREATE_UNKNOWN and anything not known to this UI: still being confirmed, never "paid".
    default: return "CONFIRMING";
  }
}

export function projectRefundState(state: string): BuyerRefundStatus | undefined {
  switch (state) {
    case "SUBMITTING": case "SUBMIT_UNKNOWN": case "PROCESSING": case "REFUND_PENDING": return "REFUND_PROCESSING";
    case "SUCCEEDED": case "REFUNDED": return "REFUNDED";
    case "FAILED": case "REVIEW_REQUIRED": return "SUPPORT_REVIEW";
    default: return undefined;
  }
}

/** Only an https provider page or a same-origin path may be opened; anything else is dropped. */
export function safePaymentUrl(value: unknown, myOrigin: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, myOrigin);
    if (url.origin === new URL(myOrigin).origin) return url.toString();
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

type RawStatus = { orderPublicId?: unknown; payment?: unknown; refund?: unknown; paymentUrl?: unknown; supportReference?: unknown;
  state?: unknown; checkoutUrl?: unknown };

/** `null` when the answer names another order than the one asked about (never applied). */
export function normalizeStatus(raw: RawStatus, expectedOrder: string, kind: CheckoutKind, myOrigin: string): BuyerStatus | null {
  if (raw.orderPublicId !== undefined && raw.orderPublicId !== expectedOrder) return null;
  const payment = typeof raw.payment === "string" && BUYER_PAYMENT.has(raw.payment as BuyerPaymentStatus)
    ? raw.payment as BuyerPaymentStatus
    : projectPaymentState(typeof raw.state === "string" ? raw.state : "", kind);
  const refund = typeof raw.refund === "string"
    ? (BUYER_REFUND.has(raw.refund as BuyerRefundStatus) ? raw.refund as BuyerRefundStatus : projectRefundState(raw.refund))
    : typeof raw.state === "string" ? projectRefundState(raw.state) : undefined;
  const paymentUrl = payment === "AWAITING_PAYMENT" ? safePaymentUrl(raw.paymentUrl ?? raw.checkoutUrl, myOrigin) : undefined;
  const supportReference = typeof raw.supportReference === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(raw.supportReference)
    ? raw.supportReference : undefined;
  // A refund state in the legacy `state` field means the payment itself was received.
  const effectivePayment = refund && typeof raw.payment !== "string" ? (kind === "LAB" ? "TICKET_ISSUED" : "ACCESS_GRANTED") : payment;
  return { orderPublicId: expectedOrder, payment: effectivePayment, ...(refund ? { refund } : {}),
    ...(paymentUrl ? { paymentUrl } : {}), ...(supportReference ? { supportReference } : {}) };
}

/** Accepts a status answer in request order. A late answer (older request) is dropped; an in-order
 * answer may not move a terminal payment back to a non-terminal one. Only `SUPPORT_REVIEW` (a
 * server-side contradiction, C I6) may replace another terminal state. */
export function acceptStatus(current: { seq: number; status: BuyerStatus } | null, seq: number, next: BuyerStatus) {
  if (current && seq <= current.seq) return current;
  if (current && current.status.orderPublicId !== next.orderPublicId) return current;
  if (current && TERMINAL.has(current.status.payment) && current.status.payment !== next.payment) {
    if (next.payment !== "SUPPORT_REVIEW") return { seq, status: { ...current.status, ...(next.refund ? { refund: next.refund } : {}) } };
  }
  return { seq, status: next };
}
