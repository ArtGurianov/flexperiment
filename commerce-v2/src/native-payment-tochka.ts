import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { FiscalReadBack } from "./fiscal-port";
import type {
  FrozenNativePaymentRequest, FrozenNativeRefundRequest, NativeCallbackHint, NativeCreateAnswer,
  NativePaymentProvider, NativePaymentReadBack, NativeRefundAnswer, NativeRefundReadBack, PaymentReadKey, RefundReadKey,
} from "./native-payment-provider";

const acquiring = "/uapi/acquiring/v1.0";
const payments = `${acquiring}/payments`;
const publicKeyPath = "/doc/openapi/static/keys/public";
const invalid = () => new Error("TOCHKA_RESPONSE_INVALID");

export type TochkaConnection = {
  readonly origin: string;
  readonly customerCode: string;
  readonly merchantId: string;
  readonly bearer: string;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

function records(value: unknown) {
  if (!Array.isArray(value)) throw invalid();
  return value.map(object);
}

function operationId(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw invalid();
  return value;
}

function minor(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") throw invalid();
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw invalid();
  const result = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(result)) throw invalid();
  return result;
}

function rubles(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || minor(value / 100) !== value) throw invalid();
  return value / 100;
}

function currency(row: Record<string, unknown>) {
  // The acquiring OpenAPI omits currency; this connection is scoped to domestic CARD in RUB.
  if (row.currency === undefined) return "RUB";
  if (typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency)) throw invalid();
  return row.currency;
}

function linkId(order: string, snapshot: string) {
  if (!/^[a-f0-9]{64}$/.test(snapshot)) throw invalid();
  // The bank echoes this 43-character value (its order-reference limit is 45).
  return createHash("sha256").update(JSON.stringify(["flex-native-tochka/1", order, snapshot])).digest("base64url");
}

function paymentStatus(row: Record<string, unknown>): "PENDING" | "PAID" | "EXPIRED" {
  switch (row.status) {
    case "CREATED": case "AUTHORIZED": case "WAIT_FULL_PAYMENT": return "PENDING";
    case "EXPIRED": return "EXPIRED";
    case "APPROVED": {
      const history = records(row.Order);
      const approvals = history.filter(entry => entry.type === "approval");
      if (row.paymentType === "card" && row.preAuthorization !== true && !history.some(entry => entry.type === "refund")
        && approvals.length === 1 && minor(approvals[0].amount) === minor(row.amount) && currency(approvals[0]) === "RUB") return "PAID";
      break;
    }
  }
  // A refund already in flight or completed needs separate operator reconciliation.
  throw invalid();
}

const refundOrders = (row: Record<string, unknown>) => records(row.Order).filter(entry => entry.type === "refund");

export class TochkaNativeAcquiring implements NativePaymentProvider {
  readonly name = "tochka";
  readonly executorKey: string;
  readonly replayGuarantees = { payment: false, refund: false };
  private callbackKey?: { key: KeyObject; expires: number };
  private fetchingKey?: Promise<KeyObject>;

  constructor(private readonly connection: TochkaConnection, private readonly request: typeof fetch = fetch) {
    this.executorKey = `tochka-cheki:${createHash("sha256").update(JSON.stringify([
      connection.origin, connection.customerCode, connection.merchantId,
    ])).digest("hex")}`;
  }

  private async json(path: string, data?: object, authenticate = true) {
    const headers = { Accept: "application/json", ...(authenticate ? { Authorization: `Bearer ${this.connection.bearer}` } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}) };
    const response = await this.request(new URL(path, this.connection.origin), {
      headers, redirect: "error", signal: AbortSignal.timeout(5_000),
      ...(data ? { method: "POST", body: JSON.stringify({ Data: data }) } : {}),
    });
    if (!response.ok) throw new Error("TOCHKA_HTTP_UNAVAILABLE");
    return object(await response.json());
  }

  private boundToMerchant(row: Record<string, unknown>) {
    return row.customerCode === this.connection.customerCode && row.merchantId === this.connection.merchantId;
  }

  private async info(id: string) {
    const data = object((await this.json(`${payments}/${operationId(id)}`)).Data);
    const entries = records(data.Operation);
    if (entries.length !== 1) throw invalid();
    return entries[0];
  }

  async createPayment(request: FrozenNativePaymentRequest): Promise<NativeCreateAnswer> {
    const [item] = request.fiscalItems.map(object);
    const taxSystemCode = request.taxSystem === "USN_INCOME" ? "usn_income"
      : request.taxSystem === "USN_INCOME_OUTCOME" ? "usn_income_outcome" : undefined;
    if (!item || request.fiscalItems.length !== 1 || item.quantity !== 1 || item.amountKopecks !== request.amountKopecks
      || item.paymentMethod !== "FULL_PAYMENT" || item.paymentObject !== "SERVICE" || item.vatCode !== "NONE"
      || typeof item.name !== "string" || !item.name.trim() || item.name.length > 256 || !taxSystemCode || request.currency !== "RUB"
      || !request.purpose.trim() || request.purpose.length > 140) return { outcome: "REFUSED", code: "TOCHKA_CHEKI_PROFILE_INVALID" };

    const amount = rubles(request.amountKopecks);
    const paymentLinkId = linkId(request.merchantOrderRef, request.snapshotHash);
    const result = object((await this.json(`${acquiring}/payments_with_receipt`, {
      customerCode: this.connection.customerCode, merchantId: this.connection.merchantId, amount,
      purpose: request.purpose, paymentLinkId, paymentMode: ["card"], preAuthorization: false, saveCard: false,
      ...(request.successUrl ? { redirectUrl: request.successUrl } : {}),
      taxSystemCode, Client: { email: request.receiptEmail },
      Items: [{ name: item.name, amount, quantity: 1, vatType: "none", paymentMethod: "full_payment", paymentObject: "service" }],
    })).Data);
    if (!this.boundToMerchant(result) || result.paymentLinkId !== paymentLinkId
      || minor(result.amount) !== request.amountKopecks || currency(result) !== request.currency) throw invalid();
    // Keep the URL and payment state behind authenticated GET.
    return { outcome: "ACCEPTED", providerPaymentId: operationId(result.operationId) };
  }

  private async findOperation(paymentLinkId: string, dispatchedAt: string) {
    const dispatch = Date.parse(dispatchedAt);
    if (!Number.isFinite(dispatch)) throw invalid();
    // Use a coarse date buffer for the bank's date boundary. Continuation is bounded.
    const fromDate = new Date(dispatch - 86_400_000).toISOString().slice(0, 10);
    let candidate: string | undefined;
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page += 1) {
      const query = new URLSearchParams({ customerCode: this.connection.customerCode, fromDate, page: String(page), perPage: "100" });
      const result = await this.json(`${payments}?${query}`);
      const count = object(result.Meta).totalPages;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 10 || (page > 1 && count !== totalPages)) throw invalid();
      totalPages = count;
      for (const row of records(object(result.Data).Operation)) {
        if (row.paymentLinkId !== paymentLinkId || !this.boundToMerchant(row)) continue;
        if (candidate) throw invalid();
        candidate = operationId(row.operationId);
      }
    }
    return candidate;
  }

  async readPaymentByOrder(order: string, key: PaymentReadKey): Promise<NativePaymentReadBack> {
    const paymentLinkId = linkId(order, key.snapshotHash);
    const id = key.providerPaymentId ?? await this.findOperation(paymentLinkId, key.createdAt);
    if (!id) return { outcome: "NOT_FOUND" };
    const row = await this.info(id);
    // The digest carries both original merchant order and snapshot. Missing/foreign echoes fail closed.
    if (!this.boundToMerchant(row) || row.paymentLinkId !== paymentLinkId || row.operationId !== id) throw invalid();
    const status = paymentStatus(row);
    return { outcome: "FOUND", providerPaymentId: id, status, merchantOrderRef: order, snapshotHash: key.snapshotHash,
      amountKopecks: minor(row.amount), currency: currency(row),
      ...(status === "PENDING" && typeof row.paymentLink === "string" ? { paymentUrl: row.paymentLink } : {}) };
  }

  private async refundPayment(key: RefundReadKey) {
    const row = await this.info(key.providerPaymentId);
    if (!this.boundToMerchant(row) || row.operationId !== key.providerPaymentId || row.paymentType !== "card"
      || row.paymentLinkId !== linkId(key.merchantOrderRef, key.snapshotHash)) throw invalid();
    return row;
  }

  async prepareRefund(request: FrozenNativeRefundRequest): Promise<boolean> {
    if (!request.paymentKey || request.paymentKey.providerPaymentId !== request.providerPaymentId) return false;
    const row = await this.refundPayment(request.paymentKey);
    return row.status === "APPROVED" && row.preAuthorization !== true && refundOrders(row).length === 0
      && minor(row.amount) === request.amountKopecks && currency(row) === request.currency;
  }

  async submitRefund(request: FrozenNativeRefundRequest): Promise<NativeRefundAnswer> {
    const id = operationId(request.providerPaymentId);
    const result = object((await this.json(`${payments}/${id}/refund`, { amount: rubles(request.amountKopecks) })).Data);
    if (result.isRefund !== true || result.operationId !== id || minor(result.amount) !== request.amountKopecks
      || currency(result) !== request.currency) throw invalid();
    return { outcome: "ACCEPTED", providerRefundId: operationId(result.orderId) };
  }

  async readRefund(refundRef: string, key: RefundReadKey): Promise<NativeRefundReadBack> {
    const row = await this.refundPayment(key);
    const entries = refundOrders(row);
    if (entries.length === 0 && (row.status === "APPROVED" || row.status === "ON-REFUND")) {
      // Temporary absence after an ACK or 5xx is not proof that the refund failed.
      throw new Error("TOCHKA_REFUND_NOT_YET_VISIBLE");
    }
    if (entries.length !== 1) throw invalid();
    const [refund] = entries;
    const amountKopecks = minor(refund.amount);
    if (amountKopecks !== minor(row.amount) || !["REFUNDED", "ON-REFUND", "APPROVED"].includes(String(row.status))) throw invalid();
    return { outcome: "FOUND", providerRefundId: operationId(refund.orderId), status: row.status === "REFUNDED" ? "SUCCEEDED" : "PROCESSING",
      providerPaymentId: key.providerPaymentId, refundRef, amountKopecks, currency: currency(row) === "RUB" ? currency(refund) : currency(row) };
  }

  // Synthetic receipt evidence only. Runtime admission limits this adapter to a loopback fixture.
  async readAutomaticReceipt(kind: "PAYMENT_RECEIPT" | "REFUND_RECEIPT", paymentId: string, refundId: string | null): Promise<FiscalReadBack> {
    const path = `/fixture/receipts/${operationId(paymentId)}/${refundId ? operationId(refundId) : "sale"}`;
    const result = object((await this.json(path)).Data);
    if (result.status === "NOT_FOUND") return { outcome: "NOT_FOUND" };
    if (result.kind !== kind || result.operationId !== paymentId || result.refundId !== refundId || !this.boundToMerchant(result)
      || result.currency !== "RUB" || result.paymentMethod !== "full_payment" || typeof result.eventRef !== "string"
      || typeof result.receiptId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.receiptId)) throw invalid();
    const status = result.status;
    if (status !== "PROCESSING" && status !== "REGISTERED" && status !== "REJECTED") throw invalid();
    const fiscalSign = result.fiscalSign, issuedAt = result.issuedAt;
    if (status === "REGISTERED" && (typeof fiscalSign !== "string" || !/^\d{1,16}$/.test(fiscalSign)
      || typeof issuedAt !== "string" || !Number.isFinite(Date.parse(issuedAt)))) throw invalid();
    return { outcome: "FOUND", status, eventRef: result.eventRef, amountKopecks: minor(result.amount), paymentMethod: "FULL_PAYMENT",
      providerReceiptId: result.receiptId, ...(status === "REGISTERED" ? { fiscalSign: fiscalSign as string, issuedAt: issuedAt as string } : {}) };
  }

  private async getCallbackKey() {
    if (this.callbackKey && this.callbackKey.expires > Date.now()) return this.callbackKey.key;
    this.fetchingKey ??= this.json(publicKeyPath, undefined, false).then(jwk => {
      if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw invalid();
      const key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
      this.callbackKey = { key, expires: Date.now() + 15 * 60_000 };
      return key;
    }).finally(() => { this.fetchingKey = undefined; });
    return this.fetchingKey;
  }

  async verifyCallback(headers: Readonly<Record<string, string | undefined>>, body: Uint8Array): Promise<NativeCallbackHint | null> {
    if (headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "text/plain" || body.length > 8192) return null;
    try {
      const jwt = Buffer.from(body).toString("utf8");
      const parts = jwt.split(".");
      if (parts.length !== 3 || !parts.every(part => /^[\w-]+$/.test(part))) return null;
      const [header, payload, signature] = parts;
      const decode = (value: string) => object(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
      const protectedHeader = decode(header);
      if (protectedHeader.alg !== "RS256" || protectedHeader.crit !== undefined) return null;
      if (!verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), await this.getCallbackKey(), Buffer.from(signature, "base64url"))) return null;
      const claim = decode(payload);
      if (claim.webhookType !== "acquiringInternetPayment" || claim.merchantId !== this.connection.merchantId
        || claim.customerCode !== this.connection.customerCode || claim.status !== "APPROVED") return null;
      const id = operationId(claim.operationId);
      return { providerEventId: `acquiringInternetPayment:${id}`, subjectKind: "PAYMENT", providerSubjectId: id };
    } catch {
      return null;
    }
  }
}
