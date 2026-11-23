/**
 * FLEX-119 · the native acquiring provider port (contract §10). One real adapter is added only once the
 * provider and an admitted environment are confirmed; tests use the fake in test/fixtures.
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
};

export type NativeCreateAnswer =
  | { readonly outcome: "ACCEPTED"; readonly providerPaymentId: string; readonly paymentUrl?: string }
  | { readonly outcome: "REFUSED"; readonly code: string };

export type NativePaymentReadBack =
  | { readonly outcome: "NOT_FOUND" }
  | {
    readonly outcome: "FOUND"; readonly providerPaymentId: string; readonly status: "PENDING" | "PAID" | "DECLINED" | "EXPIRED";
    readonly merchantOrderRef: string; readonly amountKopecks: number; readonly currency: string; readonly snapshotHash: string;
    readonly providerReceiptRef?: string;
    readonly paymentUrl?: string;
  };

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

export interface NativePaymentProvider {
  readonly name: string;
  createPayment(request: FrozenNativePaymentRequest): Promise<NativeCreateAnswer>;
  /** Authoritative, by our merchant order ref. */
  readPaymentByOrder(merchantOrderRef: string): Promise<NativePaymentReadBack>;
  submitRefund(request: FrozenNativeRefundRequest): Promise<NativeRefundAnswer>;
  /** Authoritative, by our refund ref. */
  readRefund(refundRef: string): Promise<NativeRefundReadBack>;
  /** null: signature invalid or body unusable. Never throws for a forged body. */
  verifyCallback(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array): NativeCallbackHint | null;
}
