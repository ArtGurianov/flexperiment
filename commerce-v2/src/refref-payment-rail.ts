import { createHash } from "node:crypto";
import { AmbiguousRailCreateError, type CheckoutCodeOutcome, type PaymentCreateInput, type PaymentRail, type PaymentResolveInput, type RailProjection, type RailResolution } from "./checkout";

type Fetch = typeof fetch;
type RefrefConfig = {
  apiBaseUrl: string;
  apiKey: string;
  merchantId: string;
  successUrl: string;
  paymentMethod: string;
  fetch?: Fetch;
};

type Obligation = {
  obligationRef: string;
  status: "OUTSTANDING" | "IN_PROGRESS" | "SATISFIED" | "LATE_PAYMENT" | "CANCELLED";
  payment: null | { id: string; status: "CREATED" | "PENDING" | "AUTHORIZED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "PARTIALLY_REFUNDED" | "REFUNDED" };
};

type Attempt = { id: string; status: "OPEN" | "SETTLED" | "CANCELLED" | "EXPIRED"; obligations: Obligation[]; referralResolutionId?: string; snapshotHash?: string };

const canonical = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("REFREF_SNAPSHOT_INTEGER_REQUIRED");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  throw new Error("REFREF_SNAPSHOT_VALUE_INVALID");
};

export const refrefSnapshotDigest = (snapshot: Record<string, unknown>) =>
  `refref-jcs-1:${createHash("sha256").update(canonical(snapshot)).digest("hex")}`;

export class RefrefPaymentRail implements PaymentRail {
  private readonly request: Fetch;
  constructor(private readonly config: RefrefConfig) { this.request = config.fetch ?? fetch; }

  private async call(method: string, path: string, body?: unknown, idempotencyKey?: string) {
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
    const payload = await response.json().catch(() => ({ code: `REFREF_HTTP_${response.status}` })) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof payload.code === "string" ? `REFREF_${payload.code}` : `REFREF_HTTP_${response.status}`);
    return payload;
  }

  private projection(attempt: Attempt): RailProjection {
    const evidence = { resolutionId: attempt.referralResolutionId, snapshotHash: attempt.snapshotHash };
    const payments = attempt.obligations.flatMap(({ payment }) => payment ? [payment] : []);
    if (payments.some(({ status }) => status === "REFUNDED")) return { attemptId: attempt.id, state: "REFUNDED", ...evidence };
    if (attempt.status === "SETTLED" || attempt.obligations.every(({ status }) => status === "SATISFIED")) return { attemptId: attempt.id, state: "PAID", ...evidence };
    if (attempt.status === "EXPIRED") return { attemptId: attempt.id, state: "EXPIRED", ...evidence };
    if (attempt.status === "CANCELLED") return { attemptId: attempt.id, state: "DECLINED", ...evidence };
    if (payments.some(({ status }) => status === "FAILED" || status === "CANCELLED")) return { attemptId: attempt.id, state: "DECLINED", ...evidence };
    return { attemptId: attempt.id, state: "PENDING", ...evidence };
  }

  async resolve(input: PaymentResolveInput): Promise<RailResolution> {
    if (!input.handoffToken) throw new Error("REFREF_HANDOFF_TOKEN_REQUIRED");
    const line = { lineRef: input.lineRef, offerRef: input.offerRef, quantity: 1, merchantOfferAmountKopecks: input.amountKopecks };
    let resolution: Record<string, unknown>;
    try {
      resolution = await this.call("POST", "/integrations/referral-resolutions", {
        handoffToken: input.handoffToken, merchantOrderRef: input.orderPublicId, currency: "RUB", lines: [line],
        ...(input.checkoutCode ? { checkoutCode: input.checkoutCode } : {}),
      });
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException) throw new AmbiguousRailCreateError();
      throw error;
    }
    if (resolution.status === "CUSTOMER_ACTION_REQUIRED") {
      return { resolutionId: String(resolution.referralResolutionId), state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: String(resolution.customerActionUrl) };
    }
    if (resolution.status !== "RESOLVED" || !Array.isArray(resolution.lines)) throw new Error("REFREF_RESOLUTION_INVALID");
    const resolvedLine = (resolution.lines as Array<Record<string, unknown>>).filter((item) => item.lineRef === input.lineRef)[0];
    const discount = Number(resolvedLine?.referralDiscountAmountKopecks);
    if (!Number.isSafeInteger(discount) || discount < 0 || discount > input.amountKopecks) throw new Error("REFREF_RESOLUTION_LINE_INVALID");
    const finalAmount = input.amountKopecks - discount;
    if (finalAmount <= 0) throw new Error("REFREF_ZERO_PAYMENT_UNSUPPORTED");
    const checkoutCodeOutcome = resolution.checkoutCodeOutcome;
    const validOutcomes: CheckoutCodeOutcome[] = ["NONE", "APPLIED", "NOT_APPLICABLE", "NOT_RECOGNIZED", "NOT_APPLIED_ATTRIBUTION_LOCKED", "NOT_APPLIED_CUSTOMER_KEPT_CURRENT"];
    if (typeof checkoutCodeOutcome !== "string" || !validOutcomes.includes(checkoutCodeOutcome as CheckoutCodeOutcome)) {
      throw new Error("REFREF_CHECKOUT_CODE_OUTCOME_INVALID");
    }
    return { state: "PRICE_REVIEW_REQUIRED", quote: {
      resolutionId: String(resolution.referralResolutionId),
      termsVersionId: typeof resolution.termsVersionId === "string" ? resolution.termsVersionId : null,
      baseAmountKopecks: input.amountKopecks,
      discountKopecks: discount,
      finalAmountKopecks: finalAmount,
      checkoutCodeOutcome: checkoutCodeOutcome as CheckoutCodeOutcome,
    } };
  }

  async create(input: PaymentCreateInput): Promise<RailProjection> {
    const line = { lineRef: input.lineRef, offerRef: input.offerRef, quantity: 1, merchantOfferAmountKopecks: input.amountKopecks };
    const { quote } = input;
    if (quote.baseAmountKopecks !== input.amountKopecks
      || quote.finalAmountKopecks !== input.amountKopecks - quote.discountKopecks
      || quote.finalAmountKopecks <= 0) throw new Error("REFREF_QUOTE_INVALID");
    const snapshot = {
      schema: "refref.shared-checkout-snapshot/1", merchantId: this.config.merchantId,
      merchantOrderRef: input.orderPublicId, currency: "RUB",
      referralResolutionId: quote.resolutionId, termsVersionId: quote.termsVersionId,
      lines: [{ ...line, referralDiscountAmountKopecks: quote.discountKopecks, finalAmountKopecks: quote.finalAmountKopecks }],
      totalContractAmountKopecks: quote.finalAmountKopecks,
      paymentObligations: [{
        obligationRef: "full", kind: "FULL", executionMode: "ORCHESTRATED", amountKopecks: quote.finalAmountKopecks,
        allocations: [{ lineRef: input.lineRef, amountKopecks: quote.finalAmountKopecks }], fiscalizationMode: "PROVIDER",
        fiscal: { taxSystem: "USN_INCOME", items: [{ lineRef: input.lineRef, name: input.productRef, quantity: 1,
          amountKopecks: quote.finalAmountKopecks, vatCode: "NONE", paymentMethod: this.config.paymentMethod, paymentObject: "SERVICE" }] },
      }],
      legalReleaseRef: input.legalReleaseRef, legalReleaseHash: input.legalReleaseHash,
    };
    const snapshotHash = refrefSnapshotDigest(snapshot);
    let created: Record<string, unknown>;
    try {
      created = await this.call("POST", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts`, {
        referralResolutionId: quote.resolutionId, snapshot, snapshotHash,
      }, input.idempotencyKey);
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException) throw new AmbiguousRailCreateError();
      throw error;
    }
    const attemptId = String(created.checkoutAttemptId ?? "");
    if (!attemptId) throw new Error("REFREF_ATTEMPT_INVALID");
    const session = await this.call("POST", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(attemptId)}/obligations/full/payment-session`, {
      successUrl: input.successUrl ?? this.config.successUrl, receiptContact: { email: input.customerEmail },
    });
    const evidence = { resolutionId: quote.resolutionId, snapshotHash };
    if (session.status === "PAYMENT_READY" && typeof session.providerPaymentUrl === "string") return { attemptId, state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: session.providerPaymentUrl, ...evidence };
    if (session.status === "PAYMENT_PROCESSING") return { attemptId, state: "PENDING", ...evidence };
    if (session.status === "PAYMENT_FAILED") return { attemptId, state: "DECLINED", ...evidence };
    throw new Error("REFREF_PAYMENT_SESSION_INVALID");
  }

  async reconcile(input: { orderPublicId: string; attemptId: string }): Promise<RailProjection> {
    if (!input.attemptId || input.attemptId.startsWith("resolution:")) throw new Error("REFREF_ATTEMPT_NOT_CREATED");
    const attempt = await this.call("GET", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(input.attemptId)}`) as unknown as Attempt;
    return this.projection(attempt);
  }

  async acknowledgeFulfillment(input: { idempotencyKey: string; orderPublicId: string; attemptId: string }) {
    await this.call("POST", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(input.attemptId)}/fulfillment-ack`, {
      status: "DELIVERED", externalFulfillmentId: input.orderPublicId,
    }, `${input.idempotencyKey}:fulfillment`);
  }

  async refund(input: { idempotencyKey: string; orderPublicId: string; attemptId: string; amountKopecks: number; customerEmail: string }): Promise<RailProjection> {
    const attempt = await this.call("GET", `/integrations/orders/${encodeURIComponent(input.orderPublicId)}/checkout-attempts/${encodeURIComponent(input.attemptId)}`) as unknown as Attempt & { lineItems?: Array<{ lineRef: string; offerRef: string }> };
    const payment = attempt.obligations.flatMap(({ payment }) => payment ? [payment] : []).filter(({ status }) => ["SUCCEEDED", "PARTIALLY_REFUNDED"].includes(status))[0];
    const line = attempt.lineItems?.[0];
    if (!payment || !line) throw new Error("REFREF_REFUND_PAYMENT_NOT_FOUND");
    const execution = await this.call("POST", "/integrations/refunds", {
      paymentId: payment.id, amountKopecks: input.amountKopecks,
      fiscal: { items: [{ lineRef: line.lineRef, name: line.offerRef, quantity: 1, amountKopecks: input.amountKopecks,
        vatCode: "NONE", paymentMethod: this.config.paymentMethod, paymentObject: "SERVICE" }] },
      receiptContact: { email: input.customerEmail },
    }, `${input.idempotencyKey}:refund`);
    const refundExecutionId = typeof execution.refundExecutionId === "string" ? execution.refundExecutionId : undefined;
    const supportReference = typeof execution.supportReference === "string" ? execution.supportReference : undefined;
    if (!refundExecutionId || !supportReference) throw new Error("REFREF_REFUND_EXECUTION_INVALID");
    return {
      attemptId: input.attemptId,
      state: execution.status === "REFUND_FAILED" ? "REVIEW_REQUIRED" : "REFUND_PENDING",
      refundExecutionId,
      supportReference,
      failureCode: typeof execution.failureCode === "string" ? execution.failureCode : undefined,
    };
  }
}
