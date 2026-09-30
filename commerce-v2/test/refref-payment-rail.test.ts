import { describe, expect, it, vi } from "vitest";
import { RefrefPaymentRail, refrefSnapshotDigest } from "../src/refref-payment-rail";
import type { PaymentResolveInput } from "../src/checkout";

const input: PaymentResolveInput = {
  idempotencyKey: "idem", orderPublicId: "order", amountKopecks: 10_000,
  customerEmail: "student@example.com", offerRef: "course:one", productRef: "course:one", lineRef: "line",
  legalReleaseRef: "stage-b-v1", legalReleaseHash: "a".repeat(64), handoffToken: "h".repeat(32),
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("RefrefPaymentRail", () => {
  it("uses the documented resolution, attempt and obligation-session protocol", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ status: "RESOLVED", referralResolutionId: "10000000-0000-4000-8000-000000000001", termsVersionId: null,
        checkoutCodeOutcome: "NONE",
        lines: [{ lineRef: "line", referralDiscountAmountKopecks: 500 }] }, 201))
      .mockResolvedValueOnce(response({ checkoutAttemptId: "20000000-0000-4000-8000-000000000002", snapshotHash: "ignored", obligations: [] }, 201))
      .mockResolvedValueOnce(response({ status: "PAYMENT_READY", providerPaymentUrl: "https://pay.refref.ru/session", supportReference: "support" }));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", successUrl: "https://flexperiment.ru/checkout/return",
      paymentMethod: "full_prepayment", fetch: request });
    const resolution = await rail.resolve(input);
    expect(resolution).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", quote: { discountKopecks: 500, finalAmountKopecks: 9500, checkoutCodeOutcome: "NONE" } });
    if (resolution.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    await expect(rail.create({ ...input, quote: resolution.quote })).resolves.toMatchObject({ attemptId: "20000000-0000-4000-8000-000000000002", state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: "https://pay.refref.ru/session" });
    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe("/v1-rc/integrations/referral-resolutions");
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/v1-rc/integrations/orders/order/checkout-attempts");
    const attemptBody = JSON.parse(String((request.mock.calls[1]?.[1] as RequestInit).body)) as { snapshot: Record<string, unknown>; snapshotHash: string };
    expect(attemptBody.snapshotHash).toBe(refrefSnapshotDigest(attemptBody.snapshot));
    expect(JSON.stringify(attemptBody.snapshot)).not.toContain("student@example.com");
    expect(String((request.mock.calls[2]?.[1] as RequestInit).body)).toContain("student@example.com");
  });

  it("returns customer action without freezing an attempt", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ status: "CUSTOMER_ACTION_REQUIRED",
      referralResolutionId: "10000000-0000-4000-8000-000000000001", customerActionUrl: "https://checkout.refref.ru/conflict" }));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", successUrl: "https://flexperiment.ru/checkout/return",
      paymentMethod: "full_prepayment", fetch: request });
    expect(await rail.resolve(input)).toMatchObject({ state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: "https://checkout.refref.ru/conflict" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves Refref refund execution evidence without claiming the refund fact exists", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        id: "attempt", status: "SETTLED", lineItems: [{ lineRef: "line", offerRef: "course:one" }],
        obligations: [{ obligationRef: "full", status: "SATISFIED", payment: { id: "payment", status: "SUCCEEDED" } }],
      }))
      .mockResolvedValueOnce(response({
        status: "REFUND_PROCESSING", refundExecutionId: "refund-execution", supportReference: "support-refund",
      }, 202));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", successUrl: "https://flexperiment.ru/checkout/return",
      paymentMethod: "full_prepayment", fetch: request });
    await expect(rail.refund({
      idempotencyKey: "refund:request", orderPublicId: "order", attemptId: "attempt", amountKopecks: 10_000,
      customerEmail: "student@example.com",
    })).resolves.toMatchObject({
      state: "REFUND_PENDING", refundExecutionId: "refund-execution", supportReference: "support-refund",
    });
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/v1-rc/integrations/refunds");
    expect((request.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ "idempotency-key": "refund:request:refund" });
  });
});
