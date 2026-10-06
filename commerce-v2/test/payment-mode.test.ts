import { describe, expect, it } from "vitest";
import { assertOfferSaleModeAllowed, assertPaymentCreationEnabled, CommerceConfigurationError, loadCommerceRuntimeConfig } from "../src/payment-mode";

describe("PAYMENT_MODE", () => {
  it("boots production disabled and refuses payment creation", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "disabled", KINESCOPE_DELIVERY_MODE: "open", MERCHANT_PROMOTION_PREFIX: "FX-" });
    expect(config.paymentMode).toBe("disabled");
    expect(() => assertPaymentCreationEnabled(config)).toThrow(new CommerceConfigurationError("PAYMENTS_DISABLED"));
    expect(() => assertOfferSaleModeAllowed(config, { kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "PUBLIC" }, true))
      .toThrow(new CommerceConfigurationError("PAYMENTS_DISABLED"));
  });

  it("refuses mock in production", () => {
    expect(() => loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "mock", MERCHANT_PROMOTION_PREFIX: "FX-" }))
      .toThrow(new CommerceConfigurationError("MOCK_FORBIDDEN_IN_PRODUCTION"));
  });

  it("requires protected Kinescope and complete Refref config", () => {
    expect(() => loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "refref", KINESCOPE_DELIVERY_MODE: "open", MERCHANT_PROMOTION_PREFIX: "FX-" }))
      .toThrow(new CommerceConfigurationError("REFREF_REQUIRES_PROTECTED_KINESCOPE"));
    expect(() => loadCommerceRuntimeConfig({ DEPLOY_ENV: "production", PAYMENT_MODE: "refref", KINESCOPE_DELIVERY_MODE: "protected", MERCHANT_PROMOTION_PREFIX: "FX-" }))
      .toThrow(/REFREF_CONFIG_MISSING/);
    const complete = {
      DEPLOY_ENV: "production", PAYMENT_MODE: "refref", KINESCOPE_DELIVERY_MODE: "protected",
      MERCHANT_PROMOTION_PREFIX: "FX-",
      REFREF_API_KEY: "key", REFREF_MERCHANT_SLUG: "flexperiment", REFREF_MERCHANT_ID: "00000000-0000-4000-8000-000000000001",
      REFREF_API_BASE_URL: "https://api.refref.ru/v1-rc",
      REFREF_CHECKOUT_ORIGIN: "https://checkout.refref.ru", REFREF_HANDOFF_STATE_SECRET: "secret",
    };
    expect(loadCommerceRuntimeConfig(complete).refref?.merchantSlug).toBe("flexperiment");
    // Receipt content is each offer's qualified fiscal policy (ART-233): the old global setting is refused, not ignored.
    expect(() => loadCommerceRuntimeConfig({ ...complete, REFREF_RECEIPT_PAYMENT_METHOD: "FULL_PREPAYMENT" }))
      .toThrow(new CommerceConfigurationError("REFREF_RECEIPT_PAYMENT_METHOD_RETIRED"));
  });

  it("requires audited activation only for public sale", () => {
    const config = loadCommerceRuntimeConfig({ DEPLOY_ENV: "test", PAYMENT_MODE: "mock" });
    expect(() => assertOfferSaleModeAllowed(config, { kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "ACCEPTANCE_ONLY" }, false)).not.toThrow();
    expect(() => assertOfferSaleModeAllowed(config, { kind: "ONLINE_COURSE", accessModel: "PAID", saleMode: "PUBLIC" }, false))
      .toThrow(new CommerceConfigurationError("SALES_ACTIVATION_REQUIRED"));
  });
});
