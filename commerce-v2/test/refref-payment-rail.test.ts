import { describe, expect, it, vi } from "vitest";
import { buildCheckoutSnapshot } from "../src/checkout-snapshot";
import { RefrefPaymentRail, refrefSnapshotDigest } from "../src/refref-payment-rail";
import { AmbiguousRailCreateError, type PaymentCreateInput, type PaymentResolveInput } from "../src/checkout";

const input: PaymentResolveInput = {
  idempotencyKey: "idem", orderPublicId: "order", amountKopecks: 10_000,
  customerEmail: "student@example.com", offerRef: "course:one", productRef: "course:one", lineRef: "line",
  legalReleaseRef: "stage-b-v1", legalReleaseHash: "a".repeat(64), handoffToken: "h".repeat(32),
};

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const createInput = (rail: RefrefPaymentRail): PaymentCreateInput => {
  const quote = {
    resolutionId: "10000000-0000-4000-8000-000000000001",
    termsVersionId: null,
    baseAmountKopecks: input.amountKopecks,
    discountKopecks: 0,
    finalAmountKopecks: input.amountKopecks,
    checkoutCodeOutcome: "NONE" as const,
  };
  const frozen = buildCheckoutSnapshot({
    config: rail.checkoutSnapshotConfig,
    merchantOrderRef: input.orderPublicId,
    line: {
      lineRef: input.lineRef,
      offerRef: input.offerRef,
      merchantOfferAmountKopecks: input.amountKopecks,
      referralDiscountAmountKopecks: 0,
      fiscalName: input.productRef,
    },
    referralResolutionId: quote.resolutionId,
    termsVersionId: quote.termsVersionId,
    legalReleaseRef: input.legalReleaseRef,
    legalReleaseHash: input.legalReleaseHash,
  });
  return { ...input, quote, ...frozen, successUrl: "https://flexperiment.ru/checkout/return?state=signed" };
};

describe("RefrefPaymentRail", () => {
  it("reproduces the independently pinned Refref RC.2 digest", () => {
    expect(refrefSnapshotDigest({
      schema: "refref.shared-checkout-snapshot/1",
      merchantId: "3f1c2a5e-8b4d-4c7e-9a10-2b6d8e4f1a90",
      merchantOrderRef: "mk-2026-0142",
      currency: "RUB",
      referralResolutionId: "7a0e1c3b-5d2f-4e8a-b6c1-9f3d2e4a5b60",
      termsVersionId: "c2b7d9e1-4a3f-4b6c-8d2e-1f0a9b8c7d65",
      lines: [{
        lineRef: "line_01", offerRef: "altai-tour", unitRef: "altai-2026-10-10", quantity: 2,
        merchantOfferAmountKopecks: 6_800_000, referralDiscountAmountKopecks: 400_000,
        finalAmountKopecks: 6_400_000, serviceStartsAt: "2026-10-09T17:30:00Z", serviceEndsAt: "2026-10-13T14:00:00Z",
      }],
      totalContractAmountKopecks: 6_400_000,
      paymentObligations: [{
        obligationRef: "full", kind: "FULL", executionMode: "ORCHESTRATED", fiscalizationMode: "MERCHANT",
        amountKopecks: 6_400_000, allocations: [{ lineRef: "line_01", amountKopecks: 6_400_000 }],
        fiscal: { taxSystem: "USN_INCOME", items: [{
          lineRef: "line_01", name: "Тур «Алтай», 10–13.10.2026", quantity: 2, amountKopecks: 6_400_000,
          vatCode: "NONE", paymentMethod: "FULL_PREPAYMENT", paymentObject: "SERVICE",
        }] },
      }],
      inventoryReservationRef: "res-altai-2026-10-10-0142",
      legalReleaseRef: "mikluha-offer-2026-09",
      legalReleaseHash: "sha256:9f2c61b0e4d7a3c85e1f0b2a6d9c4e7f",
    })).toBe("refref-jcs-1:95c2d583ed74a929dd18eb725ce926fc4c6ae0d497c8a849580d79a90079b6bd");
  });

  it("uses the documented resolution, attempt and obligation-session protocol", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ status: "RESOLVED", referralResolutionId: "10000000-0000-4000-8000-000000000001", termsVersionId: null,
        checkoutCodeOutcome: "NONE",
        lines: [{ lineRef: "line", referralDiscountAmountKopecks: 500 }] }, 201));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001",
      paymentMethod: "full_prepayment", fetch: request });
    const resolution = await rail.resolve(input);
    expect(resolution).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", quote: { discountKopecks: 500, finalAmountKopecks: 9500, checkoutCodeOutcome: "NONE" } });
    if (resolution.state !== "PRICE_REVIEW_REQUIRED") throw new Error("expected quote");
    const frozen = buildCheckoutSnapshot({
      config: rail.checkoutSnapshotConfig,
      merchantOrderRef: input.orderPublicId,
      line: {
        lineRef: input.lineRef,
        offerRef: input.offerRef,
        merchantOfferAmountKopecks: input.amountKopecks,
        referralDiscountAmountKopecks: resolution.quote.discountKopecks,
        fiscalName: input.productRef,
      },
      referralResolutionId: resolution.quote.resolutionId,
      termsVersionId: resolution.quote.termsVersionId,
      legalReleaseRef: input.legalReleaseRef,
      legalReleaseHash: input.legalReleaseHash,
    });
    request
      .mockResolvedValueOnce(response({ checkoutAttemptId: "20000000-0000-4000-8000-000000000002", snapshotHash: frozen.snapshotHash, obligations: [] }, 201))
      .mockResolvedValueOnce(response({ status: "PAYMENT_READY", providerPaymentUrl: "https://pay.refref.ru/session", supportReference: "support" }));
    await expect(rail.create({
      ...input,
      quote: resolution.quote,
      snapshot: frozen.snapshot,
      snapshotHash: frozen.snapshotHash,
      successUrl: "https://flexperiment.ru/checkout/return?state=signed",
    })).resolves.toMatchObject({ attemptId: "20000000-0000-4000-8000-000000000002", state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: "https://pay.refref.ru/session" });
    expect(new URL(String(request.mock.calls[0]?.[0])).pathname).toBe("/v1-rc/integrations/referral-resolutions");
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/v1-rc/integrations/orders/order/checkout-attempts");
    const attemptBody = JSON.parse(String((request.mock.calls[1]?.[1] as RequestInit).body)) as { snapshot: Record<string, unknown>; snapshotHash: string };
    expect(attemptBody.snapshotHash).toBe(refrefSnapshotDigest(attemptBody.snapshot));
    expect(JSON.stringify(attemptBody.snapshot)).not.toContain("student@example.com");
    const sessionBody = JSON.parse(String((request.mock.calls[2]?.[1] as RequestInit).body)) as { successUrl: string; receiptContact: { email: string } };
    expect(sessionBody).toEqual({
      successUrl: "https://flexperiment.ru/checkout/return?state=signed",
      receiptContact: { email: "student@example.com" },
    });
  });

  it("returns customer action without freezing an attempt", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ status: "CUSTOMER_ACTION_REQUIRED",
      referralResolutionId: "10000000-0000-4000-8000-000000000001", customerActionUrl: "https://checkout.refref.ru/conflict" }));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001",
      paymentMethod: "full_prepayment", fetch: request });
    expect(await rail.resolve(input)).toMatchObject({ state: "CUSTOMER_ACTION_REQUIRED", checkoutUrl: "https://checkout.refref.ru/conflict" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reads the merchant order before recovering an ambiguous attempt", async () => {
    const request = vi.fn<typeof fetch>();
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", paymentMethod: "full_prepayment", fetch: request });
    const recoveredInput = createInput(rail);
    request
      .mockResolvedValueOnce(response({
        id: "merchant-order", merchantOrderId: "order", status: "OPEN",
        checkoutAttempts: [{
          id: "20000000-0000-4000-8000-000000000002",
          status: "OPEN",
          referralResolutionId: recoveredInput.quote.resolutionId,
          snapshotHash: recoveredInput.snapshotHash,
          lineItems: [{ lineRef: "line", offerRef: "course:one", refundableAmountKopecks: 0 }],
          obligations: [{ obligationRef: "full", status: "OUTSTANDING", payment: null }],
        }],
      }))
      .mockResolvedValueOnce(response({ status: "PAYMENT_READY", providerPaymentUrl: "https://pay.refref.ru/replayed" }));

    await expect(rail.recoverCreate(recoveredInput)).resolves.toMatchObject({
      attemptId: "20000000-0000-4000-8000-000000000002",
      state: "CUSTOMER_ACTION_REQUIRED",
      checkoutUrl: "https://pay.refref.ru/replayed",
    });
    expect(request.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/v1-rc/integrations/merchant-orders/order",
      "/v1-rc/integrations/orders/order/checkout-attempts/20000000-0000-4000-8000-000000000002/obligations/full/payment-session",
    ]);
  });

  it("carries the created attempt identity across an ambiguous payment-session response", async () => {
    const request = vi.fn<typeof fetch>();
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", paymentMethod: "full_prepayment", fetch: request });
    const command = createInput(rail);
    request
      .mockResolvedValueOnce(response({
        checkoutAttemptId: "20000000-0000-4000-8000-000000000002",
        snapshotHash: command.snapshotHash,
        obligations: [],
      }, 201))
      .mockResolvedValueOnce(response({ error: { code: "UPSTREAM_UNAVAILABLE", message: "unknown", requestId: "request" } }, 502));

    const error = await rail.create(command).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AmbiguousRailCreateError);
    expect((error as AmbiguousRailCreateError).evidence).toEqual({
      attemptId: "20000000-0000-4000-8000-000000000002",
      resolutionId: command.quote.resolutionId,
      snapshotHash: command.snapshotHash,
    });
  });

  it("surfaces the nested OpenAPI error code", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({
      error: { code: "HANDOFF_TOKEN_INVALID", message: "invalid", requestId: "request" },
    }, 422));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", paymentMethod: "full_prepayment", fetch: request });
    await expect(rail.resolve(input)).rejects.toThrow("REFREF_HANDOFF_TOKEN_INVALID");
  });

  it("preserves Refref refund execution evidence without claiming the refund fact exists", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        id: "attempt", status: "SETTLED", referralResolutionId: "resolution", snapshotHash: "refref-jcs-1:snapshot",
        lineItems: [{ lineRef: "line", offerRef: "course:one", refundableAmountKopecks: 10_000 }],
        obligations: [{ obligationRef: "full", status: "SATISFIED", payment: {
          id: "payment", status: "SUCCEEDED", amountKopecks: 10_000, remainingRefundableAmountKopecks: 10_000,
        } }],
      }))
      .mockResolvedValueOnce(response({
        status: "REFUND_PROCESSING", refundExecutionId: "refund-execution", supportReference: "support-refund",
      }, 202));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001",
      paymentMethod: "full_prepayment", fetch: request });
    await expect(rail.refund({
      idempotencyKey: "refund:request", orderPublicId: "order", attemptId: "attempt", amountKopecks: 10_000,
      customerEmail: "student@example.com", lineRef: "line",
      fiscalItem: { lineRef: "line", name: "Курс", quantity: 1, amountKopecks: 10_000,
        vatCode: "NONE", paymentMethod: "full_prepayment", paymentObject: "SERVICE" },
    })).resolves.toMatchObject({
      state: "REFUND_PENDING", refundExecutionId: "refund-execution", supportReference: "support-refund",
    });
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toBe("/v1-rc/integrations/refunds");
    expect((request.mock.calls[1]?.[1] as RequestInit).headers).toMatchObject({ "idempotency-key": "refund:request:refund" });
    const refundBody = JSON.parse(String((request.mock.calls[1]?.[1] as RequestInit).body));
    expect(refundBody).toMatchObject({ fiscal: { items: [{ lineRef: "line", name: "Курс", amountKopecks: 10_000 }] } });
    expect(refundBody).not.toHaveProperty("lineAllocations");
  });

  it("sends explicit line allocation and the frozen fiscal item for a partial refund", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        id: "attempt", status: "SETTLED", referralResolutionId: "resolution", snapshotHash: "refref-jcs-1:snapshot",
        lineItems: [{ lineRef: "line", offerRef: "course:one", refundableAmountKopecks: 10_000 }],
        obligations: [{ obligationRef: "full", status: "SATISFIED", payment: {
          id: "payment", status: "SUCCEEDED", amountKopecks: 10_000, remainingRefundableAmountKopecks: 10_000,
        } }],
      }))
      .mockResolvedValueOnce(response({
        status: "REFUND_SUBMITTED", refundExecutionId: "refund-execution", supportReference: "support-refund",
      }, 202));
    const rail = new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.ru/v1-rc/", apiKey: "key",
      merchantId: "00000000-0000-4000-8000-000000000001", paymentMethod: "full_prepayment", fetch: request });
    await expect(rail.refund({
      idempotencyKey: "refund:partial", orderPublicId: "order", attemptId: "attempt", amountKopecks: 4_000,
      customerEmail: "student@example.com", lineRef: "line",
      fiscalItem: { lineRef: "line", name: "Курс по TypeScript", quantity: 1, amountKopecks: 10_000,
        vatCode: "NONE", paymentMethod: "full_prepayment", paymentObject: "SERVICE" },
    })).resolves.toMatchObject({ state: "REFUND_PENDING", expectedRemainingRefundableAmountKopecks: 6_000 });
    const refundBody = JSON.parse(String((request.mock.calls[1]?.[1] as RequestInit).body));
    expect(refundBody).toMatchObject({
      lineAllocations: [{ lineRef: "line", amountKopecks: 4_000 }],
      fiscal: { items: [{ lineRef: "line", name: "Курс по TypeScript", amountKopecks: 4_000 }] },
    });
  });
});
