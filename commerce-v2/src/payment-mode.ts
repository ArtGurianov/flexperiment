export type PaymentMode = "disabled" | "mock" | "refref";
export type KinescopeDeliveryMode = "open" | "protected";
export type SaleMode = "CLOSED" | "ACCEPTANCE_ONLY" | "PUBLIC";

export class CommerceConfigurationError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type CommerceRuntimeConfig = {
  readonly deployEnvironment: "local" | "test" | "staging" | "production";
  readonly paymentMode: PaymentMode;
  readonly kinescopeDeliveryMode: KinescopeDeliveryMode;
  readonly merchantPromotionPrefix: string;
  readonly refref?: {
    readonly apiKey: string;
    readonly merchantSlug: string;
    readonly merchantId: string;
    readonly apiBaseUrl: string;
    readonly checkoutOrigin: string;
    readonly receiptPaymentMethod: string;
    readonly handoffStateSecret: string;
  };
};

type Environment = Readonly<Record<string, string | undefined>>;

const required = (env: Environment, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new CommerceConfigurationError(`REFREF_CONFIG_MISSING:${name}`);
  return value;
};

export function loadCommerceRuntimeConfig(env: Environment = process.env): CommerceRuntimeConfig {
  const deployEnvironment = (env.DEPLOY_ENV ?? (env.NODE_ENV === "test" ? "test" : "local")) as CommerceRuntimeConfig["deployEnvironment"];
  if (!["local", "test", "staging", "production"].includes(deployEnvironment)) {
    throw new CommerceConfigurationError("DEPLOY_ENV_INVALID");
  }
  const paymentMode = (env.PAYMENT_MODE ?? (deployEnvironment === "production" ? "disabled" : "mock")) as PaymentMode;
  if (!["disabled", "mock", "refref"].includes(paymentMode)) throw new CommerceConfigurationError("PAYMENT_MODE_INVALID");
  if (deployEnvironment === "production" && paymentMode === "mock") throw new CommerceConfigurationError("MOCK_FORBIDDEN_IN_PRODUCTION");

  const kinescopeDeliveryMode = (env.KINESCOPE_DELIVERY_MODE ?? "open") as KinescopeDeliveryMode;
  if (!["open", "protected"].includes(kinescopeDeliveryMode)) throw new CommerceConfigurationError("KINESCOPE_DELIVERY_MODE_INVALID");

  const merchantPromotionPrefix = env.MERCHANT_PROMOTION_PREFIX?.trim().toUpperCase()
    ?? (deployEnvironment === "production" ? "" : "FX-");
  if (!/^[A-Z0-9]{2,16}-$/.test(merchantPromotionPrefix)) {
    throw new CommerceConfigurationError("MERCHANT_PROMOTION_PREFIX_INVALID");
  }

  if (paymentMode !== "refref") return { deployEnvironment, paymentMode, kinescopeDeliveryMode, merchantPromotionPrefix };
  if (kinescopeDeliveryMode !== "protected") throw new CommerceConfigurationError("REFREF_REQUIRES_PROTECTED_KINESCOPE");
  const apiBaseUrl = required(env, "REFREF_API_BASE_URL");
  try { new URL(apiBaseUrl); } catch { throw new CommerceConfigurationError("REFREF_API_BASE_URL_INVALID"); }
  const checkoutOrigin = required(env, "REFREF_CHECKOUT_ORIGIN");
  try { new URL(checkoutOrigin); } catch { throw new CommerceConfigurationError("REFREF_CHECKOUT_ORIGIN_INVALID"); }
  const merchantId = required(env, "REFREF_MERCHANT_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(merchantId)) {
    throw new CommerceConfigurationError("REFREF_MERCHANT_ID_INVALID");
  }
  return {
    deployEnvironment,
    paymentMode,
    kinescopeDeliveryMode,
    merchantPromotionPrefix,
    refref: {
      apiKey: required(env, "REFREF_API_KEY"),
      merchantSlug: required(env, "REFREF_MERCHANT_SLUG"),
      merchantId,
      apiBaseUrl,
      checkoutOrigin,
      receiptPaymentMethod: required(env, "REFREF_RECEIPT_PAYMENT_METHOD"),
      handoffStateSecret: required(env, "REFREF_HANDOFF_STATE_SECRET"),
    },
  };
}

export type SaleModePolicyConfig = Pick<CommerceRuntimeConfig, "deployEnvironment" | "paymentMode">;

export function assertOfferSaleModeAllowed(
  config: SaleModePolicyConfig,
  offer: { readonly kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB"; readonly accessModel: "FREE" | "PAID"; readonly saleMode: SaleMode },
  activationExists: boolean,
) {
  if (offer.saleMode === "CLOSED") return;
  if (config.paymentMode === "disabled" && (offer.accessModel === "PAID" || offer.kind === "LAB")) {
    throw new CommerceConfigurationError("PAYMENTS_DISABLED");
  }
  if (config.paymentMode === "mock" && config.deployEnvironment === "production") {
    throw new CommerceConfigurationError("MOCK_FORBIDDEN_IN_PRODUCTION");
  }
  if (offer.saleMode === "PUBLIC" && !activationExists) throw new CommerceConfigurationError("SALES_ACTIVATION_REQUIRED");
  if (offer.saleMode === "ACCEPTANCE_ONLY" && config.paymentMode !== "refref" && config.deployEnvironment === "production") {
    throw new CommerceConfigurationError("ACCEPTANCE_OFFER_REQUIRES_REFREF");
  }
}

export function assertPaymentCreationEnabled(config: CommerceRuntimeConfig) {
  if (config.paymentMode === "disabled") throw new CommerceConfigurationError("PAYMENTS_DISABLED");
}
