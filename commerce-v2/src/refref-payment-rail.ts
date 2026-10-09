import { z } from "zod";
import { AmbiguousRailCreateError, type AcceptedRefund, type CheckoutCodeOutcome, type PaymentCreateInput, type PaymentRail, type PaymentRefundInput, type PaymentResolveInput, type RailProjection, type RailResolution, type RefundSubmission } from "./checkout";
import type { RefundEnvelope } from "./refund-envelope";
import { checkoutSnapshotHash, type SharedCheckoutSnapshot } from "./checkout-snapshot";

type Fetch = typeof fetch;
type RefrefConfig = {
  apiBaseUrl: string;
  apiKey: string;
  merchantId: string;
  fetch?: Fetch;
};

const paymentSchema = z.object({
  id: z.string(),
  status: z.enum(["CREATED", "PENDING", "AUTHORIZED", "SUCCEEDED", "FAILED", "CANCELLED", "PARTIALLY_REFUNDED", "REFUNDED"]),
  amountKopecks: z.number().int().nonnegative(),
  remainingRefundableAmountKopecks: z.number().int().nonnegative(),
}).passthrough();
const obligationSchema = z.object({
  obligationRef: z.string(),
  status: z.enum(["OUTSTANDING", "IN_PROGRESS", "SATISFIED", "LATE_PAYMENT", "CANCELLED"]),
  payment: paymentSchema.nullable(),
}).passthrough();
const lineItemSchema = z.object({
  lineRef: z.string(),
  offerRef: z.string(),
  refundableAmountKopecks: z.number().int().nonnegative(),
}).passthrough();
const attemptSchema = z.object({
  id: z.string(),
  status: z.enum(["OPEN", "SETTLED", "CANCELLED", "EXPIRED"]),
  obligations: z.array(obligationSchema),
  lineItems: z.array(lineItemSchema),
  referralResolutionId: z.string(),
  snapshotHash: z.string(),
}).passthrough();
type Attempt = z.infer<typeof attemptSchema>;

const checkoutCodeOutcomeSchema = z.enum([
  "NONE", "APPLIED", "NOT_APPLICABLE", "NOT_RECOGNIZED",
  "NOT_APPLIED_ATTRIBUTION_LOCKED", "NOT_APPLIED_CUSTOMER_KEPT_CURRENT",
]);
const resolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("RESOLVED"),
    referralResolutionId: z.string(),
    termsVersionId: z.string().nullable(),
    checkoutCodeOutcome: checkoutCodeOutcomeSchema,
    lines: z.array(z.object({
      lineRef: z.string(),
      referralDiscountAmountKopecks: z.number().int().nonnegative(),
    }).passthrough()),
  }).passthrough(),
  z.object({
    status: z.literal("CUSTOMER_ACTION_REQUIRED"),
    referralResolutionId: z.string(),
    customerActionUrl: z.string(),
  }).passthrough(),
]);
const createAttemptSchema = z.object({
  checkoutAttemptId: z.string(),
  snapshotHash: z.string(),
  obligations: z.array(obligationSchema),
}).passthrough();
const paymentSessionSchema = z.object({
  status: z.enum(["PAYMENT_READY", "PAYMENT_PROCESSING", "PAYMENT_FAILED"]),
  providerPaymentUrl: z.string().optional(),
}).passthrough();
const merchantOrderSchema = z.object({ checkoutAttempts: z.array(attemptSchema) }).passthrough();
const refundExecutionSchema = z.object({
  status: z.enum(["REFUND_SUBMITTED", "REFUND_PROCESSING", "REFUND_FAILED"]),
  refundExecutionId: z.string(),
  canonicalRefundId: z.string().nullable().optional(),
  supportReference: z.string(),
  failureCode: z.enum(["REFUND_DECLINED", "REFUND_REJECTED", "REFUND_UNAVAILABLE"]).optional(),
}).passthrough();
const refundSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  amountKopecks: z.number().int().positive(),
  status: z.literal("SUCCEEDED"),
}).passthrough();
const submissionOf = (execution: z.infer<typeof refundExecutionSchema>): RefundSubmission => ({
  status: execution.status === "REFUND_FAILED" ? "FAILED" : execution.status === "REFUND_SUBMITTED" ? "SUBMITTED" : "PROCESSING",
  refundExecutionId: execution.refundExecutionId,
  supportReference: execution.supportReference,
  ...(execution.failureCode ? { failureCode: execution.failureCode } : {}),
  canonicalRefundId: execution.canonicalRefundId ?? null,
});
const fulfillmentSchema = z.object({
  checkoutAttemptId: z.string(),
  status: z.enum(["NOT_READY", "READY", "DELIVERED", "FAILED", "ACTION_REQUIRED"]),
}).passthrough();

class RefrefHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`REFREF_${code}`);
  }
}

const isAmbiguousSideEffect = (error: unknown) => error instanceof TypeError
  || error instanceof DOMException
  || (error instanceof RefrefHttpError && (error.status === 408 || error.status === 429 || error.status >= 500))
  || (error instanceof Error && error.message.startsWith("REFREF_RESPONSE_INVALID:"));

export const refrefSnapshotDigest = (snapshot: Record<string, unknown>) =>
  checkoutSnapshotHash(snapshot as SharedCheckoutSnapshot);

export class RefrefPaymentRail implements PaymentRail {
  private readonly request: Fetch;
  readonly checkoutSnapshotConfig;
  constructor(private readonly config: RefrefConfig) {
    this.request = config.fetch ?? fetch;
    this.checkoutSnapshotConfig = {
      merchantId: config.merchantId,
      fiscalizationMode: "PROVIDER" as const,
    };
  }

  private async call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, idempotencyKey?: string): Promise<T> {
    const target = new URL(this.config.apiBaseUrl);
    target.pathname = `${target.pathname.replace(/\/$/, "")}${path}`;
    const response = await this.request(target, {
      method,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }).passthrough() }).safeParse(payload);
      throw new RefrefHttpError(response.status, parsed.success ? parsed.data.error.code : `HTTP_${response.status}`);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error(`REFREF_RESPONSE_INVALID:${path}`);
    return parsed.data;
  }

  private projection(attempt: Attempt): RailProjection {
    const evidence = { resolutionId: attempt.referralResolutionId, snapshotHash: attempt.snapshotHash };
    const payments = attempt.obligations.flatMap(({ payment }) => payment ? [payment] : []);
    const payment = payments[0];
    const paymentEvidence = payment ? {
      paymentAmountKopecks: payment.amountKopecks,
      remainingRefundableAmountKopecks: payment.remainingRefundableAmountKopecks,
    } : {};
    if (payments.some(({ status }) => status === "REFUNDED")) return { attemptId: attempt.id, state: "REFUNDED", ...evidence, ...paymentEvidence };
    if (attempt.status === "SETTLED" || attempt.obligations.every(({ status }) => status === "SATISFIED")) return { attemptId: attempt.id, state: "PAID", ...evidence, ...paymentEvidence };
    if (attempt.obligations.some(({ status }) => status === "LATE_PAYMENT")) return { attemptId: attempt.id, state: "REFUND_PENDING", ...evidence, ...paymentEvidence };
    if (attempt.status === "EXPIRED") return { attemptId: attempt.id, state: "EXPIRED", ...evidence };
    if (attempt.status === "CANCELLED") return { attemptId: attempt.id, state: "DECLINED", ...evidence };
    if (payments.some(({ status }) => status === "FAILED" || status === "CANCELLED")) return { attemptId: attempt.id, state: "DECLINED", ...evidence };
    return { attemptId: attempt.id, state: "PENDING", ...evidence, ...paymentEvidence };
  }

  async resolve(input: PaymentResolveInput): Promise<RailResolution> {
    if (!input.handoffToken) throw new Error("REFREF_HANDOFF_TOKEN_REQUIRED");
    const line = {
      lineRef: input.lineRef,
      offerRef: input.offerRef,
      ...(input.unitRef === undefined ? {} : { unitRef: input.unitRef }),
      quantity: 1,
      merchantOfferAmountKopecks: input.amountKopecks,
      ...(input.serviceStartsAt === undefined ? {} : { serviceStartsAt: input.serviceStartsAt }),
      ...(input.serviceEndsAt === undefined ? {} : { serviceEndsAt: input.serviceEndsAt }),
    };
    let resolution: z.infer<typeof resolutionSchema>;
    try {
      resolution = await this.call("POST", "/integrations/referral-resolutions", resolutionSchema, {
        handoffToken: input.handoffToken, merchantOrderRef: input.orderPublicId, currency: "RUB", lines: [line],
        ...(input.checkoutCode ? { checkoutCode: input.checkoutCode } : {}),
      });
    } catch (error) {
      if (isAmbiguousSideEffect(error)) throw new AmbiguousRailCreateError();
      throw error;
    }
    if (resolution.status === "CUSTOMER_ACTION_REQUIRED") {
      return { resolutionId: String(resolution.referralResolutionId), state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: String(resolution.customerActionUrl) };
    }
    const resolvedLine = resolution.lines.filter((item) => item.lineRef === input.lineRef)[0];
    const discount = Number(resolvedLine?.referralDiscountAmountKopecks);
    if (!Number.isSafeInteger(discount) || discount < 0 || discount > input.amountKopecks) throw new Error("REFREF_RESOLUTION_LINE_INVALID");
    const finalAmount = input.amountKopecks - discount;
    if (finalAmount <= 0) throw new Error("REFREF_ZERO_PAYMENT_UNSUPPORTED");
    const checkoutCodeOutcome: CheckoutCodeOutcome = resolution.checkoutCodeOutcome;
    return { state: "PRICE_REVIEW_REQUIRED", quote: {
      resolutionId: String(resolution.referralResolutionId),
      termsVersionId: resolution.termsVersionId,
      baseAmountKopecks: input.amountKopecks,
      discountKopecks: discount,
      finalAmountKopecks: finalAmount,
      checkoutCodeOutcome,
    } };
  }

  async create(input: PaymentCreateInput): Promise<RailProjection> {
    const { quote } = input;
    if (quote.baseAmountKopecks !== input.amountKopecks
      || quote.finalAmountKopecks !== input.amountKopecks - quote.discountKopecks
      || quote.finalAmountKopecks <= 0) throw new Error("REFREF_QUOTE_INVALID");
    if (checkoutSnapshotHash(input.snapshot) !== input.snapshotHash) throw new Error("REFREF_SNAPSHOT_HASH_INVALID");
    let created: z.infer<typeof createAttemptSchema>;
    try {
      created = await this.call("POST", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts`, createAttemptSchema, {
        referralResolutionId: quote.resolutionId, snapshot: input.snapshot, snapshotHash: input.snapshotHash,
      }, input.idempotencyKey);
    } catch (error) {
      if (isAmbiguousSideEffect(error)) throw new AmbiguousRailCreateError();
      throw error;
    }
    const attemptId = created.checkoutAttemptId;
    if (created.snapshotHash !== input.snapshotHash) throw new Error("REFREF_SNAPSHOT_HASH_MISMATCH");
    return this.createPaymentSession(input, attemptId);
  }

  private async createPaymentSession(input: PaymentCreateInput, attemptId: string): Promise<RailProjection> {
    if (!input.successUrl) throw new Error("REFREF_SUCCESS_URL_REQUIRED");
    const evidence = { resolutionId: input.quote.resolutionId, snapshotHash: input.snapshotHash };
    let session: z.infer<typeof paymentSessionSchema>;
    try {
      session = await this.call("POST", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(attemptId)}/obligations/full/payment-session`, paymentSessionSchema, {
        successUrl: input.successUrl, receiptContact: { email: input.customerEmail },
      });
    } catch (error) {
      if (isAmbiguousSideEffect(error)) throw new AmbiguousRailCreateError({ attemptId, ...evidence });
      throw error;
    }
    if (session.status === "PAYMENT_READY" && typeof session.providerPaymentUrl === "string") return { attemptId, state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: session.providerPaymentUrl, ...evidence };
    if (session.status === "PAYMENT_PROCESSING") return { attemptId, state: "PENDING", ...evidence };
    if (session.status === "PAYMENT_FAILED") return { attemptId, state: "DECLINED", ...evidence };
    throw new Error("REFREF_PAYMENT_SESSION_INVALID");
  }

  async recoverCreate(input: PaymentCreateInput, knownAttemptId?: string): Promise<RailProjection> {
    let attempt: Attempt | undefined;
    if (knownAttemptId) {
      attempt = await this.call("GET", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(knownAttemptId)}`, attemptSchema);
    } else {
      try {
        const order = await this.call("GET", `/integrations/merchant-orders/${encodeURIComponent(input.orderPublicId)}`, merchantOrderSchema);
        attempt = order.checkoutAttempts.find((candidate) => candidate.snapshotHash === input.snapshotHash
          && candidate.referralResolutionId === input.quote.resolutionId);
        if (!attempt && order.checkoutAttempts.length > 0) throw new Error("REFREF_RECOVERY_ATTEMPT_MISMATCH");
      } catch (error) {
        if (!(error instanceof RefrefHttpError) || error.status !== 404) throw error;
      }
    }
    if (!attempt) return this.create(input);
    const projection = this.projection(attempt);
    if (projection.state !== "PENDING" && projection.state !== "CUSTOMER_ACTION_REQUIRED") return projection;
    return this.createPaymentSession(input, attempt.id);
  }

  async reconcile(input: { orderPublicId: string; attemptId: string }): Promise<RailProjection> {
    if (!input.attemptId || input.attemptId.startsWith("resolution:")) throw new Error("REFREF_ATTEMPT_NOT_CREATED");
    const attempt = await this.call("GET", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(input.attemptId)}`, attemptSchema);
    return this.projection(attempt);
  }

  async acknowledgeFulfillment(input: { idempotencyKey: string; orderPublicId: string; attemptId: string }) {
    await this.call("POST", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(input.attemptId)}/fulfillment-ack`, fulfillmentSchema, {
      status: "DELIVERED", externalFulfillmentId: input.orderPublicId,
    }, `${input.idempotencyKey}:fulfillment`);
  }

  async prepareRefund(input: PaymentRefundInput): Promise<RefundEnvelope> {
    const attempt = await this.call("GET", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(input.attemptId)}`, attemptSchema);
    const payment = attempt.obligations.flatMap(({ payment }) => payment ? [payment] : []).filter(({ status }) => status === "SUCCEEDED")[0];
    const line = attempt.lineItems.find(({ lineRef }) => lineRef === input.lineRef);
    if (!payment || !line) throw new Error("REFREF_REFUND_PAYMENT_NOT_FOUND");
    if (input.fiscalItem.lineRef !== input.lineRef) throw new Error("REFREF_REFUND_FISCAL_LINE_MISMATCH");
    // Full refunds only (ART-174): the whole payment, nothing refunded before, the whole line. A partial
    // is not something this rail's provider connections execute.
    if (!Number.isSafeInteger(input.amountKopecks) || input.amountKopecks !== payment.amountKopecks
      || input.amountKopecks !== payment.remainingRefundableAmountKopecks || input.amountKopecks !== line.refundableAmountKopecks) {
      throw new Error("REFREF_REFUND_FULL_ONLY");
    }
    return {
      idempotencyKey: `${input.idempotencyKey}:refund`,
      paymentId: payment.id,
      amountKopecks: input.amountKopecks,
      body: {
        paymentId: payment.id,
        amountKopecks: input.amountKopecks,
        fiscal: { items: [{ ...input.fiscalItem, amountKopecks: input.amountKopecks }] },
        // The paid obligation was PROVIDER-fiscalized on this rail, so the provider issues the refund receipt.
        ...(this.checkoutSnapshotConfig.fiscalizationMode === "PROVIDER" ? { receiptContact: { email: input.customerEmail } } : {}),
      },
    };
  }

  async submitRefund(envelope: RefundEnvelope): Promise<RefundSubmission> {
    try {
      return submissionOf(await this.call("POST", "/integrations/refunds", refundExecutionSchema, envelope.body, envelope.idempotencyKey));
    } catch (error) {
      // Refref may have acted: the execution stays in flight, and the same envelope is sent again.
      if (isAmbiguousSideEffect(error)) return { status: "UNKNOWN" };
      throw error;
    }
  }

  async readRefundExecution(refundExecutionId: string): Promise<RefundSubmission> {
    return submissionOf(await this.call("GET", `/integrations/refund-executions/${encodeURIComponent(refundExecutionId)}`, refundExecutionSchema));
  }

  async readRefund(refundId: string): Promise<AcceptedRefund | null> {
    try {
      const refund = await this.call("GET", `/integrations/refunds/${encodeURIComponent(refundId)}`, refundSchema);
      return { id: refund.id, paymentId: refund.paymentId, amountKopecks: refund.amountKopecks, status: refund.status };
    } catch (error) {
      if (error instanceof RefrefHttpError && error.status === 404) return null;
      throw error;
    }
  }
}
