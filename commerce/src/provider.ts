import { tochkaConfigFromEnvironment, type TochkaConfig } from "./provider-config";

type Fetch = typeof fetch;
type PaymentCreateInput = { paymentId: string; paymentLinkId: string; amountKopecks: number; idempotencyKey: string; successUrl: string; customerEmail: string; purpose: string; receiptItemName: string };

export interface PaymentProvider {
  createPayment(input: PaymentCreateInput): Promise<{ providerPaymentId: string; paymentUrl: string }>;
  refund(input: { refundId: string; providerPaymentId: string; amountKopecks: number; idempotencyKey: string }): Promise<{ providerReference: string }>;
  reconcilePayment(input: { providerPaymentId: string }): Promise<{ status: "PAID" | "PENDING" | "FAILED" | "UNKNOWN"; capturedAmountKopecks?: number }>;
  reconcileRefund(input: { providerPaymentId: string; providerReference: string | null; amountKopecks: number; idempotencyKey: string }): Promise<{ status: "SUCCEEDED" | "PENDING" | "FAILED" | "UNKNOWN"; refundedAmountKopecks?: number }>;
}

export const rublesFromKopecks = (kopecks: number) => {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw new Error("Kopeck amount must be a positive safe integer.");
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, "0")}`;
};

const parseJson = async (response: Response) => {
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) throw new Error(`Tochka HTTP ${response.status}${payload ? `: ${String((payload as { message?: unknown }).message ?? "provider error")}` : ""}`);
  if (!payload) throw new Error("Tochka returned no JSON payload.");
  return payload;
};
const data = (payload: Record<string, unknown>) => payload.Data as Record<string, unknown> | undefined;
const kopecksFromRubles = (amount: unknown) => {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
  const value = Math.round(amount * 100);
  return Number.isSafeInteger(value) && Math.abs(amount * 100 - value) < 1e-8 ? value : undefined;
};

/** Live adapter. Commands are persisted by CommerceDomain before this class is invoked. */
export class TochkaProvider implements PaymentProvider {
  constructor(readonly config: TochkaConfig, readonly request: Fetch = fetch) {}

  private async call(path: string, init: RequestInit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      return await this.request(`${this.config.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.config.jwt}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    } finally { clearTimeout(timer); }
  }

  async createPayment(input: PaymentCreateInput) {
    if (input.paymentLinkId.length > 45) throw new Error("Tochka paymentLinkId exceeds the provider limit.");
    const decimal = rublesFromKopecks(input.amountKopecks);
    const payload = { Data: {
      customerCode: this.config.customerCode, merchantId: this.config.merchantId, amount: Number(decimal),
      purpose: input.purpose, redirectUrl: input.successUrl, failRedirectUrl: input.successUrl,
      paymentMode: ["card", "sbp"], preAuthorization: false, ttl: 20, paymentLinkId: input.paymentLinkId, taxSystemCode: this.config.taxSystemCode,
      Client: { email: input.customerEmail },
      Items: [{ name: input.receiptItemName, amount: Number(decimal), quantity: 1, vatType: this.config.vatType, paymentMethod: "full_payment", paymentObject: "service" }],
    } };
    const response = await this.call("/acquiring/v1.0/payments_with_receipt", { method: "POST", body: JSON.stringify(payload) });
    const result = data(await parseJson(response));
    if (!result || typeof result.operationId !== "string" || typeof result.paymentLink !== "string") throw new Error("Tochka create response is missing operationId or paymentLink.");
    return { providerPaymentId: result.operationId, paymentUrl: result.paymentLink };
  }

  async refund(input: { refundId: string; providerPaymentId: string; amountKopecks: number; idempotencyKey: string }) {
    const response = await this.call(`/acquiring/v1.0/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, { method: "POST", body: JSON.stringify({ Data: { amount: Number(rublesFromKopecks(input.amountKopecks)) } }) });
    const result = data(await parseJson(response));
    if (!result || result.isRefund !== true || (typeof result.orderId !== "string" && typeof result.orderId !== "number")) throw new Error("Tochka refund response is not an accepted refund.");
    return { providerReference: String(result.orderId) };
  }

  async reconcilePayment(input: { providerPaymentId: string }) {
    const response = await this.call(`/acquiring/v1.0/payments/${encodeURIComponent(input.providerPaymentId)}`, { method: "GET" });
    const operation = (data(await parseJson(response))?.Operation as Record<string, unknown>[] | undefined)?.[0];
    if (!operation) return { status: "UNKNOWN" as const };
    const amount = kopecksFromRubles(operation.amount);
    if (operation.status === "APPROVED" && amount !== undefined) return { status: "PAID" as const, capturedAmountKopecks: amount };
    if (["CREATED", "AUTHORIZED", "ON-REFUND", "WAIT_FULL_PAYMENT"].includes(String(operation.status))) return { status: "PENDING" as const };
    if (["EXPIRED", "REFUNDED", "REFUNDED_PARTIALLY"].includes(String(operation.status))) return { status: "FAILED" as const };
    return { status: "UNKNOWN" as const };
  }

  async reconcileRefund(input: { providerPaymentId: string; providerReference: string | null; amountKopecks: number; idempotencyKey: string }) {
    const response = await this.call(`/acquiring/v1.0/payments/${encodeURIComponent(input.providerPaymentId)}`, { method: "GET" });
    const operation = (data(await parseJson(response))?.Operation as Record<string, unknown>[] | undefined)?.[0];
    const orders = operation?.Order as Record<string, unknown>[] | undefined;
    if (!operation || !orders) return { status: "UNKNOWN" as const };
    const refund = orders.find((order) => order.type === "refund" && (!input.providerReference || String(order.orderId) === input.providerReference) && kopecksFromRubles(order.amount) === input.amountKopecks);
    if (refund) return { status: "SUCCEEDED" as const, refundedAmountKopecks: input.amountKopecks };
    if (["ON-REFUND", "APPROVED"].includes(String(operation.status))) return { status: "PENDING" as const };
    if (["EXPIRED", "REFUNDED", "REFUNDED_PARTIALLY"].includes(String(operation.status))) return { status: "FAILED" as const };
    return { status: "UNKNOWN" as const };
  }
}

export class UnconfiguredProvider implements PaymentProvider {
  private unavailable(): never { throw new Error("The Tochka adapter is not configured in this runtime."); }
  createPayment(): Promise<never> { return Promise.reject(this.unavailable()); }
  refund(): Promise<never> { return Promise.reject(this.unavailable()); }
  reconcilePayment(): Promise<never> { return Promise.reject(this.unavailable()); }
  reconcileRefund(): Promise<never> { return Promise.reject(this.unavailable()); }
}

/** Local-only deterministic adapter; never selected unless COMMERCE_PROVIDER=mock. */
export class MockProvider implements PaymentProvider {
  async createPayment(input: PaymentCreateInput) { return { providerPaymentId: `mock-payment-${input.paymentId}`, paymentUrl: input.successUrl }; }
  async refund(input: { refundId: string }) { return { providerReference: `mock-refund-${input.refundId}` }; }
  async reconcilePayment() { return { status: "PENDING" as const }; }
  async reconcileRefund() { return { status: "PENDING" as const }; }
}

export const providerFromEnvironment = (): PaymentProvider => process.env.COMMERCE_PROVIDER === "mock" ? new MockProvider() : new TochkaProvider(tochkaConfigFromEnvironment());
