import { CLOSED_PAID_TEST_PROFILE, closedPaidTestEnabled } from "../../lib/closed-paid-test-profile";
import type { StorefrontSwitchSource } from "./storefront-switch";
export type PaymentMode = "disabled" | "mock" | "refref" | "native";
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
  readonly closedPaidTest?: { readonly id: typeof CLOSED_PAID_TEST_PROFILE; readonly buyerEmailSha256: string; readonly refrefSourceCommit: string;
    readonly legalManifestSha256: string; readonly legalVersion: string };
  readonly refref?: {
    readonly apiKey: string;
    readonly merchantSlug: string;
    readonly merchantId: string;
    readonly apiBaseUrl: string;
    readonly checkoutOrigin: string;
    readonly handoffStateSecret: string;
    /** Refref vNext surface (`/v1-vnext`, docs/openapi-vnext.yaml) for arrival claims and context close; served from the staged cutover. */
    readonly vnextApiBaseUrl?: string;
  };
  readonly native?:
    | { readonly provider: "fake"; readonly fiscalizationMode: "PROVIDER" | "MERCHANT" }
    | { readonly provider: "tochka"; readonly fiscalizationMode: "PROVIDER"; readonly fixtureOrigin: string };
  readonly nativeCoursesLegal?: { readonly version: string; readonly sha256: string };
  readonly historicalRefref?: Pick<NonNullable<CommerceRuntimeConfig["refref"]>, "apiBaseUrl" | "apiKey" | "merchantId">;
  /**
   * The owner's storefront switch (storefront-switch.ts). The server attaches the read-only host file;
   * it is never loaded from env, and without one every storefront is CLOSED.
   */
  readonly storefrontSwitch?: StorefrontSwitchSource;
};

type Environment = Readonly<Record<string, string | undefined>>;

const required = (env: Environment, name: string) => {
  const value = env[name]?.trim();
  if (!value) throw new CommerceConfigurationError(`REFREF_CONFIG_MISSING:${name}`);
  return value;
};

function loadRefrefExecutor(env: Environment) {
  const apiBaseUrl = required(env, "REFREF_API_BASE_URL");
  try { new URL(apiBaseUrl); } catch { throw new CommerceConfigurationError("REFREF_API_BASE_URL_INVALID"); }
  const merchantId = required(env, "REFREF_MERCHANT_ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(merchantId)) {
    throw new CommerceConfigurationError("REFREF_MERCHANT_ID_INVALID");
  }
  return { apiBaseUrl, apiKey: required(env, "REFREF_API_KEY"), merchantId };
}

export function tochkaFixtureOrigin(value: string | undefined) {
  // The unresolved contract and fiscal read-back keep this profile loopback-only.
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)) {
    throw new CommerceConfigurationError("NATIVE_TOCHKA_FIXTURE_ORIGIN_REQUIRED");
  }
  try { return new URL(value).origin; } catch { throw new CommerceConfigurationError("NATIVE_TOCHKA_FIXTURE_ORIGIN_REQUIRED"); }
}

function loadNativeProfile(env: Environment, provider: string | undefined, environment: CommerceRuntimeConfig["deployEnvironment"]):
  NonNullable<CommerceRuntimeConfig["native"]> {
  if (provider === "tochka") {
    if (environment !== "local" && environment !== "test") throw new CommerceConfigurationError("NATIVE_TOCHKA_PROFILE_UNQUALIFIED");
    if (env.NATIVE_FISCALIZATION_MODE && env.NATIVE_FISCALIZATION_MODE !== "PROVIDER") throw new CommerceConfigurationError("NATIVE_TOCHKA_REQUIRES_PROVIDER_RECEIPTS");
    return { provider, fiscalizationMode: "PROVIDER", fixtureOrigin: tochkaFixtureOrigin(env.NATIVE_TOCHKA_FIXTURE_ORIGIN) };
  }
  if (provider !== "fake") throw new CommerceConfigurationError("NATIVE_PROVIDER_INVALID");
  if (environment !== "local" && environment !== "test") throw new CommerceConfigurationError("NATIVE_FAKE_PROVIDER_FORBIDDEN");
  const fiscalizationMode = env.NATIVE_FISCALIZATION_MODE?.trim() || "MERCHANT";
  if (fiscalizationMode !== "PROVIDER" && fiscalizationMode !== "MERCHANT") throw new CommerceConfigurationError("NATIVE_FISCALIZATION_MODE_INVALID");
  return { provider, fiscalizationMode };
}

export function nativePurchaseAllowed(config: Pick<CommerceRuntimeConfig, "paymentMode" | "native">, kind: string) {
  return config.paymentMode !== "native" || config.native?.provider !== "tochka" || kind === "ONLINE_COURSE";
}

export function loadCommerceRuntimeConfig(env: Environment = process.env): CommerceRuntimeConfig {
  const deployEnvironment = (env.DEPLOY_ENV ?? (env.NODE_ENV === "test" ? "test" : "local")) as CommerceRuntimeConfig["deployEnvironment"];
  if (!["local", "test", "staging", "production"].includes(deployEnvironment)) {
    throw new CommerceConfigurationError("DEPLOY_ENV_INVALID");
  }
  const paymentMode = (env.PAYMENT_MODE ?? (deployEnvironment === "production" ? "disabled" : "mock")) as PaymentMode;
  if (!["disabled", "mock", "refref", "native"].includes(paymentMode)) throw new CommerceConfigurationError("PAYMENT_MODE_INVALID");
  const paidTest = closedPaidTestEnabled(env);
  const canary = env.COMMERCE_V2_ENVIRONMENT === "canary" || env.ERASURE_SCOPE === "canary"
    || env.PLATFORM_ORIGIN === "https://canary-platform.flexperiment.ru";
  if (canary && paymentMode === "refref" && !paidTest) throw new CommerceConfigurationError("CLOSED_PAID_TEST_PROFILE_REQUIRED");
  if (paidTest && (!/^[a-f0-9]{64}$/.test(env.CLOSED_PAID_TEST_BUYER_SHA256 ?? "")
    || env.COMMERCE_V2_ENVIRONMENT !== "canary" || env.ERASURE_SCOPE !== "canary" || env.ERASURE_FENCING_ENABLED !== "true")) {
    throw new CommerceConfigurationError("CLOSED_PAID_TEST_CONFIG_INVALID");
  }
  if (deployEnvironment === "production" && paymentMode === "mock") throw new CommerceConfigurationError("MOCK_FORBIDDEN_IN_PRODUCTION");

  const kinescopeDeliveryMode = (env.KINESCOPE_DELIVERY_MODE ?? "open") as KinescopeDeliveryMode;
  if (!["open", "protected"].includes(kinescopeDeliveryMode)) throw new CommerceConfigurationError("KINESCOPE_DELIVERY_MODE_INVALID");

  const merchantPromotionPrefix = env.MERCHANT_PROMOTION_PREFIX?.trim().toUpperCase()
    ?? (deployEnvironment === "production" ? "" : "FX-");
  if (!/^[A-Z0-9]{2,16}-$/.test(merchantPromotionPrefix)) {
    throw new CommerceConfigurationError("MERCHANT_PROMOTION_PREFIX_INVALID");
  }

  if (paymentMode === "native") {
    // The Refref executor is optional and can only service existing RC.2 records.
    if (kinescopeDeliveryMode !== "protected") throw new CommerceConfigurationError("NATIVE_REQUIRES_PROTECTED_KINESCOPE");
    const provider = env.NATIVE_PROVIDER?.trim();
    const native = loadNativeProfile(env, provider, deployEnvironment);
    const historicalRefref = [env.REFREF_API_BASE_URL, env.REFREF_API_KEY, env.REFREF_MERCHANT_ID].some(value => value !== undefined)
      ? loadRefrefExecutor(env) : undefined;
    const version = env.NATIVE_COURSES_LEGAL_VERSION?.trim();
    const sha256 = env.NATIVE_COURSES_LEGAL_SHA256?.trim();
    if ((version || sha256) && (!version || !sha256 || !/^[a-f0-9]{64}$/.test(sha256))) {
      throw new CommerceConfigurationError("NATIVE_COURSES_LEGAL_CONFIG_INVALID");
    }
    return { deployEnvironment, paymentMode, kinescopeDeliveryMode, merchantPromotionPrefix, native,
      ...(historicalRefref ? { historicalRefref } : {}), ...(version && sha256 ? { nativeCoursesLegal: { version, sha256 } } : {}) };
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
  // Retired (ART-233): a receipt's payment method is its offer's qualified fiscal policy. A value still
  // set here would be believed and ignored, so the runtime refuses to start instead.
  if (env.REFREF_RECEIPT_PAYMENT_METHOD !== undefined) throw new CommerceConfigurationError("REFREF_RECEIPT_PAYMENT_METHOD_RETIRED");
  const vnextApiBaseUrl = env.REFREF_VNEXT_API_BASE_URL?.trim() || undefined;
  if (vnextApiBaseUrl) {
    try { new URL(vnextApiBaseUrl); } catch { throw new CommerceConfigurationError("REFREF_VNEXT_API_BASE_URL_INVALID"); }
  }
  return {
    deployEnvironment,
    paymentMode,
    kinescopeDeliveryMode,
    merchantPromotionPrefix,
    ...(paidTest ? { closedPaidTest: { id: CLOSED_PAID_TEST_PROFILE, buyerEmailSha256: env.CLOSED_PAID_TEST_BUYER_SHA256!,
      refrefSourceCommit: env.CLOSED_PAID_TEST_REFREF_SOURCE!, legalManifestSha256: env.CLOSED_PAID_TEST_LEGAL_SHA256!,
      legalVersion: env.CLOSED_PAID_TEST_LEGAL_VERSION! } } : {}),
    refref: {
      apiKey: required(env, "REFREF_API_KEY"),
      merchantSlug: required(env, "REFREF_MERCHANT_SLUG"),
      merchantId,
      apiBaseUrl,
      checkoutOrigin,
      handoffStateSecret: required(env, "REFREF_HANDOFF_STATE_SECRET"),
      ...(vnextApiBaseUrl ? { vnextApiBaseUrl } : {}),
    },
  };
}

export type SaleModePolicyConfig = Pick<CommerceRuntimeConfig, "deployEnvironment" | "paymentMode" | "closedPaidTest" | "storefrontSwitch">;

export function assertOfferSaleModeAllowed(
  config: SaleModePolicyConfig,
  offer: { readonly kind: "ONLINE_COURSE" | "COURSE_BUNDLE" | "LAB"; readonly accessModel: "FREE" | "PAID"; readonly saleMode: SaleMode },
) {
  if (offer.saleMode === "CLOSED") return;
  if (config.closedPaidTest && (offer.kind !== "ONLINE_COURSE"
    || (offer.accessModel === "PAID" && offer.saleMode !== "ACCEPTANCE_ONLY"))) throw new CommerceConfigurationError("CLOSED_PAID_TEST_SCOPE_REFUSED");
  if (config.paymentMode === "disabled" && (offer.accessModel === "PAID" || offer.kind === "LAB")) {
    throw new CommerceConfigurationError("PAYMENTS_DISABLED");
  }
  if (config.paymentMode === "mock" && config.deployEnvironment === "production") {
    throw new CommerceConfigurationError("MOCK_FORBIDDEN_IN_PRODUCTION");
  }
  // No acceptance qualifies the all-courses bundle yet (ART-240 qualifies one course): an open COURSES
  // switch never makes it PUBLIC (the fence of migration 0016, kept after sales_activation).
  if (offer.saleMode === "PUBLIC" && offer.kind === "COURSE_BUNDLE") throw new CommerceConfigurationError("COURSE_BUNDLE_NOT_QUALIFIED");
  if (offer.saleMode === "ACCEPTANCE_ONLY" && config.paymentMode !== "refref" && config.paymentMode !== "native" && config.deployEnvironment === "production") {
    throw new CommerceConfigurationError("ACCEPTANCE_OFFER_REQUIRES_REFREF");
  }
}

export function assertPaymentCreationEnabled(config: CommerceRuntimeConfig) {
  if (config.paymentMode === "disabled") throw new CommerceConfigurationError("PAYMENTS_DISABLED");
}
