import { tochkaConfigFromEnvironment, type TochkaConfig } from "./provider-config";

type Fetch = typeof fetch;
type PaymentCreateInput = { paymentId: string; paymentLinkId: string; amountKopecks: number; idempotencyKey: string; successUrl: string; customerEmail: string; purpose: string; receiptItemName: string };
export type ProviderProbe = { environment: "production" | "sandbox" | "mock" };
export type ProviderErrorEvidence = {
  provider_error_class: "TLS_CERT_CHAIN_UNTRUSTED" | "PROVIDER_BAD_REQUEST" | "PROVIDER_HTTP_ERROR" | "PROVIDER_NETWORK" | "PROVIDER_RESPONSE_INVALID";
  provider_error_code: string;
};
export type PaymentLinkOperation = {
  paymentLinkId?: string;
  operationId?: string;
  paymentLink?: string;
  amountKopecks?: number;
  customerMatches?: boolean;
  merchantMatches?: boolean;
};

export interface PaymentProvider {
  probe(): Promise<ProviderProbe>;
  createPayment(input: PaymentCreateInput): Promise<{ providerPaymentId: string; paymentUrl: string }>;
  findPaymentOperationsByLinkId(input: { paymentLinkId: string; fromDate: string; toDate: string }): Promise<PaymentLinkOperation[]>;
  refund(input: { refundId: string; providerPaymentId: string; amountKopecks: number; idempotencyKey: string }): Promise<{ providerReference: string }>;
  reconcilePayment(input: { providerPaymentId: string }): Promise<{ status: "PAID" | "PENDING" | "FAILED" | "UNKNOWN"; capturedAmountKopecks?: number }>;
  reconcileRefund(input: { providerPaymentId: string; providerReference: string | null; amountKopecks: number; idempotencyKey: string }): Promise<{ status: "SUCCEEDED" | "PENDING" | "FAILED" | "UNKNOWN"; refundedAmountKopecks?: number }>;
}

/**
 * The durable payment record intentionally stores this compact evidence, never
 * a provider payload, bearer token, request headers, customer data, or raw
 * transport exception. The original Error remains available only to the
 * immediate caller while the process is alive.
 */
export class TochkaProviderError extends Error {
  constructor(readonly evidence: ProviderErrorEvidence, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TochkaProviderError";
  }
}

const errorCode = (error: unknown) => {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; cause?: { code?: unknown } };
  return typeof value.code === "string" ? value.code : typeof value.cause?.code === "string" ? value.cause.code : undefined;
};

export const providerErrorEvidence = (error: unknown): ProviderErrorEvidence => {
  if (error instanceof TochkaProviderError) return error.evidence;
  const code = errorCode(error);
  if (code === "SELF_SIGNED_CERT_IN_CHAIN") return { provider_error_class: "TLS_CERT_CHAIN_UNTRUSTED", provider_error_code: code };
  return { provider_error_class: "PROVIDER_NETWORK", provider_error_code: code ?? "NETWORK_ERROR" };
};

export const rublesFromKopecks = (kopecks: number) => {
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0) throw new Error("Kopeck amount must be a positive safe integer.");
  return `${Math.floor(kopecks / 100)}.${String(kopecks % 100).padStart(2, "0")}`;
};

const providerErrorSummary = (payload: Record<string, unknown>) => {
  const text = (value: unknown) => typeof value === "string" && value.length > 0 ? value : undefined;
  const parts = [
    text(payload.code) ? `code=${text(payload.code)}` : undefined,
    text(payload.id) ? `id=${text(payload.id)}` : undefined,
    text(payload.errorCode) ? `errorCode=${text(payload.errorCode)}` : undefined,
    text(payload.message),
  ].filter((value): value is string => Boolean(value));
  const validationErrors = Array.isArray(payload.Errors)
    ? payload.Errors.map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const error = entry as Record<string, unknown>;
      const code = text(error.errorCode);
      const message = text(error.message);
      return code && message ? `${code}: ${message}` : code ?? message;
    }).filter((value): value is string => Boolean(value))
    : [];
  if (validationErrors.length > 0) parts.push(`errors=${validationErrors.join(" | ")}`);
  return parts.join("; ") || "provider error";
};

const parseJson = async (response: Response) => {
  const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  if (!response.ok) {
    throw new TochkaProviderError(
      { provider_error_class: response.status >= 400 && response.status < 500 ? "PROVIDER_BAD_REQUEST" : "PROVIDER_HTTP_ERROR", provider_error_code: `HTTP_${response.status}` },
      `Tochka HTTP ${response.status}${payload ? `: ${providerErrorSummary(payload)}` : ""}`,
    );
  }
  if (!payload) throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "EMPTY_JSON" }, "Tochka returned no JSON payload.");
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
  constructor(readonly config: TochkaConfig, readonly request: Fetch = fetch, readonly clock: () => number = Date.now) {}

  private async call(path: string, init: RequestInit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      return await this.request(`${this.config.baseUrl}${path}`, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.config.jwt}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    } catch (error) {
      const evidence = providerErrorEvidence(error);
      throw new TochkaProviderError(evidence, evidence.provider_error_code === "SELF_SIGNED_CERT_IN_CHAIN" ? "Tochka TLS certificate chain is untrusted." : "Tochka transport request failed.", { cause: error });
    } finally { clearTimeout(timer); }
  }

  private calendarDate(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "LOOKUP_DATE_INVALID" }, "Tochka payment lookup date is invalid.");
    return date.toISOString().slice(0, 10);
  }

  private async paymentOperationPage(input: { fromDate: string; toDate: string; page: number; perPage: number }) {
    const query = new URLSearchParams({
      customerCode: this.config.customerCode,
      fromDate: this.calendarDate(input.fromDate),
      toDate: this.calendarDate(input.toDate),
      page: String(input.page),
      perPage: String(input.perPage),
    });
    const payload = await parseJson(await this.call(`/acquiring/v1.0/payments?${query}`, { method: "GET" }));
    const result = data(payload);
    const operations = result?.Operation;
    if (!Array.isArray(operations)) throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "PAYMENT_LIST_SCHEMA_INVALID" }, "Tochka payment operation list is malformed.");
    return { payload, operations };
  }

  /** Read-only authorization and transport check. It never creates a payment link. */
  async probe(): Promise<ProviderProbe> {
    await parseJson(await this.call("/acquiring/v1.0/retailers", { method: "GET" }));
    // A valid documented list call verifies the exact calendar-date contract
    // used to reconcile CREATE_UNKNOWN; it is still read-only and bounded.
    const date = new Date(this.clock()).toISOString();
    await this.paymentOperationPage({ fromDate: date, toDate: date, page: 1, perPage: 1 });
    return { environment: this.config.baseUrl.endsWith("/sandbox/v2") ? "sandbox" : "production" };
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
    if (!result || typeof result.operationId !== "string" || typeof result.paymentLink !== "string") throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "CREATE_RESPONSE_SCHEMA_INVALID" }, "Tochka create response is missing operationId or paymentLink.");
    return { providerPaymentId: result.operationId, paymentUrl: result.paymentLink };
  }

  /**
   * Read-only recovery lookup. The provider has no point lookup by
   * paymentLinkId, so enumerate only the bounded local creation window and
   * retain every matching row: more than one match is an operational conflict,
   * never a cue to pick one arbitrarily.
   */
  async findPaymentOperationsByLinkId(input: { paymentLinkId: string; fromDate: string; toDate: string }) {
    const matches: PaymentLinkOperation[] = [];
    const perPage = 100;
    const maxPages = 20;
    for (let page = 1; page <= maxPages; page += 1) {
      const { payload, operations } = await this.paymentOperationPage({ fromDate: input.fromDate, toDate: input.toDate, page, perPage });
      for (const value of operations) {
        if (!value || typeof value !== "object") continue;
        const operation = value as Record<string, unknown>;
        if (operation.paymentLinkId !== input.paymentLinkId) continue;
        matches.push({
          paymentLinkId: typeof operation.paymentLinkId === "string" ? operation.paymentLinkId : undefined,
          operationId: typeof operation.operationId === "string" ? operation.operationId : undefined,
          paymentLink: typeof operation.paymentLink === "string" ? operation.paymentLink : undefined,
          amountKopecks: kopecksFromRubles(operation.amount),
          customerMatches: typeof operation.customerCode === "string" ? operation.customerCode === this.config.customerCode : undefined,
          merchantMatches: typeof operation.merchantId === "string" ? operation.merchantId === this.config.merchantId : undefined,
        });
      }
      const meta = payload.Meta && typeof payload.Meta === "object" ? payload.Meta as Record<string, unknown> : {};
      const pagination = meta.pagination && typeof meta.pagination === "object" ? meta.pagination as Record<string, unknown> : meta;
      const totalPages = Number(pagination.totalPages ?? pagination.pageCount ?? pagination.pages);
      const hasMore = (Number.isFinite(totalPages) && totalPages > page)
        || (!Number.isFinite(totalPages) && operations.length === perPage);
      if (hasMore && page === maxPages) throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "PAYMENT_LIST_PAGE_LIMIT" }, "Tochka payment operation list exceeds the bounded recovery page limit.");
      if (hasMore) continue;
      break;
    }
    return matches;
  }

  async refund(input: { refundId: string; providerPaymentId: string; amountKopecks: number; idempotencyKey: string }) {
    const response = await this.call(`/acquiring/v1.0/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, { method: "POST", body: JSON.stringify({ Data: { amount: Number(rublesFromKopecks(input.amountKopecks)) } }) });
    const result = data(await parseJson(response));
    if (!result || result.isRefund !== true || (typeof result.orderId !== "string" && typeof result.orderId !== "number")) throw new TochkaProviderError({ provider_error_class: "PROVIDER_RESPONSE_INVALID", provider_error_code: "REFUND_RESPONSE_SCHEMA_INVALID" }, "Tochka refund response is not an accepted refund.");
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
  probe(): Promise<never> { return Promise.reject(this.unavailable()); }
  createPayment(): Promise<never> { return Promise.reject(this.unavailable()); }
  findPaymentOperationsByLinkId(): Promise<never> { return Promise.reject(this.unavailable()); }
  refund(): Promise<never> { return Promise.reject(this.unavailable()); }
  reconcilePayment(): Promise<never> { return Promise.reject(this.unavailable()); }
  reconcileRefund(): Promise<never> { return Promise.reject(this.unavailable()); }
}

/** Local-only deterministic adapter; never selected unless COMMERCE_PROVIDER=mock. */
export class MockProvider implements PaymentProvider {
  async probe(): Promise<ProviderProbe> { return { environment: "mock" }; }
  async createPayment(input: PaymentCreateInput) { return { providerPaymentId: `mock-payment-${input.paymentId}`, paymentUrl: input.successUrl }; }
  async findPaymentOperationsByLinkId() { return []; }
  async refund(input: { refundId: string }) { return { providerReference: `mock-refund-${input.refundId}` }; }
  async reconcilePayment() { return { status: "PENDING" as const }; }
  async reconcileRefund() { return { status: "PENDING" as const }; }
}

export const providerFromEnvironment = (): PaymentProvider => process.env.COMMERCE_PROVIDER === "mock" ? new MockProvider() : new TochkaProvider(tochkaConfigFromEnvironment());
