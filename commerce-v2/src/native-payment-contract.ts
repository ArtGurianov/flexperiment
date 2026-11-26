/**
 * FLEX-119 · native payment, refund and fiscal contract (docs/plans/2026-11-20-native-payment-refund-contract.md).
 *
 * Pure decision tables only: no database, no provider, no route. A durable implementation applies an
 * observation to the stored record inside one SQLite transaction and then performs the returned
 * effects. Each effect carries a deterministic key derived from the immutable order snapshot, so
 * performing it twice is the same request at the provider (or the same row locally), never a second
 * financial effect.
 *
 * Authority rules this module encodes:
 *  - A financial fact comes only from an authenticated provider READ_BACK bound to the frozen order
 *    (merchant order ref, amount, currency, snapshot hash). A callback is a hint that schedules a read-back.
 *  - A lost answer is UNKNOWN, never absence. Absence is never concluded; the same request is replayed
 *    under the same key, and only while sales admission allows new money.
 *  - Access/ticket (GRANT) happens once, on the transition into PAID. Revocation (REVOKE_ACCESS) happens
 *    once, on the transition of a full-line refund into SUCCEEDED.
 *  - Fiscal events are reconciled separately and never produce or block a financial effect.
 */

import type { NativeReadBackIssue, NativeReadBackUnavailableCode } from "./native-payment-provider";

export const NATIVE_CONTRACT_VERSION = "flexperiment.native-payment-contract/1" as const;

export type ProductKind = "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB";
export type PaymentContour = "NATIVE" | "REFREF_RC2";

/** The frozen binding every provider fact must match. Built once from the order snapshot. */
export type PaymentBinding = {
  readonly merchantOrderRef: string;
  readonly amountKopecks: number;
  readonly currency: "RUB";
  /** sha256 of the canonical order snapshot (orders.snapshot_hash). */
  readonly snapshotHash: string;
};

export const paymentKeys = (orderPublicId: string) => ({
  paymentRef: `pay:${orderPublicId}`,
  idempotencyKey: `native-pay:${orderPublicId}:1`,
});
export const refundKeys = (refundRequestPublicId: string) => ({
  refundRef: `refund:${refundRequestPublicId}`,
  idempotencyKey: `native-refund:${refundRequestPublicId}:1`,
});
export const fiscalEventRef = (kind: FiscalEventKind, orderLineId: string, refundRequestPublicId?: string) =>
  kind === "REFUND_RECEIPT" ? `fiscal:REFUND_RECEIPT:${orderLineId}:${refundRequestPublicId}` : `fiscal:${kind}:${orderLineId}`;

// ─── Payment ────────────────────────────────────────────────────────────────────────────────────────

export type NativePaymentState = "CREATING" | "CREATE_UNKNOWN" | "PENDING" | "PAID" | "DECLINED" | "EXPIRED" | "REVIEW_REQUIRED";
export const TERMINAL_PAYMENT_STATES: readonly NativePaymentState[] = ["DECLINED", "EXPIRED"];

export type ProviderPaymentStatus = "PENDING" | "PAID" | "DECLINED" | "EXPIRED";

export type PaymentObservation =
  /** The provider answered the create and accepted it (status is still only a hint until read-back). */
  | { readonly source: "CREATE_RESPONSE"; readonly outcome: "ACCEPTED"; readonly providerPaymentId: string }
  /** Timeout, connection reset, 5xx, unparseable body: the request may or may not have been accepted. */
  | { readonly source: "CREATE_RESPONSE"; readonly outcome: "LOST" }
  /** A request-bound refusal the provider proves it did not accept (e.g. validation of this exact body). */
  | { readonly source: "CREATE_RESPONSE"; readonly outcome: "REFUSED"; readonly code: string }
  | { readonly source: "CALLBACK"; readonly signatureValid: boolean; readonly providerPaymentId: string; readonly claimedStatus: string }
  | { readonly source: "READ_BACK"; readonly outcome: "UNAVAILABLE"; readonly code?: NativeReadBackUnavailableCode | "NATIVE_REFUND_PREFLIGHT_UNAVAILABLE" }
  | { readonly source: "READ_BACK"; readonly outcome: "REVIEW_REQUIRED"; readonly code: NativeReadBackIssue }
  | { readonly source: "READ_BACK"; readonly outcome: "DISPATCH_UNCERTAIN" }
  | { readonly source: "READ_BACK"; readonly outcome: "NOT_FOUND" }
  | {
    readonly source: "READ_BACK"; readonly outcome: "FOUND"; readonly providerPaymentId: string; readonly status: ProviderPaymentStatus;
    readonly merchantOrderRef: string; readonly amountKopecks: number; readonly currency: string; readonly snapshotHash: string;
  };

export type PaymentEffect =
  | "PROVIDER_CREATE" | "REPLAY_CREATE_SAME_KEY" | "READ_BACK" | "GRANT" | "RELEASE_HOLD" | "ISSUE_PAYMENT_RECEIPT"
  /** LAB only: in the same transaction as PAID, the FINAL_SETTLEMENT event is created AWAITING_SERVICE with the sealed receipt contact. */
  | "RESERVE_FINAL_SETTLEMENT" | "ALERT";

export type PaymentRecord = {
  readonly state: NativePaymentState;
  readonly providerPaymentId: string | null;
};

export type PaymentDecision = {
  readonly state: NativePaymentState;
  readonly providerPaymentId: string | null;
  readonly effects: readonly PaymentEffect[];
  /** Why the record moved (or refused to): kept with the observation for the operator. */
  readonly reason?: string;
};

/** Starting a payment: the order and the CREATING row are committed before PROVIDER_CREATE is sent. */
export function beginPayment(admission: { readonly mayInitiate: boolean }): PaymentDecision {
  if (!admission.mayInitiate) return { state: "CREATING", providerPaymentId: null, effects: [], reason: "PAYMENT_INITIATION_STOPPED" };
  return { state: "CREATING", providerPaymentId: null, effects: ["PROVIDER_CREATE"] };
}

const stay = (record: PaymentRecord, effects: readonly PaymentEffect[] = [], reason?: string): PaymentDecision =>
  ({ state: record.state, providerPaymentId: record.providerPaymentId, effects, ...(reason ? { reason } : {}) });

export function applyPaymentObservation(
  record: PaymentRecord,
  binding: PaymentBinding,
  observation: PaymentObservation,
  context: { readonly mayInitiate: boolean; readonly kind: ProductKind; readonly fiscalizationMode: FiscalizationMode },
): PaymentDecision {
  if (observation.source === "CREATE_RESPONSE") {
    if (record.state !== "CREATING" && record.state !== "CREATE_UNKNOWN") return stay(record, [], "CREATE_RESPONSE_AFTER_CREATE_RESOLVED");
    if (observation.outcome === "ACCEPTED") {
      if (record.providerPaymentId && record.providerPaymentId !== observation.providerPaymentId) {
        return { state: "REVIEW_REQUIRED", providerPaymentId: record.providerPaymentId, effects: ["ALERT"], reason: "PROVIDER_PAYMENT_ID_CONFLICT" };
      }
      return { state: "PENDING", providerPaymentId: observation.providerPaymentId, effects: ["READ_BACK"] };
    }
    if (observation.outcome === "LOST") return { state: "CREATE_UNKNOWN", providerPaymentId: record.providerPaymentId, effects: ["READ_BACK"] };
    // A proven refusal of this exact request: nothing was accepted, so nothing can have been paid.
    if (record.providerPaymentId) return { state: "REVIEW_REQUIRED", providerPaymentId: record.providerPaymentId, effects: ["ALERT"], reason: "REFUSAL_AFTER_ACCEPTANCE" };
    return { state: "DECLINED", providerPaymentId: null, effects: context.kind === "LAB" ? ["RELEASE_HOLD"] : [], reason: observation.code };
  }

  if (observation.source === "CALLBACK") {
    // Never a fact: a valid one only makes the read-back sooner; an invalid one is recorded and dropped.
    if (!observation.signatureValid) return stay(record, [], "CALLBACK_SIGNATURE_INVALID");
    if (record.providerPaymentId && observation.providerPaymentId !== record.providerPaymentId) return stay(record, ["ALERT"], "CALLBACK_FOREIGN_PAYMENT");
    return stay(record, ["READ_BACK"]);
  }

  // READ_BACK
  if (observation.outcome === "UNAVAILABLE") return stay(record, [], observation.code ?? "READ_BACK_UNAVAILABLE");
  if (observation.outcome === "REVIEW_REQUIRED") {
    return { ...record, state: "REVIEW_REQUIRED", effects: ["ALERT"], reason: observation.code };
  }
  if (observation.outcome === "DISPATCH_UNCERTAIN") {
    return { ...record, state: "CREATE_UNKNOWN", effects: ["READ_BACK"], reason: "NATIVE_CREATE_DISPATCH_UNCERTAIN" };
  }
  if (observation.outcome === "NOT_FOUND") {
    // Absence is never concluded. An unanswered create is replayed byte-identically under its key while
    // admission allows new money; otherwise it stays unknown and is read back again later.
    if (record.state === "CREATING" || record.state === "CREATE_UNKNOWN") {
      if (record.providerPaymentId) return { state: "REVIEW_REQUIRED", providerPaymentId: record.providerPaymentId, effects: ["ALERT"], reason: "KNOWN_PAYMENT_NOT_FOUND" };
      return { state: "CREATE_UNKNOWN", providerPaymentId: null, effects: context.mayInitiate ? ["REPLAY_CREATE_SAME_KEY"] : [],
        reason: context.mayInitiate ? undefined : "PAYMENT_INITIATION_STOPPED" };
    }
    if (record.state === "REVIEW_REQUIRED") return stay(record);
    return { state: "REVIEW_REQUIRED", providerPaymentId: record.providerPaymentId, effects: ["ALERT"], reason: "KNOWN_PAYMENT_NOT_FOUND" };
  }

  // FOUND: binding first. A fact for another order, amount, currency or snapshot is a person's, never access.
  if (observation.merchantOrderRef !== binding.merchantOrderRef || observation.amountKopecks !== binding.amountKopecks
    || observation.currency !== binding.currency || observation.snapshotHash !== binding.snapshotHash) {
    return { state: "REVIEW_REQUIRED", providerPaymentId: record.providerPaymentId ?? observation.providerPaymentId, effects: ["ALERT"], reason: "PAYMENT_BINDING_MISMATCH" };
  }
  if (record.providerPaymentId && record.providerPaymentId !== observation.providerPaymentId) {
    return { state: "REVIEW_REQUIRED", providerPaymentId: record.providerPaymentId, effects: ["ALERT"], reason: "PROVIDER_PAYMENT_ID_CONFLICT" };
  }
  const providerPaymentId = observation.providerPaymentId;
  if (record.state === "REVIEW_REQUIRED") return { state: "REVIEW_REQUIRED", providerPaymentId, effects: [] };

  switch (observation.status) {
    case "PENDING":
      if (record.state === "PAID" || TERMINAL_PAYMENT_STATES.includes(record.state)) {
        return { state: "REVIEW_REQUIRED", providerPaymentId, effects: ["ALERT"], reason: "PROVIDER_STATE_REGRESSION" };
      }
      return { state: "PENDING", providerPaymentId, effects: [] };
    case "PAID":
      if (record.state === "PAID") return { state: "PAID", providerPaymentId, effects: [] };
      // Late success after the provider itself said DECLINED/EXPIRED: money exists, the order was closed
      // (a LAB hold may be gone). A person decides grant or refund; nothing is granted automatically.
      if (TERMINAL_PAYMENT_STATES.includes(record.state)) return { state: "REVIEW_REQUIRED", providerPaymentId, effects: ["ALERT"], reason: "LATE_PAYMENT_AFTER_TERMINAL" };
      return { state: "PAID", providerPaymentId, effects: [
        "GRANT", ...(context.fiscalizationMode === "MERCHANT" ? ["ISSUE_PAYMENT_RECEIPT" as const] : []),
        ...(context.kind === "LAB" ? ["RESERVE_FINAL_SETTLEMENT" as const] : [])] };
    case "DECLINED":
    case "EXPIRED":
      if (record.state === observation.status) return { state: record.state, providerPaymentId, effects: [] };
      // A paid payment is never un-paid by a later status; access stays while a person looks.
      if (record.state === "PAID" || TERMINAL_PAYMENT_STATES.includes(record.state)) {
        return { state: "REVIEW_REQUIRED", providerPaymentId, effects: ["ALERT"], reason: "PROVIDER_STATE_REGRESSION" };
      }
      return { state: observation.status, providerPaymentId, effects: context.kind === "LAB" ? ["RELEASE_HOLD"] : [] };
  }
}

// ─── Refund ─────────────────────────────────────────────────────────────────────────────────────────

export type NativeRefundState = "SUBMITTING" | "SUBMIT_UNKNOWN" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "REVIEW_REQUIRED";
export type ProviderRefundStatus = "PROCESSING" | "SUCCEEDED" | "FAILED";

export type RefundBinding = { readonly providerPaymentId: string; readonly amountKopecks: number; readonly currency: "RUB"; readonly refundRef: string };

export type RefundObservation =
  | { readonly source: "SUBMIT_RESPONSE"; readonly outcome: "ACCEPTED"; readonly providerRefundId: string }
  | { readonly source: "SUBMIT_RESPONSE"; readonly outcome: "LOST" }
  /** proven: the provider states this exact request is terminally refused (nothing will be returned). */
  | { readonly source: "SUBMIT_RESPONSE"; readonly outcome: "REFUSED"; readonly code: string; readonly proven: boolean }
  | { readonly source: "CALLBACK"; readonly signatureValid: boolean; readonly providerRefundId: string }
  | { readonly source: "READ_BACK"; readonly outcome: "UNAVAILABLE"; readonly code?: NativeReadBackUnavailableCode | "NATIVE_REFUND_PREFLIGHT_UNAVAILABLE" }
  | { readonly source: "READ_BACK"; readonly outcome: "REVIEW_REQUIRED"; readonly code: string }
  | { readonly source: "READ_BACK"; readonly outcome: "DISPATCH_UNCERTAIN" }
  | { readonly source: "READ_BACK"; readonly outcome: "NOT_FOUND" }
  | {
    readonly source: "READ_BACK"; readonly outcome: "FOUND"; readonly providerRefundId: string; readonly status: ProviderRefundStatus;
    readonly providerPaymentId: string; readonly amountKopecks: number; readonly currency: string; readonly refundRef: string;
  };

export type RefundEffect =
  | "PROVIDER_REFUND_SUBMIT" | "REPLAY_REFUND_SAME_KEY" | "READ_BACK" | "REVOKE_ACCESS" | "ISSUE_REFUND_RECEIPT" | "PURGE_ENVELOPE" | "ALERT";

export type RefundRecord = { readonly state: NativeRefundState; readonly providerRefundId: string | null };
export type RefundDecision = { readonly state: NativeRefundState; readonly providerRefundId: string | null; readonly effects: readonly RefundEffect[]; readonly reason?: string };

/**
 * Admission for a refund execution: full line only (as today, ART-174), the line's payment PAID on the
 * native contour, nothing refunded before, and no FINAL_SETTLEMENT registered (compensation for a
 * rendered LAB service is not supported and fails closed).
 */
export function admitRefund(input: {
  readonly contour: PaymentContour; readonly paymentState: NativePaymentState; readonly lineAmountKopecks: number;
  readonly approvedAmountKopecks: number; readonly alreadyRefundedKopecks: number; readonly finalSettlementState: FiscalEventState | null;
}): { readonly admitted: true } | { readonly admitted: false; readonly code: string } {
  if (input.contour !== "NATIVE") return { admitted: false, code: "REFUND_ROUTED_TO_ORIGINAL_CONTOUR" };
  if (input.paymentState !== "PAID") return { admitted: false, code: "REFUND_PAYMENT_NOT_PAID" };
  if (input.approvedAmountKopecks !== input.lineAmountKopecks || input.alreadyRefundedKopecks !== 0) return { admitted: false, code: "REFUND_FULL_ONLY" };
  // Before the service a reserved settlement is cancelled by the refund; once issuance began, compensation is not supported.
  if (input.finalSettlementState && !SETTLEMENT_NOT_STARTED.includes(input.finalSettlementState)) {
    return { admitted: false, code: "REFUND_AFTER_FINAL_SETTLEMENT_NOT_SUPPORTED" };
  }
  return { admitted: true };
}

export function beginRefund(): RefundDecision {
  return { state: "SUBMITTING", providerRefundId: null, effects: ["PROVIDER_REFUND_SUBMIT"] };
}

const finishRefund = (providerRefundId: string, fiscalizationMode: FiscalizationMode): RefundDecision => ({
  state: "SUCCEEDED", providerRefundId,
  effects: fiscalizationMode === "MERCHANT" ? ["REVOKE_ACCESS", "ISSUE_REFUND_RECEIPT", "PURGE_ENVELOPE"] : ["REVOKE_ACCESS", "PURGE_ENVELOPE"],
});

export function applyRefundObservation(
  record: RefundRecord,
  binding: RefundBinding,
  observation: RefundObservation,
  context: { readonly fiscalizationMode: FiscalizationMode },
): RefundDecision {
  const keep = (effects: readonly RefundEffect[] = [], reason?: string): RefundDecision =>
    ({ state: record.state, providerRefundId: record.providerRefundId, effects, ...(reason ? { reason } : {}) });
  const review = (reason: string, providerRefundId = record.providerRefundId): RefundDecision =>
    ({ state: "REVIEW_REQUIRED", providerRefundId, effects: ["ALERT"], reason });
  const settled = record.state === "SUCCEEDED" || record.state === "FAILED";

  if (observation.source === "SUBMIT_RESPONSE") {
    if (record.state !== "SUBMITTING" && record.state !== "SUBMIT_UNKNOWN") return keep([], "SUBMIT_RESPONSE_AFTER_SUBMIT_RESOLVED");
    if (observation.outcome === "ACCEPTED") return { state: "PROCESSING", providerRefundId: observation.providerRefundId, effects: ["READ_BACK"] };
    if (observation.outcome === "LOST") return { state: "SUBMIT_UNKNOWN", providerRefundId: record.providerRefundId, effects: ["READ_BACK"] };
    // A proven terminal refusal ends the request and its envelope; anything else stays recoverable.
    return observation.proven
      ? { state: "FAILED", providerRefundId: null, effects: ["PURGE_ENVELOPE", "ALERT"], reason: observation.code }
      : review(observation.code);
  }
  if (observation.source === "CALLBACK") {
    if (!observation.signatureValid) return keep([], "CALLBACK_SIGNATURE_INVALID");
    if (record.providerRefundId && observation.providerRefundId !== record.providerRefundId) return keep(["ALERT"], "CALLBACK_FOREIGN_REFUND");
    return keep(settled ? [] : ["READ_BACK"]);
  }
  if (observation.outcome === "UNAVAILABLE") return keep([], observation.code ?? "READ_BACK_UNAVAILABLE");
  if (observation.outcome === "REVIEW_REQUIRED") return review(observation.code);
  if (observation.outcome === "DISPATCH_UNCERTAIN") return {
    state: "SUBMIT_UNKNOWN", providerRefundId: record.providerRefundId, effects: ["ALERT"], reason: "NATIVE_REFUND_DISPATCH_UNCERTAIN",
  };
  if (observation.outcome === "NOT_FOUND") {
    // The refund money effect is the dangerous one: a lost submit is replayed with the SAME sealed
    // envelope and key (the provider deduplicates by key); there is no admission gate on refunds.
    if (record.state === "SUBMITTING" || record.state === "SUBMIT_UNKNOWN") {
      return record.providerRefundId ? review("KNOWN_REFUND_NOT_FOUND") : { state: "SUBMIT_UNKNOWN", providerRefundId: null, effects: ["REPLAY_REFUND_SAME_KEY"] };
    }
    return record.state === "REVIEW_REQUIRED" ? keep() : review("KNOWN_REFUND_NOT_FOUND");
  }
  if (observation.providerPaymentId !== binding.providerPaymentId || observation.amountKopecks !== binding.amountKopecks
    || observation.currency !== binding.currency || observation.refundRef !== binding.refundRef) {
    return review("REFUND_BINDING_MISMATCH", record.providerRefundId ?? observation.providerRefundId);
  }
  if (record.providerRefundId && record.providerRefundId !== observation.providerRefundId) return review("PROVIDER_REFUND_ID_CONFLICT");
  if (record.state === "REVIEW_REQUIRED") return keep();
  switch (observation.status) {
    case "PROCESSING":
      return settled ? review("PROVIDER_STATE_REGRESSION") : { state: "PROCESSING", providerRefundId: observation.providerRefundId, effects: [] };
    case "SUCCEEDED":
      if (record.state === "SUCCEEDED") return keep();
      if (record.state === "FAILED") return review("LATE_REFUND_AFTER_FAILURE", observation.providerRefundId);
      return finishRefund(observation.providerRefundId, context.fiscalizationMode);
    case "FAILED":
      if (record.state === "FAILED") return keep();
      if (record.state === "SUCCEEDED") return review("PROVIDER_STATE_REGRESSION");
      return { state: "FAILED", providerRefundId: observation.providerRefundId, effects: ["PURGE_ENVELOPE", "ALERT"], reason: "REFUND_FAILED_AT_PROVIDER" };
  }
}

// ─── Fiscal port ────────────────────────────────────────────────────────────────────────────────────

/** PROVIDER: the acquiring/receipt service fiscalizes the payment itself. MERCHANT: our fiscal adapter submits. */
export type FiscalizationMode = "PROVIDER" | "MERCHANT";
export type FiscalEventKind = "PAYMENT_RECEIPT" | "REFUND_RECEIPT" | "FINAL_SETTLEMENT";
export type FiscalPaymentMethod = "FULL_PAYMENT" | "FULL_PREPAYMENT";
export type FiscalEventState = "AWAITING_SERVICE" | "PENDING" | "SUBMITTING" | "SUBMIT_UNKNOWN" | "REGISTERED" | "REJECTED" | "REVIEW_REQUIRED"
  | "NOT_REQUIRED" | "CANCELLED";
/** A FINAL_SETTLEMENT in these states has not been sent to any adapter. */
export const SETTLEMENT_NOT_STARTED: readonly FiscalEventState[] = ["NOT_REQUIRED", "AWAITING_SERVICE", "CANCELLED"];

/**
 * A reserved FINAL_SETTLEMENT that will never be issued: the line was refunded, or the occurrence was
 * cancelled, before the service. Its sealed contact is purged with the cancellation.
 */
export function cancelReservedSettlement(state: FiscalEventState, cause: "REFUND_SUCCEEDED" | "OCCURRENCE_CANCELLED"):
  { readonly state: FiscalEventState; readonly effects: readonly ("PURGE_CONTACT" | "ALERT")[]; readonly reason: string } {
  if (state === "AWAITING_SERVICE") return { state: "CANCELLED", effects: ["PURGE_CONTACT"], reason: cause };
  if (state === "CANCELLED") return { state, effects: [], reason: cause };
  return { state, effects: ["ALERT"], reason: "SETTLEMENT_ALREADY_STARTED" };
}

export type FiscalAdapterCapabilities = {
  /** A closing receipt that offsets an earlier advance with no new payment (FLEX-85). */
  readonly finalSettlementWithoutPayment: boolean;
  readonly refundReceipt: boolean;
};

/** The required receipt for a paid line, from its frozen qualified fiscal policy (fiscal-policy.ts). */
export function paymentReceiptMethod(kind: ProductKind, frozenPaymentMethod: string): FiscalPaymentMethod {
  if (kind === "LAB") {
    if (frozenPaymentMethod !== "FULL_PREPAYMENT") throw new Error("FISCAL_POLICY_LAB_REQUIRES_FULL_PREPAYMENT");
    return "FULL_PREPAYMENT";
  }
  if (frozenPaymentMethod !== "FULL_PAYMENT") throw new Error("FISCAL_POLICY_COURSE_REQUIRES_FULL_PAYMENT");
  return "FULL_PAYMENT";
}

/** SERVICE_RENDERED, produced by D (lab-lifecycle) from authoritative LAB completion evidence. */
export type ServiceRenderedFact = {
  readonly schema: "flexperiment.service-rendered/1";
  readonly orderLineId: string;
  readonly occurrenceRef: string;
  readonly renderedAt: string;
  readonly evidenceRef: string;
  readonly recordedBy: string;
  /** From the LAB attendance position (E): a check-in record, or an operator's attested attendance. */
  readonly basis: "CHECKED_IN" | "ATTENDED_ATTESTED";
};

export function admitFinalSettlement(input: {
  readonly kind: ProductKind; readonly paymentState: NativePaymentState; readonly paymentReceiptState: FiscalEventState | null;
  readonly refundOpenOrSucceeded: boolean; readonly occurrenceCancelled: boolean; readonly fact: ServiceRenderedFact | null;
  readonly orderLineId: string; readonly occurrenceRef: string; readonly capabilities: FiscalAdapterCapabilities;
  /** The event reserved at PAID; anything but AWAITING_SERVICE was already started, cancelled or never reserved. */
  readonly finalSettlementState: FiscalEventState | null;
}): { readonly admitted: true; readonly eventRef: string; readonly paymentMethod: "FULL_PAYMENT" } | { readonly admitted: false; readonly code: string } {
  const refuse = (code: string) => ({ admitted: false as const, code });
  if (input.kind !== "LAB") return refuse("FINAL_SETTLEMENT_LAB_ONLY");
  if (input.finalSettlementState !== "AWAITING_SERVICE") return refuse("FINAL_SETTLEMENT_NOT_AWAITING_SERVICE");
  if (!input.capabilities.finalSettlementWithoutPayment) return refuse("FISCAL_ADAPTER_CANNOT_SETTLE_WITHOUT_PAYMENT");
  if (!input.fact || input.fact.orderLineId !== input.orderLineId || input.fact.occurrenceRef !== input.occurrenceRef) return refuse("SERVICE_RENDERED_FACT_REQUIRED");
  if (input.occurrenceCancelled) return refuse("OCCURRENCE_CANCELLED");
  if (input.paymentState !== "PAID") return refuse("PAYMENT_NOT_PAID");
  if (input.paymentReceiptState !== "REGISTERED") return refuse("PREPAYMENT_RECEIPT_NOT_REGISTERED");
  if (input.refundOpenOrSucceeded) return refuse("REFUND_OPEN_OR_SUCCEEDED");
  return { admitted: true, eventRef: fiscalEventRef("FINAL_SETTLEMENT", input.orderLineId), paymentMethod: "FULL_PAYMENT" };
}

export type FiscalObservation =
  | { readonly source: "SUBMIT_RESPONSE"; readonly outcome: "ACCEPTED"; readonly providerReceiptId: string }
  | { readonly source: "SUBMIT_RESPONSE"; readonly outcome: "LOST" }
  | { readonly source: "SUBMIT_RESPONSE"; readonly outcome: "REJECTED"; readonly code: string }
  | { readonly source: "READ_BACK"; readonly outcome: "UNAVAILABLE" }
  | { readonly source: "READ_BACK"; readonly outcome: "NOT_FOUND" }
  | { readonly source: "READ_BACK"; readonly outcome: "FOUND"; readonly providerReceiptId: string; readonly status: "PROCESSING" | "REGISTERED" | "REJECTED";
    readonly eventRef: string; readonly amountKopecks: number; readonly paymentMethod: FiscalPaymentMethod };

export type FiscalEffect = "FISCAL_SUBMIT" | "REPLAY_FISCAL_SAME_KEY" | "FISCAL_READ_BACK" | "ALERT";
export type FiscalRecord = { readonly state: FiscalEventState; readonly providerReceiptId: string | null };
export type FiscalBinding = { readonly eventRef: string; readonly amountKopecks: number; readonly paymentMethod: FiscalPaymentMethod };
export type FiscalDecision = { readonly state: FiscalEventState; readonly providerReceiptId: string | null; readonly effects: readonly FiscalEffect[]; readonly reason?: string };

export function beginFiscalEvent(mode: FiscalizationMode): FiscalDecision {
  // PROVIDER mode: the receipt is the provider's, its evidence is attached from the payment read-back.
  return mode === "PROVIDER" ? { state: "NOT_REQUIRED", providerReceiptId: null, effects: [] }
    : { state: "SUBMITTING", providerReceiptId: null, effects: ["FISCAL_SUBMIT"] };
}

export function applyFiscalObservation(record: FiscalRecord, binding: FiscalBinding, observation: FiscalObservation): FiscalDecision {
  const keep = (effects: readonly FiscalEffect[] = [], reason?: string): FiscalDecision =>
    ({ state: record.state, providerReceiptId: record.providerReceiptId, effects, ...(reason ? { reason } : {}) });
  const review = (reason: string): FiscalDecision => ({ state: "REVIEW_REQUIRED", providerReceiptId: record.providerReceiptId, effects: ["ALERT"], reason });
  if (record.state === "NOT_REQUIRED") return keep([], "FISCAL_EVENT_NOT_REQUIRED");
  if (observation.source === "SUBMIT_RESPONSE") {
    if (record.state !== "SUBMITTING" && record.state !== "SUBMIT_UNKNOWN") return keep([], "SUBMIT_RESPONSE_AFTER_SUBMIT_RESOLVED");
    if (observation.outcome === "ACCEPTED") return { state: "PENDING", providerReceiptId: observation.providerReceiptId, effects: ["FISCAL_READ_BACK"] };
    if (observation.outcome === "LOST") return { state: "SUBMIT_UNKNOWN", providerReceiptId: record.providerReceiptId, effects: ["FISCAL_READ_BACK"] };
    return { state: "REJECTED", providerReceiptId: null, effects: ["ALERT"], reason: observation.code };
  }
  if (observation.outcome === "UNAVAILABLE") return keep([], "READ_BACK_UNAVAILABLE");
  if (observation.outcome === "NOT_FOUND") {
    if ((record.state === "SUBMITTING" || record.state === "SUBMIT_UNKNOWN") && !record.providerReceiptId) {
      return { state: "SUBMIT_UNKNOWN", providerReceiptId: null, effects: ["REPLAY_FISCAL_SAME_KEY"] };
    }
    return record.state === "REVIEW_REQUIRED" ? keep() : review("KNOWN_RECEIPT_NOT_FOUND");
  }
  if (observation.eventRef !== binding.eventRef || observation.amountKopecks !== binding.amountKopecks || observation.paymentMethod !== binding.paymentMethod) {
    return review("FISCAL_BINDING_MISMATCH");
  }
  if (record.providerReceiptId && record.providerReceiptId !== observation.providerReceiptId) return review("PROVIDER_RECEIPT_ID_CONFLICT");
  if (record.state === "REVIEW_REQUIRED") return keep();
  if (observation.status === "PROCESSING") {
    return record.state === "REGISTERED" || record.state === "REJECTED" ? review("PROVIDER_STATE_REGRESSION")
      : { state: "PENDING", providerReceiptId: observation.providerReceiptId, effects: [] };
  }
  if (observation.status === "REGISTERED") {
    if (record.state === "REJECTED") return review("LATE_REGISTRATION_AFTER_REJECTION");
    return { state: "REGISTERED", providerReceiptId: observation.providerReceiptId, effects: [] };
  }
  if (record.state === "REGISTERED") return review("PROVIDER_STATE_REGRESSION");
  return { state: "REJECTED", providerReceiptId: observation.providerReceiptId, effects: ["ALERT"], reason: "RECEIPT_REJECTED" };
}

// ─── Erasure ────────────────────────────────────────────────────────────────────────────────────────

const PAYMENT_SETTLED: readonly NativePaymentState[] = ["PAID", "DECLINED", "EXPIRED"];
const REFUND_SETTLED: readonly NativeRefundState[] = ["SUCCEEDED", "FAILED"];
const FISCAL_SETTLED: readonly FiscalEventState[] = ["REGISTERED", "REJECTED", "NOT_REQUIRED", "CANCELLED"];

/**
 * A subject's sealed envelopes and contacts are the only way to replay an unfinished operation with the
 * same body. Erasure is therefore refused while any payment, refund or fiscal event of the subject is
 * not settled (unknown, in flight, under review, or a LAB settlement awaiting its service); it proceeds
 * only once every one is terminal. Financial and fiscal rows themselves are retained either way.
 */
export function admitErasure(subject: {
  readonly payments: readonly NativePaymentState[]; readonly refunds: readonly NativeRefundState[]; readonly fiscalEvents: readonly FiscalEventState[];
}): { readonly admitted: true; readonly effects: readonly ["PURGE_SEALED_ENVELOPES"] } | { readonly admitted: false; readonly code: "ERASURE_FINANCIAL_REVIEW_REQUIRED"; readonly open: readonly string[] } {
  const open = [
    ...subject.payments.filter((s) => !PAYMENT_SETTLED.includes(s)).map((s) => `payment:${s}`),
    ...subject.refunds.filter((s) => !REFUND_SETTLED.includes(s)).map((s) => `refund:${s}`),
    ...subject.fiscalEvents.filter((s) => !FISCAL_SETTLED.includes(s)).map((s) => `fiscal:${s}`),
  ];
  return open.length ? { admitted: false, code: "ERASURE_FINANCIAL_REVIEW_REQUIRED", open } : { admitted: true, effects: ["PURGE_SEALED_ENVELOPES"] };
}

// ─── Routing and buyer projection (checkout / LAB / my) ─────────────────────────────────────────────

/** The contour is stored with the order and never re-derived from configuration. */
export function routeContour(order: { readonly nativePaymentRef: string | null; readonly refrefAttemptId: string | null }): PaymentContour {
  if (order.nativePaymentRef && order.refrefAttemptId) throw new Error("PAYMENT_CONTOUR_AMBIGUOUS");
  return order.nativePaymentRef ? "NATIVE" : "REFREF_RC2";
}

export type BuyerPaymentStatus = "CONFIRMING" | "AWAITING_PAYMENT" | "ACCESS_GRANTED" | "TICKET_ISSUED" | "DECLINED" | "EXPIRED" | "SUPPORT_REVIEW";
export function buyerPaymentStatus(state: NativePaymentState, kind: ProductKind): BuyerPaymentStatus {
  switch (state) {
    case "CREATING": case "CREATE_UNKNOWN": return "CONFIRMING";
    case "PENDING": return "AWAITING_PAYMENT";
    case "PAID": return kind === "LAB" ? "TICKET_ISSUED" : "ACCESS_GRANTED";
    case "DECLINED": return "DECLINED";
    case "EXPIRED": return "EXPIRED";
    case "REVIEW_REQUIRED": return "SUPPORT_REVIEW";
  }
}

export type BuyerRefundStatus = "REFUND_PROCESSING" | "REFUNDED" | "SUPPORT_REVIEW";
export function buyerRefundStatus(state: NativeRefundState): BuyerRefundStatus {
  return state === "SUCCEEDED" ? "REFUNDED" : state === "FAILED" || state === "REVIEW_REQUIRED" ? "SUPPORT_REVIEW" : "REFUND_PROCESSING";
}
