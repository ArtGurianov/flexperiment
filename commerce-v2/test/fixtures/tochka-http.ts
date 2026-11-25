import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

const base = "/uapi/acquiring/v1.0";
const customerCode = "000000001", merchantId = "000000000000001";

type Payment = {
  operationId: string; paymentLinkId: string; amount: number; status: "CREATED" | "APPROVED" | "REFUNDED";
  refundId?: string; refundAmount?: number; refundFinal?: boolean;
};

export async function startTochkaHttpFixture(port = 0) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreignKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const payments = new Map<string, Payment>();
  const receipts = new Map<string, object>();
  const calls = { create: 0, refund: 0, info: 0, list: 0, receipt: 0, key: 0, debit: 0, returned: 0 };
  const faults = {
    loseCreate: false, loseRefund: false, hideFromList: false, hideRefund: false, rejectInfo: false,
    currency: undefined as string | undefined, amount: undefined as number | undefined, operationId: undefined as string | undefined,
    paymentLinkId: undefined as string | undefined, lostBeforeCreate: false, lostBeforeRefund: false,
    totalPages: 2, duplicateListing: false, invalidInfo: false, overrideStatus: undefined as string | undefined,
    beforeInfo: undefined as (() => void) | undefined,
  };

  const operation = (payment: Payment) => ({
    customerCode, merchantId, ...payment, amount: faults.amount ?? payment.amount,
    createdAt: new Date().toISOString(), preAuthorization: false, paymentLink: `https://bank.example.test/pay/${payment.operationId}`,
    ...(faults.currency ? { currency: faults.currency } : {}),
    ...(payment.status !== "CREATED" ? { paymentType: "card" } : {}),
    Order: payment.status === "CREATED" ? [] : [
      { type: "approval", orderId: payment.operationId, amount: faults.amount ?? payment.amount, time: new Date().toISOString() },
      ...(payment.refundId && !faults.hideRefund ? [{
        type: "refund", orderId: payment.refundId, amount: payment.refundAmount, time: new Date().toISOString(),
      }] : []),
    ],
  });

  const lookupWindows: Array<[string, string]> = [];
  const respond = (response: ServerResponse, status: number, body: object) => {
    response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  };
  const data = async (request: IncomingMessage) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { Data: Record<string, unknown> }).Data;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/doc/openapi/static/keys/public") {
        calls.key += 1;
        return respond(response, request.headers.authorization ? 400 : 200, keys.publicKey.export({ format: "jwk" }));
      }
      if (request.headers.authorization !== "Bearer local-fixture") return respond(response, 403, {});
      if (request.method === "POST" && url.pathname === `${base}/payments_with_receipt`) {
        calls.create += 1;
        const input = await data(request);
        const item = (input.Items as Record<string, unknown>[] | undefined)?.[0];
        if (input.customerCode !== customerCode || input.merchantId !== merchantId || typeof input.paymentLinkId !== "string"
          || !/^[\w-]{43}$/.test(input.paymentLinkId) || typeof input.amount !== "number" || input.amount <= 0
          || !Array.isArray(input.paymentMode) || input.paymentMode.join() !== "card" || input.preAuthorization !== false || input.saveCard !== false
          || item?.amount !== input.amount || item.quantity !== 1 || item.paymentMethod !== "full_payment"
          || item.paymentObject !== "service" || item.vatType !== "none" || !["usn_income", "usn_income_outcome"].includes(String(input.taxSystemCode))
          || typeof (input.Client as { email?: string } | undefined)?.email !== "string") return respond(response, 400, {});
        if (faults.lostBeforeCreate) return request.socket.destroy();
        const payment: Payment = { operationId: randomUUID(), paymentLinkId: input.paymentLinkId, amount: input.amount, status: "CREATED" };
        payments.set(payment.operationId, payment);
        if (faults.loseCreate) return request.socket.destroy();
        return respond(response, 200, { Data: operation(payment) });
      }
      if (request.method === "GET" && url.pathname === `${base}/payments`) {
        calls.list += 1;
        const from = url.searchParams.get("fromDate"), to = url.searchParams.get("toDate");
        if (url.searchParams.get("customerCode") !== customerCode || !from || !to) return respond(response, 400, {});
        lookupWindows.push([from, to]);
        const page = Number(url.searchParams.get("page"));
        const listed = page === 2 && !faults.hideFromList ? [...payments.values()].map(operation) : [];
        return respond(response, 200, {
          Data: { Operation: faults.duplicateListing ? [...listed, ...listed] : listed }, Meta: { totalPages: faults.totalPages },
        });
      }
      const match = /^\/uapi\/acquiring\/v1\.0\/payments\/([a-f\d-]+)(\/refund)?$/.exec(url.pathname);
      const payment = match && payments.get(match[1]);
      if (payment && request.method === "GET" && !match[2]) {
        calls.info += 1;
        faults.beforeInfo?.();
        if (faults.invalidInfo) return respond(response, 200, { Data: {} });
        if (faults.rejectInfo) return respond(response, 503, {});
        return respond(response, 200, { Data: { Operation: [{ ...operation(payment),
          status: faults.overrideStatus ?? payment.status, operationId: faults.operationId ?? payment.operationId, paymentLinkId: faults.paymentLinkId ?? payment.paymentLinkId,
        }] } });
      }
      if (payment && request.method === "POST" && match[2]) {
        calls.refund += 1;
        const input = await data(request);
        if (Object.keys(input).join() !== "amount" || payment.status !== "APPROVED" || payment.refundId || input.amount !== payment.amount) {
          return respond(response, 400, {});
        }
        if (faults.lostBeforeRefund) return request.socket.destroy();
        payment.refundId = randomUUID();
        payment.refundAmount = payment.amount;
        if (faults.loseRefund) return request.socket.destroy();
        return respond(response, 200, { Data: { isRefund: true, operationId: payment.operationId, amount: payment.amount, orderId: payment.refundId } });
      }
      if (request.method === "GET" && url.pathname.startsWith("/fixture/receipts/")) {
        calls.receipt += 1;
        return respond(response, 200, { Data: receipts.get(url.pathname) ?? { status: "NOT_FOUND" } });
      }
      return respond(response, 404, {});
    })().catch(() => { if (!response.headersSent) respond(response, 400, {}); });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TOCHKA_FIXTURE_ADDRESS_MISSING");
  return {
    origin: `http://127.0.0.1:${address.port}`, calls, faults, payments, lookupWindows,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    pay(payment: Payment) {
      if (payment.status !== "CREATED") return;
      payment.status = "APPROVED";
      calls.debit += 1;
    },
    completeRefund(payment: Payment) {
      if (!payment.refundId || payment.status === "REFUNDED") return;
      payment.status = "REFUNDED";
      calls.returned += 1;
    },
    receipt(payment: Payment, eventRef: string, refund: boolean, override: Record<string, unknown> = {}) {
      const refundId = refund ? payment.refundId : null;
      receipts.set(`/fixture/receipts/${payment.operationId}/${refundId ?? "sale"}`, {
        operationId: payment.operationId, refundId, merchantId, customerCode, eventRef, amount: payment.amount, currency: "RUB",
        kind: refund ? "REFUND_RECEIPT" : "PAYMENT_RECEIPT", paymentMethod: "full_payment", status: "REGISTERED",
        receiptId: `receipt-${refundId ?? payment.operationId}`, issuedAt: new Date().toISOString(), fiscalSign: "12345", ...override,
      });
    },
    callback(payment: Payment, forged = false, override: Record<string, unknown> = {}) {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ webhookType: "acquiringInternetPayment", status: "APPROVED",
        customerCode, merchantId, operationId: payment.operationId, ...override })).toString("base64url");
      const token = `${header}.${payload}`;
      return `${token}.${sign("RSA-SHA256", Buffer.from(token), forged ? foreignKey : keys.privateKey).toString("base64url")}`;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startTochkaHttpFixture(Number(process.argv[2] ?? 8787)).then(fixture => {
    console.log(fixture.origin);
  }).catch(() => { console.error("TOCHKA_FIXTURE_START_FAILED"); process.exitCode = 1; });
}
