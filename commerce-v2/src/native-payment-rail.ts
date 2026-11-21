import {
  type AcceptedRefund, type PaymentRail, type PaymentResolveInput, type RailProjection, type RailResolution, type RailSnapshotConfig,
  type RefundSubmission,
} from "./checkout";
import type { RefundEnvelope } from "./refund-envelope";

/**
 * FLEX-119 · the quote side of the direct contour. prepareCheckout freezes a price through
 * `rail.resolve`; on the native contour there is no referral resolution, so the quote is the frozen
 * merchant amount with no discount, and a checkout code is not recognized. Money never moves through
 * this object: confirm diverts to the native ledger, and every payment method refuses.
 */
export class NativeQuoteRail implements PaymentRail {
  constructor(readonly checkoutSnapshotConfig: RailSnapshotConfig) {}

  async resolve(input: PaymentResolveInput): Promise<RailResolution> {
    const line = input.request.lines[0];
    return { state: "PRICE_REVIEW_REQUIRED", quote: {
      resolutionId: `native:${input.request.merchantOrderRef}`, termsVersionId: null,
      baseAmountKopecks: line.merchantOfferAmountKopecks, discountKopecks: 0, finalAmountKopecks: line.merchantOfferAmountKopecks,
      checkoutCodeOutcome: input.request.checkoutCode ? "NOT_RECOGNIZED" : "NONE",
    } };
  }

  private refuse(): never { throw new Error("NATIVE_CONTOUR_USES_LEDGER"); }
  async create(): Promise<RailProjection> { return this.refuse(); }
  async recoverCreate(): Promise<RailProjection> { return this.refuse(); }
  async reconcile(): Promise<RailProjection> { return this.refuse(); }
  async acknowledgeFulfillment(): Promise<void> { return this.refuse(); }
  async prepareRefund(): Promise<RefundEnvelope> { return this.refuse(); }
  async submitRefund(): Promise<RefundSubmission> { return this.refuse(); }
  async readRefundExecution(): Promise<RefundSubmission> { return this.refuse(); }
  async readRefund(): Promise<AcceptedRefund | null> { return this.refuse(); }
}
