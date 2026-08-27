import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EmailProviderAmbiguousError, EmailProviderRejectedError, EventDumpCreateRejectedError, UnisenderGoProvider } from "../src/email-provider";
import { tochkaConfigFromEnvironment } from "../src/provider-config";
import { TochkaProvider, providerErrorEvidence, rublesFromKopecks } from "../src/provider";
import { TochkaWebhookVerifier, webhookAmountKopecks } from "../src/tochka-webhook";
import { verifyUnisenderWebhook } from "../src/unisender-webhook";

const tochkaConfig = { baseUrl: "https://enter.tochka.com/uapi", jwt: "test-jwt-not-a-secret", clientId: "test-client-id", customerCode: "123456789", merchantId: "123456789012345", taxSystemCode: "usn_income" as const, vatType: "none" as const };

describe("provider contracts", () => {
  it("does not require a fictitious client ID for Tochka sandbox, but requires one in production", () => {
    const common = { TOCHKA_JWT: "sandbox.jwt.token", TOCHKA_CUSTOMER_CODE: "1234567ab", TOCHKA_MERCHANT_ID: "200000000001097", TOCHKA_TAX_SYSTEM_CODE: "usn_income", TOCHKA_VAT_TYPE: "none" };
    expect(tochkaConfigFromEnvironment({ ...process.env, ...common, TOCHKA_API_BASE_URL: "https://enter.tochka.com/sandbox/v2", TOCHKA_CLIENT_ID: undefined })).toMatchObject({ clientId: undefined });
    expect(() => tochkaConfigFromEnvironment({ ...process.env, ...common, TOCHKA_API_BASE_URL: "https://enter.tochka.com/uapi", TOCHKA_CLIENT_ID: undefined })).toThrow("TOCHKA_CLIENT_ID");
  });

  it("serializes a frozen full-payment Tochka receipt request without optional card or supplier features", async () => {
    let request: Request | undefined;
    const provider = new TochkaProvider(tochkaConfig, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ Data: { operationId: "operation-1", paymentLink: "https://pay.example.test/operation-1" }, Links: {}, Meta: {} });
    });
    await provider.createPayment({ paymentId: "payment-1", paymentLinkId: "payment-1", amountKopecks: 12345, idempotencyKey: "stable-key", successUrl: "https://flexperiment.ru/payment/success?order=status-1", customerEmail: "buyer@example.test", purpose: "Оплата участия в мастер-классе ФЛЭКСПЕРИМЕНТ", receiptItemName: "Участие в мастер-классе ФЛЭКСПЕРИМЕНТ — Томск, 1 октября 2026 г." });
    expect(request?.url).toBe("https://enter.tochka.com/uapi/acquiring/v1.0/payments_with_receipt");
    expect(request?.headers.get("authorization")).toBe("Bearer test-jwt-not-a-secret");
    const body = await request?.json() as { Data: Record<string, unknown> };
    expect(body.Data).toMatchObject({ amount: 123.45, paymentMode: ["card", "sbp"], preAuthorization: false, ttl: 20, taxSystemCode: "usn_income", Client: { email: "buyer@example.test" } });
    expect(body.Data.Items).toEqual([{ name: "Участие в мастер-классе ФЛЭКСПЕРИМЕНТ — Томск, 1 октября 2026 г.", amount: 123.45, quantity: 1, vatType: "none", paymentMethod: "full_payment", paymentObject: "service" }]);
    expect(body.Data).not.toHaveProperty("Supplier");
    expect(body.Data).not.toHaveProperty("saveCard");
    expect(body.Data).not.toHaveProperty("consumerId");
  });

  it("performs documented read-only retailer and calendar-date list probes without creating a payment", async () => {
    const requests: Request[] = [];
    const provider = new TochkaProvider(tochkaConfig, async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      return new URL(request.url).pathname.endsWith("/retailers")
        ? Response.json({ Data: { Retailers: [] }, Links: {}, Meta: {} })
        : Response.json({ Data: { Operation: [] }, Links: {}, Meta: {} });
    }, () => Date.parse("2026-08-27T16:45:00.000Z"));
    await expect(provider.probe()).resolves.toEqual({ environment: "production" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain("/uapi/acquiring/v1.0/retailers?");
    expect(Object.fromEntries(new URL(requests[0]!.url).searchParams)).toEqual({ customerCode: tochkaConfig.customerCode });
    expect(requests[1]?.url).toContain("/uapi/acquiring/v1.0/payments?");
    expect(Object.fromEntries(new URL(requests[1]!.url).searchParams)).toEqual({ customerCode: tochkaConfig.customerCode, fromDate: "2026-08-27", toDate: "2026-08-27", page: "1", perPage: "1" });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-jwt-not-a-secret");
  });

  it("requires production readiness to pass both the retailers and payment-list probes without merchantId or pageSize", async () => {
    const requests: Request[] = [];
    const provider = new TochkaProvider(tochkaConfig, async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      return new URL(request.url).pathname.endsWith("/retailers")
        ? Response.json({ Data: { Retailers: [] } })
        : Response.json({ Data: { Operation: [] } });
    });
    await expect(provider.probe()).resolves.toMatchObject({ environment: "production" });
    const retailersParams = Object.fromEntries(new URL(requests[0]!.url).searchParams);
    expect(retailersParams).toEqual({ customerCode: tochkaConfig.customerCode });
    const paymentListParams = Object.fromEntries(new URL(requests[1]!.url).searchParams);
    expect(paymentListParams).toEqual({ customerCode: tochkaConfig.customerCode, fromDate: expect.any(String), toDate: expect.any(String), page: "1", perPage: "1" });
    expect(paymentListParams).not.toHaveProperty("merchantId");
    expect(paymentListParams).not.toHaveProperty("pageSize");
  });

  it("paginates the read-only payment list and preserves every matching paymentLinkId", async () => {
    const requests: Request[] = [];
    const provider = new TochkaProvider(tochkaConfig, async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      const page = new URL(request.url).searchParams.get("page");
      return Response.json(page === "1"
        ? { Data: { Operation: [{ paymentLinkId: "payment-link-1", operationId: "operation-1", paymentLink: "https://pay.example.test/1", amount: 1, customerCode: tochkaConfig.customerCode, merchantId: tochkaConfig.merchantId }] }, Meta: { currentPage: 1, totalPages: 2 } }
        : { Data: { Operation: [{ paymentLinkId: "payment-link-1", operationId: "operation-2", paymentLink: "https://pay.example.test/2", amount: 1, customerCode: tochkaConfig.customerCode, merchantId: tochkaConfig.merchantId }] }, Meta: { currentPage: 2, totalPages: 2 } });
    });
    const matches = await provider.findPaymentOperationsByLinkId({ paymentLinkId: "payment-link-1", fromDate: "2026-08-23T00:00:00.000Z", toDate: "2026-08-23T01:00:00.000Z" });
    expect(matches).toEqual([
      { paymentLinkId: "payment-link-1", operationId: "operation-1", paymentLink: "https://pay.example.test/1", amountKopecks: 100, customerMatches: true, merchantMatches: true },
      { paymentLinkId: "payment-link-1", operationId: "operation-2", paymentLink: "https://pay.example.test/2", amountKopecks: 100, customerMatches: true, merchantMatches: true },
    ]);
    expect(requests).toHaveLength(2);
    const first = new URL(requests[0].url);
    expect(first.pathname).toBe("/uapi/acquiring/v1.0/payments");
    expect(Object.fromEntries(first.searchParams)).toEqual({ customerCode: tochkaConfig.customerCode, fromDate: "2026-08-23", toDate: "2026-08-23", page: "1", perPage: "100" });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("recognizes sandbox provider configuration separately from production", async () => {
    const provider = new TochkaProvider({ ...tochkaConfig, baseUrl: "https://enter.tochka.com/sandbox/v2", clientId: undefined }, async (input) =>
      new URL(String(input)).pathname.endsWith("/retailers") ? Response.json({ Data: { Retailers: [] } }) : Response.json({ Data: { Operation: [] } }));
    await expect(provider.probe()).resolves.toEqual({ environment: "sandbox" });
  });

  it("preserves safe Tochka validation details for an isolated probe", async () => {
    const provider = new TochkaProvider(tochkaConfig, async () => Response.json({ code: "400", id: "error-1", message: "Validation failed", Errors: [{ errorCode: "Validation Error", message: "paymentMode is required" }] }, { status: 400 }));
    await expect(provider.createPayment({ paymentId: "payment-1", paymentLinkId: "payment-1", amountKopecks: 100, idempotencyKey: "stable-key", successUrl: "https://flexperiment.ru/payment/success", customerEmail: "buyer@example.test", purpose: "Probe", receiptItemName: "Probe" }))
      .rejects.toThrow("Tochka HTTP 400: code=400; id=error-1; Validation failed; errors=Validation Error: paymentMode is required");
  });

  it("classifies untrusted TLS and HTTP failures without retaining raw transport details", async () => {
    const tlsProvider = new TochkaProvider(tochkaConfig, async () => { throw Object.assign(new Error("certificate chain changed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }); });
    await expect(tlsProvider.probe()).rejects.toMatchObject({ evidence: { provider_error_class: "TLS_CERT_CHAIN_UNTRUSTED", provider_error_code: "SELF_SIGNED_CERT_IN_CHAIN" } });
    expect(providerErrorEvidence(Object.assign(new Error("bad gateway"), { code: "ECONNRESET" }))).toEqual({ provider_error_class: "PROVIDER_NETWORK", provider_error_code: "ECONNRESET" });
    const httpProvider = new TochkaProvider(tochkaConfig, async () => Response.json({ message: "details that are not durable evidence" }, { status: 400 }));
    await expect(httpProvider.probe()).rejects.toMatchObject({ evidence: { provider_error_class: "PROVIDER_BAD_REQUEST", provider_error_code: "HTTP_400" } });
  });

  it("keeps financial values in kopecks until exact edge serialization", () => {
    expect(rublesFromKopecks(1)).toBe("0.01");
    expect(rublesFromKopecks(12345)).toBe("123.45");
    expect(webhookAmountKopecks("123.45")).toBe(12345);
    expect(() => webhookAmountKopecks("123.456")).toThrow();
  });

  it("renders code-owned Unisender content with persistent outbox metadata", async () => {
    let request: Request | undefined;
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async (input, init) => {
      request = new Request(input, init); return Response.json({ status: "success", job_id: "job-1" });
    });
    await provider.send({ recipientEmail: "buyer@example.test", template: "ticket", payload: { ticket_url: "https://flexperiment.ru/ticket#capability" }, idempotencyKey: "stable-outbox-key", outboxId: "outbox-1" });
    expect(request?.headers.get("x-api-key")).toBe("test-key-not-a-secret");
    const body = await request?.json() as { message: Record<string, unknown> };
    expect(body.message.global_metadata).toEqual({ outbox_id: "outbox-1" });
    expect(body.message.idempotence_key).toBe("stable-outbox-key");
    expect(body.message).not.toHaveProperty("template_id");
  });

  it("classifies a received Unisender HTTP rejection as terminal-safe evidence", async () => {
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () =>
      Response.json({ code: "FORBIDDEN", message: "Sending to buyer@example.test is forbidden; Authorization: test-key-not-a-secret payload: https://flexperiment.ru/ticket#capability" }, { status: 403 }));

    try {
      await provider.send({ recipientEmail: "buyer@example.test", template: "ticket", payload: { ticket_url: "https://flexperiment.ru/ticket#capability" }, idempotencyKey: "stable-outbox-key", outboxId: "outbox-1" });
      throw new Error("Expected Unisender rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailProviderRejectedError);
      expect(error).toMatchObject({ httpStatus: 403, providerCode: "FORBIDDEN", providerMessage: expect.stringContaining("[redacted-email]") });
      expect((error as EmailProviderRejectedError).providerMessage).not.toContain("buyer@example.test");
      expect((error as EmailProviderRejectedError).providerMessage).not.toContain("test-key-not-a-secret");
      expect((error as EmailProviderRejectedError).providerMessage).not.toContain("ticket#capability");
    }
  });

  it("treats a 2xx response without a job ID as ambiguous rather than rejected", async () => {
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () =>
      Response.json({ status: "success" }));

    await expect(provider.send({ recipientEmail: "buyer@example.test", template: "ticket", payload: { ticket_url: "https://flexperiment.ru/ticket#capability" }, idempotencyKey: "stable-outbox-key", outboxId: "outbox-1" }))
      .rejects.toBeInstanceOf(EmailProviderAmbiguousError);
  });

  it("uses the documented minimal Event Dump fields and parses only strict provider evidence", async () => {
    const requests: Request[] = [];
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (request.url.endsWith("event-dump/list.json")) return Response.json({ status: "success", event_dumps: [] });
      if (request.url.endsWith("event-dump/create.json")) return Response.json({ status: "success", dump_id: "dump-1" });
      if (request.url.endsWith("event-dump/get.json")) return Response.json({ status: "success", event_dump: { dump_status: "ready", files: [{ url: "https://go2.unisender.ru/event-dump/dump-1.csv" }] } });
      return new Response('event_time,job_id,status,delivery_status,metadata\n2026-08-24 08:35:20,job-1,delivered,ok_delivered,"{\"\"outbox_id\"\":\"\"outbox-1\"\"}"\n2026-08-24 08:35:21,job-2,delivered,ok_delivered,malformed-json\n', { headers: { "Content-Type": "text/csv" } });
    });
    await expect(provider.createEventDump({ startTime: "2026-08-24 08:00:00", endTime: "2026-08-24 09:00:00" })).resolves.toEqual({ dumpId: "dump-1" });
    const create = await requests[0].json() as Record<string, unknown>;
    expect(create).toMatchObject({ start_time: "2026-08-24 08:00:00", end_time: "2026-08-24 09:00:00", dump_fields: ["event_time", "job_id", "status", "delivery_status", "metadata"] });
    expect(create.limit).toBe(100_000);
    expect(JSON.stringify(create)).not.toContain("email");
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    await expect(provider.getEventDump({ dumpId: "dump-1" })).resolves.toEqual({ status: "ready", returnedEventCount: 2, events: [{ eventTime: "2026-08-24 08:35:20", jobId: "job-1", status: "delivered", deliveryStatus: "ok_delivered", metadata: { outbox_id: "outbox-1" } }] });
    expect(requests).toHaveLength(3);
  });

  it("accepts queued Event Dump state without files and distinguishes deterministic create rejection", async () => {
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async (input) => {
      const url = String(input);
      if (url.endsWith("event-dump/get.json")) return Response.json({ status: "success", event_dump: { dump_status: "queued" } });
      return Response.json({ status: "error" }, { status: 400 });
    });
    await expect(provider.getEventDump({ dumpId: "queued-without-files" })).resolves.toEqual({ status: "queued", events: [], returnedEventCount: 0 });
    await expect(provider.createEventDump({ startTime: "2026-08-24 08:00:00", endTime: "2026-08-24 09:00:00" }))
      .rejects.toBeInstanceOf(EventDumpCreateRejectedError);
  });

  it("treats omitted Event Dump files as a valid non-ready provider state", async () => {
    for (const status of ["queued", "in_process"] as const) {
      const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () =>
        Response.json({ status: "success", event_dump: { dump_status: status } }));
      await expect(provider.getEventDump({ dumpId: status })).resolves.toEqual({ status, events: [], returnedEventCount: 0 });
    }
    const ready = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () =>
      Response.json({ status: "success", event_dump: { dump_status: "ready", files: [] } }));
    await expect(ready.getEventDump({ dumpId: "ready-empty" })).resolves.toEqual({ status: "ready", events: [], returnedEventCount: 0 });
  });

  it("reads downloadable in-process Event Dump files without waiting for ready", async () => {
    let calls = 0;
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async () => {
      calls += 1;
      if (calls === 1) return Response.json({ status: "success", event_dump: { dump_status: "in_process", files: [{ url: "https://go1.unisender.ru/dump.csv" }] } });
      return new Response('event_time,job_id,status,delivery_status,metadata\n2026-08-24 08:35:20,job-1,sent,ok_sent,"{""outbox_id"":""outbox-1""}"\n');
    });
    await expect(provider.getEventDump({ dumpId: "in-process-file" })).resolves.toEqual({ status: "in_process", returnedEventCount: 1, events: [
      { eventTime: "2026-08-24 08:35:20", jobId: "job-1", status: "sent", deliveryStatus: "ok_sent", metadata: { outbox_id: "outbox-1" } },
    ] });
  });

  it("uses documented Event Dump list as a read-only provider capacity probe", async () => {
    let request: Request | undefined;
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ status: "success", event_dumps: [{ dump_id: "one" }, { dump_id: "two" }] });
    });
    await expect(provider.listEventDumps()).resolves.toEqual({ count: 2 });
    expect(request?.url).toBe("https://goapi.unisender.ru/ru/transactional/api/v1/event-dump/list.json");
    expect(request?.method).toBe("POST");
    expect(await request?.json()).toEqual({});
  });

  it("uses the documented job_id filter for saturated Event Dump target recovery", async () => {
    let request: Request | undefined;
    const provider = new UnisenderGoProvider({ apiKey: "test-key-not-a-secret", fromEmail: "noreply@example.test", fromName: "Flexperiment", replyToEmail: "hello@example.test" }, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ status: "success", dump_id: "targeted-dump" });
    });
    await expect(provider.createEventDump({ startTime: "2026-08-24 08:00:00", endTime: "2026-08-24 09:00:00", jobId: "known-job" }))
      .resolves.toEqual({ dumpId: "targeted-dump" });
    expect(await request?.json()).toMatchObject({ filter: { job_id: "known-job" }, limit: 100_000 });
  });

  it("verifies an RS256 Tochka callback with a refreshed JWK", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ webhookType: "acquiringInternetPayment", operationId: "operation-1" })).toString("base64url");
    const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
    const jwk = publicKey.export({ format: "jwk" });
    const verifier = new TochkaWebhookVerifier(async () => Response.json(jwk));
    await expect(verifier.verify(`${header}.${payload}.${signature}`)).resolves.toMatchObject({ operationId: "operation-1" });
  });

  it("verifies the documented Unisender raw-body auth envelope", () => {
    const apiKey = "test-api-key-not-a-secret";
    const unsigned = JSON.stringify({ auth: "pending", events_by_user: [{ user_id: 1, events: [{ event_name: "transactional_email_status", event_data: { job_id: "job-1", metadata: { outbox_id: "outbox-1" }, status: "delivered", event_time: "2026-08-20 00:00:00" } }] }] });
    const signed = unsigned.replace("pending", createHash("md5").update(unsigned.replace("pending", apiKey)).digest("hex"));
    expect(verifyUnisenderWebhook(signed, apiKey)).toBe(true);
    expect(verifyUnisenderWebhook(signed, "different-test-key")).toBe(false);
  });
});
