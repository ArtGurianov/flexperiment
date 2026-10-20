import { z } from "zod";

const ref = z.string().min(1).max(256);
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const recoveryAttemptSchema = z.object({
  id: ref, merchantOrderId: ref, snapshotHash: ref, referralResolutionId: ref,
  termsVersionId: ref.nullable(), currency: z.literal("RUB"), totalContractAmountKopecks: money,
  status: z.enum(["OPEN", "SETTLED", "CANCELLED", "EXPIRED"]),
  lineItems: z.array(z.object({
    lineRef: ref, offerRef: ref, unitRef: ref.optional(), quantity: z.literal(1),
    merchantOfferAmountKopecks: money, referralDiscountAmountKopecks: money,
    finalAmountKopecks: money, refundableAmountKopecks: money,
  })),
  obligations: z.array(z.object({
    obligationRef: ref, kind: z.literal("FULL"), executionMode: z.literal("ORCHESTRATED"), amountKopecks: money,
    status: z.enum(["OUTSTANDING", "IN_PROGRESS", "SATISFIED", "LATE_PAYMENT", "CANCELLED"]),
    payment: z.object({ id: ref, status: z.enum(["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"]),
      amountKopecks: money, remainingRefundableAmountKopecks: money,
      succeededAt: z.string().datetime({ offset: true }),
    }).nullable(),
  })),
});
export const recoveryRefundSchema = z.object({
  id: ref, paymentId: ref, checkoutAttemptId: ref, amountKopecks: money,
  status: z.literal("SUCCEEDED"), succeededAt: z.string().datetime({ offset: true }),
  lineAllocations: z.array(z.object({ checkoutLineItemId: ref, amountKopecks: money, commissionableReversalKopecks: money })),
});
export const recoveryFulfillmentSchema = z.object({
  checkoutAttemptId: ref, status: z.enum(["NOT_READY", "READY", "DELIVERED", "FAILED", "ACTION_REQUIRED"]),
  externalFulfillmentId: ref.nullable(), acknowledgedAt: z.string().datetime({ offset: true }).nullable(),
});
export const recoveryObservationSchema = z.object({
  order: z.object({ merchantOrderId: ref, checkoutAttempts: z.array(recoveryAttemptSchema) }),
  fulfillment: recoveryFulfillmentSchema,
  refunds: z.array(recoveryRefundSchema),
});
export type RecoveryObservation = z.infer<typeof recoveryObservationSchema>;
export interface RestoreRefrefReader {
  read(orderPublicId: string, refundIds: readonly string[]): Promise<RecoveryObservation>;
}

/** Deliberately has no create/session/refund/ACK capability. No redirects or cached fallback. */
export class RefrefRestoreReader implements RestoreRefrefReader {
  private readonly base: URL;
  constructor(private readonly config: { apiBaseUrl: string; apiKey: string; fetch?: typeof fetch }) {
    this.base = new URL(config.apiBaseUrl);
    if (this.base.protocol !== "https:" || this.base.username || this.base.password || this.base.search || this.base.hash
      || !config.apiKey || /[\r\n]/.test(config.apiKey)) throw new Error("RESTORE_REFREF_CONFIGURATION_INVALID");
  }
  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const target = new URL(this.base);
    target.pathname = `${target.pathname.replace(/\/$/, "")}/integrations/${path}`;
    try {
      const response = await (this.config.fetch ?? fetch)(target, { method: "GET", redirect: "error", cache: "no-store",
        headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error();
      return schema.parse(await response.json());
    } catch { throw new Error("RESTORE_REFREF_READ_REFUSED"); }
  }
  async read(orderPublicId: string, refundIds: readonly string[]): Promise<RecoveryObservation> {
    const order = await this.get(`merchant-orders/${encodeURIComponent(orderPublicId)}`, recoveryObservationSchema.shape.order);
    if (order.merchantOrderId !== orderPublicId || order.checkoutAttempts.length !== 1) throw new Error("RESTORE_ATTEMPT_AMBIGUOUS");
    const fulfillment = await this.get(`orders/${encodeURIComponent(orderPublicId)}/checkout-attempts/${encodeURIComponent(order.checkoutAttempts[0].id)}/fulfillment`, recoveryFulfillmentSchema);
    const refunds = [];
    for (const id of refundIds) {
      const refund = await this.get(`refunds/${encodeURIComponent(id)}`, recoveryRefundSchema);
      if (refund.id !== id) throw new Error("RESTORE_REFUND_BINDING_MISMATCH");
      refunds.push(refund);
    }
    return { order, fulfillment, refunds };
  }
}
