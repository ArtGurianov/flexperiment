import { createHmac, timingSafeEqual } from "node:crypto";
import type { FiscalAdapter, FiscalReadBack, FiscalSubmitAnswer, FrozenFiscalEvent } from "./fiscal-port";
import type { FiscalAdapterCapabilities } from "./native-payment-contract";
import type {
  FrozenNativePaymentRequest, FrozenNativeRefundRequest, NativeCallbackHint, NativeCreateAnswer, NativePaymentProvider, NativePaymentReadBack,
  NativeRefundAnswer, NativeRefundReadBack,
} from "./native-payment-provider";

/**
 * FLEX-119 fake bank: local/test only (payment-mode.ts refuses NATIVE_PROVIDER=fake elsewhere). It is the "other side": it keeps its own state, deduplicates by key
 * like a correct provider, and counts the money it actually moved, so a test can assert one debit and
 * at most one return per order whatever the local ledger went through. Faults are scripted per call.
 */
type BankPayment = { id: string; request: FrozenNativePaymentRequest; status: "PENDING" | "PAID" | "DECLINED" | "EXPIRED"; amountOverride?: number };
type BankRefund = { id: string; request: FrozenNativeRefundRequest; status: "PROCESSING" | "SUCCEEDED" | "FAILED" };
export type FakeFault = "LOSE_BEFORE_COMMIT" | "LOSE_AFTER_COMMIT" | "UNAVAILABLE";

export class FakeNativeBank implements NativePaymentProvider {
  readonly name = "fake-bank";
  readonly payments = new Map<string, BankPayment>();
  readonly refunds = new Map<string, BankRefund>();
  readonly calls = { create: [] as FrozenNativePaymentRequest[], readPayment: 0, submitRefund: [] as FrozenNativeRefundRequest[], readRefund: 0 };
  debits = 0;
  returns = 0;
  private sequence = 0;
  readonly faults = { create: [] as FakeFault[], readPayment: [] as FakeFault[], submitRefund: [] as FakeFault[], readRefund: [] as FakeFault[] };
  refuseNextCreate?: string;
  refuseNextRefund?: { code: string; proven: boolean };

  constructor(private readonly callbackSecret = "fake-callback-secret") {}

  private take(list: FakeFault[]) { return list.shift(); }

  async createPayment(request: FrozenNativePaymentRequest): Promise<NativeCreateAnswer> {
    this.calls.create.push(request);
    const fault = this.take(this.faults.create);
    if (fault === "LOSE_BEFORE_COMMIT" || fault === "UNAVAILABLE") throw new Error("ECONNRESET");
    if (this.refuseNextCreate) { const code = this.refuseNextCreate; this.refuseNextCreate = undefined; return { outcome: "REFUSED", code }; }
    let payment = this.payments.get(request.merchantOrderRef);
    if (payment && JSON.stringify(payment.request) !== JSON.stringify(request)) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY");
    if (!payment) {
      payment = { id: `fake-pay-${++this.sequence}`, request, status: "PENDING" };
      this.payments.set(request.merchantOrderRef, payment);
    }
    if (fault === "LOSE_AFTER_COMMIT") throw new Error("ETIMEDOUT");
    return { outcome: "ACCEPTED", providerPaymentId: payment.id, paymentUrl: `https://fake-bank.test/pay/${payment.id}` };
  }

  async readPaymentByOrder(merchantOrderRef: string): Promise<NativePaymentReadBack> {
    this.calls.readPayment += 1;
    if (this.take(this.faults.readPayment)) throw new Error("ETIMEDOUT");
    const payment = this.payments.get(merchantOrderRef);
    if (!payment) return { outcome: "NOT_FOUND" };
    return { outcome: "FOUND", providerPaymentId: payment.id, status: payment.status, merchantOrderRef, currency: "RUB",
      amountKopecks: payment.amountOverride ?? payment.request.amountKopecks, snapshotHash: payment.request.snapshotHash };
  }

  async submitRefund(request: FrozenNativeRefundRequest): Promise<NativeRefundAnswer> {
    this.calls.submitRefund.push(request);
    const fault = this.take(this.faults.submitRefund);
    if (fault === "LOSE_BEFORE_COMMIT" || fault === "UNAVAILABLE") throw new Error("ECONNRESET");
    if (this.refuseNextRefund) { const refusal = this.refuseNextRefund; this.refuseNextRefund = undefined; return { outcome: "REFUSED", ...refusal }; }
    let refund = this.refunds.get(request.refundRef);
    if (refund && JSON.stringify(refund.request) !== JSON.stringify(request)) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY");
    if (!refund) {
      refund = { id: `fake-refund-${++this.sequence}`, request, status: "PROCESSING" };
      this.refunds.set(request.refundRef, refund);
    }
    if (fault === "LOSE_AFTER_COMMIT") throw new Error("ETIMEDOUT");
    return { outcome: "ACCEPTED", providerRefundId: refund.id };
  }

  async readRefund(refundRef: string): Promise<NativeRefundReadBack> {
    this.calls.readRefund += 1;
    if (this.take(this.faults.readRefund)) throw new Error("ETIMEDOUT");
    const refund = this.refunds.get(refundRef);
    if (!refund) return { outcome: "NOT_FOUND" };
    return { outcome: "FOUND", providerRefundId: refund.id, status: refund.status, providerPaymentId: refund.request.providerPaymentId,
      amountKopecks: refund.request.amountKopecks, currency: "RUB", refundRef };
  }

  verifyCallback(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array): NativeCallbackHint | null {
    const expected = createHmac("sha256", this.callbackSecret).update(rawBody).digest();
    const given = Buffer.from(headers["x-fake-signature"] ?? "", "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const body = JSON.parse(Buffer.from(rawBody).toString("utf8")) as NativeCallbackHint;
      return body.providerEventId && body.providerSubjectId && (body.subjectKind === "PAYMENT" || body.subjectKind === "REFUND") ? body : null;
    } catch {
      return null;
    }
  }

  // ─── The buyer's and the bank's own actions ───────────────────────────────────────────────────────
  buyerPays(merchantOrderRef: string) {
    const payment = this.payments.get(merchantOrderRef)!;
    if (payment.status === "PENDING") { payment.status = "PAID"; this.debits += 1; }
  }
  /** A provider that reports success after its own terminal status (late result). */
  latePayment(merchantOrderRef: string) { this.payments.get(merchantOrderRef)!.status = "PAID"; this.debits += 1; }
  expire(merchantOrderRef: string) { this.payments.get(merchantOrderRef)!.status = "EXPIRED"; }
  settleRefund(refundRef: string, status: "SUCCEEDED" | "FAILED" = "SUCCEEDED") {
    const refund = this.refunds.get(refundRef)!;
    if (refund.status === "PROCESSING" && status === "SUCCEEDED") this.returns += 1;
    refund.status = status;
  }
  signedCallback(hint: NativeCallbackHint) {
    const body = Buffer.from(JSON.stringify(hint));
    return { headers: { "x-fake-signature": createHmac("sha256", this.callbackSecret).update(body).digest("hex") }, body };
  }
}

/** A fake cloud-KKT/OFD adapter: idempotent by eventRef, counts receipts it actually registered. */
export class FakeFiscalAdapter implements FiscalAdapter {
  readonly receipts = new Map<string, { id: string; event: FrozenFiscalEvent; status: "PROCESSING" | "REGISTERED" | "REJECTED" }>();
  readonly submitted: FrozenFiscalEvent[] = [];
  readonly faults = { submit: [] as FakeFault[], read: [] as FakeFault[] };
  registeredCount = 0;
  private sequence = 0;
  constructor(readonly capabilities: FiscalAdapterCapabilities = { finalSettlementWithoutPayment: true, refundReceipt: true }, private readonly autoRegister = true) {}

  async submit(event: FrozenFiscalEvent): Promise<FiscalSubmitAnswer> {
    this.submitted.push(event);
    const fault = this.faults.submit.shift();
    if (fault === "LOSE_BEFORE_COMMIT" || fault === "UNAVAILABLE") throw new Error("ECONNRESET");
    let receipt = this.receipts.get(event.eventRef);
    if (receipt && JSON.stringify(receipt.event) !== JSON.stringify(event)) throw new Error("EVENT_REF_REUSED_WITH_DIFFERENT_BODY");
    if (!receipt) {
      receipt = { id: `fake-receipt-${++this.sequence}`, event, status: this.autoRegister ? "REGISTERED" : "PROCESSING" };
      this.receipts.set(event.eventRef, receipt);
      if (receipt.status === "REGISTERED") this.registeredCount += 1;
    }
    if (fault === "LOSE_AFTER_COMMIT") throw new Error("ETIMEDOUT");
    return { outcome: "ACCEPTED", providerReceiptId: receipt.id };
  }

  async read(eventRef: string): Promise<FiscalReadBack> {
    if (this.faults.read.shift()) throw new Error("ETIMEDOUT");
    const receipt = this.receipts.get(eventRef);
    if (!receipt) return { outcome: "NOT_FOUND" };
    return { outcome: "FOUND", providerReceiptId: receipt.id, status: receipt.status, eventRef,
      amountKopecks: receipt.event.totalKopecks, paymentMethod: receipt.event.paymentMethod };
  }
}
