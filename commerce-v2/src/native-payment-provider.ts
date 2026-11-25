/**
 * FLEX-119 · the native acquiring provider port (contract §10). Each adapter owns the translation between
 * its provider protocol and the ledger’s frozen bindings.
 *
 * Transport contract: a method that throws (timeout, reset, 5xx, unparseable body) is treated as a LOST
 * answer for a submission and as UNAVAILABLE for a read-back. Only `REFUSED` with request-bound proof
 * says the provider did not accept a request.
 */

/** The exact request a payment will ever send, frozen and sealed before the first send. */
export type FrozenNativePaymentRequest = {
  readonly idempotencyKey: string;
  readonly paymentRef: string;
  readonly merchantOrderRef: string;
  readonly amountKopecks: number;
  readonly currency: "RUB";
  readonly snapshotHash: string;
  readonly purpose: string;
  readonly taxSystem?: string;
  readonly successUrl?: string;
  readonly receiptEmail: string;
  readonly fiscalItems: readonly unknown[];
};

/** The exact refund request, frozen and sealed before the first send (same discipline as ART-174). */
export type FrozenNativeRefundRequest = {
  readonly idempotencyKey: string;
  readonly refundRef: string;
  readonly providerPaymentId: string;
  readonly amountKopecks: number;
  readonly currency: "RUB";
  readonly receiptEmail: string;
  readonly fiscalItems: readonly unknown[];
  readonly paymentKey?: RefundReadKey;
};

export type NativeCreateAnswer =
  | { readonly outcome: "ACCEPTED"; readonly providerPaymentId: string; readonly paymentUrl?: string }
  | { readonly outcome: "REFUSED"; readonly code: string };

export type NativeReadBackIssue =
  | "TOCHKA_RESPONSE_INVALID"
  | "TOCHKA_PAYMENT_IDENTITY_CONFLICT"
  | "TOCHKA_PAYMENT_DUPLICATE"
  | "TOCHKA_PAYMENT_APPROVAL_CONFLICT"
  | "TOCHKA_PAYMENT_STATUS_UNSUPPORTED"
  | "TOCHKA_REFUND_IDENTITY_CONFLICT"
  | "TOCHKA_REFUND_STATUS_UNSUPPORTED"
  | "TOCHKA_PAYMENT_LOOKUP_BUDGET_EXCEEDED";

export class NativeReadBackError extends Error {
  constructor(readonly code: NativeReadBackIssue) { super(code); }
}

export type NativePaymentReadBack =
  | { readonly outcome: "NOT_FOUND" }
  | {
    readonly outcome: "FOUND"; readonly providerPaymentId: string; readonly status: "PENDING" | "PAID" | "DECLINED" | "EXPIRED";
    readonly merchantOrderRef: string; readonly amountKopecks: number; readonly currency: string; readonly snapshotHash: string;
    readonly paymentUrl?: string;
  };

export type NativeRefundPreflight =
  | { readonly outcome: "READY" }
  | { readonly outcome: "UNAVAILABLE" }
  | { readonly outcome: "CONFLICT" | "ALREADY_REFUNDED" | "DEFINITIVE_REFUSAL"; readonly code: string };

export type NativeRefundAnswer =
  | { readonly outcome: "ACCEPTED"; readonly providerRefundId: string }
  | { readonly outcome: "REFUSED"; readonly code: string; readonly proven: boolean };

export type NativeRefundReadBack =
  | { readonly outcome: "NOT_FOUND" }
  | {
    readonly outcome: "FOUND"; readonly providerRefundId: string; readonly status: "PROCESSING" | "SUCCEEDED" | "FAILED";
    readonly providerPaymentId: string; readonly amountKopecks: number; readonly currency: string; readonly refundRef: string;
  };

/** What a verified callback names; it never carries a state the ledger acts on. */
export type NativeCallbackHint = {
  readonly providerEventId: string;
  readonly subjectKind: "PAYMENT" | "REFUND";
  readonly providerSubjectId: string;
};

export type PaymentReadKey = { readonly snapshotHash: string; readonly providerPaymentId: string | null; readonly createdAt: string; readonly signal?: AbortSignal };
export type RefundReadKey = {
  readonly providerPaymentId: string; readonly merchantOrderRef: string; readonly snapshotHash: string;
};

export interface NativePaymentProvider {
  readonly name: string;
  /** Stable connection identity, independent of credential rotation. */
  readonly executorKey?: string;
  /** The automatic issuer's read-only view. The money endpoints cannot confirm a receipt. */
  readonly readAutomaticReceipt?: (kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT", paymentId: string, refundId: string | null) =>
    Promise<import("./fiscal-port").FiscalReadBack>;
  /** Provider, not merchant, guarantees a repeated key cannot create a second financial effect. */
  readonly replayGuarantees: { readonly payment: boolean; readonly refund: boolean };
  createPayment(request: FrozenNativePaymentRequest): Promise<NativeCreateAnswer>;
  /** Authoritative, by our merchant order ref. */
  readPaymentByOrder(merchantOrderRef: string, key: PaymentReadKey): Promise<NativePaymentReadBack>;
  /** Optional read-only check before the ledger records first dispatch. */
  prepareRefund?(request: FrozenNativeRefundRequest): Promise<NativeRefundPreflight>;
  submitRefund(request: FrozenNativeRefundRequest): Promise<NativeRefundAnswer>;
  /** Authoritative, by our refund ref. */
  readRefund(refundRef: string, key: RefundReadKey): Promise<NativeRefundReadBack>;
  /** null: signature invalid or body unusable. Never throws for a forged body. */
  verifyCallback(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array): NativeCallbackHint | null | Promise<NativeCallbackHint | null>;
}
