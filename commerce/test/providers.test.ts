import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UnisenderGoProvider } from "../src/email-provider";
import { tochkaConfigFromEnvironment } from "../src/provider-config";
import { TochkaProvider, rublesFromKopecks } from "../src/provider";
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

  it("performs a read-only retailer probe without creating a payment", async () => {
    let request: Request | undefined;
    const provider = new TochkaProvider(tochkaConfig, async (input, init) => {
      request = new Request(input, init);
      return Response.json({ Data: { Retailers: [] }, Links: {}, Meta: {} });
    });
    await expect(provider.probe()).resolves.toEqual({ environment: "production" });
    expect(request?.url).toBe("https://enter.tochka.com/uapi/acquiring/v1.0/retailers");
    expect(request?.method).toBe("GET");
    expect(request?.headers.get("authorization")).toBe("Bearer test-jwt-not-a-secret");
  });

  it("recognizes sandbox provider configuration separately from production", async () => {
    const provider = new TochkaProvider({ ...tochkaConfig, baseUrl: "https://enter.tochka.com/sandbox/v2", clientId: undefined }, async () => Response.json({ Data: { Retailers: [] } }));
    await expect(provider.probe()).resolves.toEqual({ environment: "sandbox" });
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
