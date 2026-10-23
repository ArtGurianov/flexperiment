import { describe, expect, it, vi } from "vitest";
import { RefrefPaymentRail } from "../src/refref-payment-rail";
import { resolutionInputHash } from "../src/refref-contract/shared-checkout-snapshot";
import type { PaymentResolveInput } from "../src/checkout";

const merchantId = "00000000-0000-4000-8000-000000000001";
const input: PaymentResolveInput = { protocol: "VNEXT", idempotencyKey: "same-preview", request: {
  merchantOrderRef: "order-1", storefrontOrigin: "https://platform.example.test", browserContextId: "ctx_" + "a".repeat(32),
  currency: "RUB", lines: [{ lineRef: "line-1", offerRef: "course:one", quantity: 1, merchantOfferAmountKopecks: 10001 }],
  deliveryDegraded: { degraded: true, reason: "TIMEOUT" }, checkoutCode: "PARTNER20",
} };
const resolved = () => ({ referralResolutionId: "10000000-0000-4000-8000-000000000001", merchantOrderRef: input.request.merchantOrderRef,
  storefrontOrigin: input.request.storefrontOrigin, browserContextId: input.request.browserContextId, attributionSource: "ARRIVAL",
  campaignId: "20000000-0000-4000-8000-000000000002", termsVersionId: "30000000-0000-4000-8000-000000000003",
  checkoutCodeOutcome: "NOT_APPLIED_ARRIVAL_PRIORITY", deliveryDegraded: input.request.deliveryDegraded,
  inputHash: resolutionInputHash({ schema: "refref.referral-resolution-input/1", merchantId,
    merchantOrderRef: input.request.merchantOrderRef, currency: input.request.currency, lines: input.request.lines }), currency: "RUB",
  lines: [{ lineRef: "line-1", eligible: true, referralDiscountAmountKopecks: 501 }],
  totals: { merchantOfferAmountKopecks: 10001, referralDiscountAmountKopecks: 501, payableAmountKopecks: 9500 }, expiresAt: "2026-10-23T04:15:00Z",
});
const make = (request: typeof fetch) => new RefrefPaymentRail({ apiBaseUrl: "https://api.refref.test/v1-rc",
  vnextApiBaseUrl: "https://api.refref.test/v1-vnext", merchantId, apiKey: "synthetic", fetch: request });

describe("ART-379 authoritative vNext resolution", () => {
  it("sends the exact frozen body without token or buyer identity, preserving promised discount and deadline", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(resolved()));
    const quote = await make(request).resolve(input);
    expect(quote).toMatchObject({ state: "PRICE_REVIEW_REQUIRED", quote: { finalAmountKopecks: 9500, discountKopecks: 501,
      checkoutCodeOutcome: "NOT_APPLIED_ARRIVAL_PRIORITY", expiresAt: "2026-10-23T04:15:00Z" } });
    expect(String(request.mock.calls[0][0])).toBe("https://api.refref.test/v1-vnext/integrations/referral-resolutions");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual(input.request);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reads the committed resolution by order after a lost ACK; readback does not change TTL", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("lost ACK")).mockResolvedValueOnce(Response.json(resolved()));
    expect(await make(request).resolve(input)).toMatchObject({ quote: { expiresAt: resolved().expiresAt } });
    expect(String(request.mock.calls[1][0])).toContain("/by-order/order-1");
    expect(request.mock.calls[1][1]?.method).toBe("GET");
  });
  it.each(["merchantOrderRef", "storefrontOrigin", "browserContextId", "inputHash", "lines", "totals", "deliveryDegraded", "handoff"])("blocks payment on wrong %s", async field => {
    const bad: Record<string, unknown> = resolved();
    if (field === "lines") bad.lines = [...resolved().lines, ...resolved().lines];
    else if (field === "totals") bad.totals = { ...resolved().totals, payableAmountKopecks: 1 };
    else if (field === "deliveryDegraded") bad.deliveryDegraded = { degraded: false };
    else if (field === "handoff") bad.customerActionUrl = "https://checkout.refref.test/bounce";
    else bad[field] = "wrong";
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(bad));
    await expect(make(request).resolve(input)).rejects.toThrow("PAYMENT_CREATE_UNKNOWN");
    expect(request.mock.calls.every(([, options]) => !String(options?.body).includes("customerEmail"))).toBe(true);
  });
  it("leaves an unknown resolution pending when readback is unavailable, and refuses campaign split", async () => {
    const lost = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    await expect(make(lost).resolve(input)).rejects.toThrow("PAYMENT_CREATE_UNKNOWN");
    const refused = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: "MULTI_CAMPAIGN_CART_REQUIRES_SPLIT" } }, { status: 409 }));
    await expect(make(refused).resolve(input)).rejects.toThrow("REFREF_MULTI_CAMPAIGN_CART_REQUIRES_SPLIT");
    expect(refused).toHaveBeenCalledOnce();
  });
});
