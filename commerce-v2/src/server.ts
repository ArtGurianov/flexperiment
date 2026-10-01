import { serve } from "@hono/node-server";
import { createCommerceV2App } from "./app";
import { migrateV2, openV2Database } from "./db";
import { loadCommerceRuntimeConfig } from "./payment-mode";
import { createAuthRuntime } from "./auth";
import { verifySmartCaptcha } from "./smartcaptcha";
import { HttpKinescopeClient } from "./kinescope";
import { MockPaymentRail, reconcilePendingCheckouts } from "./checkout";
import { RefrefPaymentRail } from "./refref-payment-rail";
import { readBuildIdentity } from "./build-identity";
import { reconcilePendingRefunds } from "./refunds";

const config = loadCommerceRuntimeConfig();
const db = openV2Database();
migrateV2(db);
const buildIdentity = readBuildIdentity("commerce-v2");
if (buildIdentity.sourceCommit === "development" && config.deployEnvironment === "production") throw new Error("SOURCE_COMMIT_REQUIRED");

const serviceToken = process.env.PLATFORM_SERVICE_TOKEN;
if (!serviceToken && config.deployEnvironment === "production") throw new Error("PLATFORM_SERVICE_TOKEN_REQUIRED");
const emailDeliveryEndpoint = process.env.AUTH_EMAIL_DELIVERY_ENDPOINT;
if (!emailDeliveryEndpoint && config.deployEnvironment === "production") throw new Error("AUTH_EMAIL_DELIVERY_ENDPOINT_REQUIRED");
const campaignUnsubscribeSecret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
if (!campaignUnsubscribeSecret && config.deployEnvironment === "production") throw new Error("CAMPAIGN_UNSUBSCRIBE_SECRET_REQUIRED");
const controlRoomSessionSecret = process.env.COMMERCE_SESSION_SECRET;
const controlRoomPasswordScrypt = process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
const controlRoomOrigin = process.env.COMMERCE_ADMIN_ORIGIN;
if (config.deployEnvironment === "production" && (!controlRoomSessionSecret || !controlRoomPasswordScrypt || !controlRoomOrigin)) {
  throw new Error("CONTROL_ROOM_AUTH_CONFIGURATION_REQUIRED");
}

const auth = createAuthRuntime({
  db,
  sendMagicLinkEmail: async ({ email, url }) => {
    const endpoint = emailDeliveryEndpoint;
    if (!endpoint) throw new Error("AUTH_EMAIL_DELIVERY_NOT_CONFIGURED");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.AUTH_EMAIL_DELIVERY_TOKEN ? { authorization: `Bearer ${process.env.AUTH_EMAIL_DELIVERY_TOKEN}` } : {}),
      },
      body: JSON.stringify({ type: "MAGIC_LINK", recipientEmail: email, url }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`AUTH_EMAIL_DELIVERY_HTTP_${response.status}`);
  },
});
const smartCaptchaSecret = process.env.SMARTCAPTCHA_SERVER_KEY;
if (!smartCaptchaSecret && config.deployEnvironment === "production") throw new Error("SMARTCAPTCHA_SERVER_KEY_REQUIRED");

const kinescopeToken = process.env.KINESCOPE_API_TOKEN;
const kinescopeClient = kinescopeToken ? new HttpKinescopeClient(kinescopeToken) : undefined;
const kinescopeDrmTokenSecret = process.env.KINESCOPE_DRM_TOKEN_SECRET;
const kinescopeDrmUsername = process.env.KINESCOPE_DRM_USERNAME;
const kinescopeDrmPassword = process.env.KINESCOPE_DRM_PASSWORD;
if (config.kinescopeDeliveryMode === "protected" && (
  !kinescopeDrmTokenSecret || Buffer.byteLength(kinescopeDrmTokenSecret) < 32 || !kinescopeDrmUsername || !kinescopeDrmPassword
)) throw new Error("KINESCOPE_DRM_CONFIGURATION_REQUIRED");
const kinescopeDrmAuth = kinescopeDrmTokenSecret && kinescopeDrmUsername && kinescopeDrmPassword ? {
  tokenSecret: kinescopeDrmTokenSecret,
  username: kinescopeDrmUsername,
  password: kinescopeDrmPassword,
} : undefined;
const paymentRail = config.paymentMode === "mock" ? new MockPaymentRail()
  : config.paymentMode === "refref" && config.refref ? new RefrefPaymentRail({
    apiBaseUrl: config.refref.apiBaseUrl,
    apiKey: config.refref.apiKey,
    merchantId: config.refref.merchantId,
    successUrl: config.refref.returnUrl,
    paymentMethod: config.refref.receiptPaymentMethod,
  }) : undefined;

const app = createCommerceV2App({
  db,
  config,
  sourceCommit: buildIdentity.sourceCommit,
  serviceToken: serviceToken ?? "development-platform-token",
  authHandler: auth.auth.handler,
  prepareMagicLinkInitiation: auth.prepareMagicLinkInitiation,
  authenticateCustomer: auth.authenticateCustomer,
  verifyCaptcha: smartCaptchaSecret ? (token, ip) => verifySmartCaptcha(token, ip, smartCaptchaSecret) : undefined,
  kinescopeClient,
  kinescopeLessonsFolderId: process.env.KINESCOPE_LESSONS_FOLDER_ID,
  kinescopeWebhookCredentials: process.env.KINESCOPE_WEBHOOK_USERNAME && process.env.KINESCOPE_WEBHOOK_PASSWORD ? {
    username: process.env.KINESCOPE_WEBHOOK_USERNAME,
    password: process.env.KINESCOPE_WEBHOOK_PASSWORD,
  } : undefined,
  kinescopeDrmAuth,
  runtimeCapabilities: {
    authEmailConfigured: Boolean(emailDeliveryEndpoint),
    captchaConfigured: Boolean(smartCaptchaSecret),
    kinescopeApiConfigured: Boolean(kinescopeClient),
  },
  paymentRail,
  invalidatePlatformCache: async (mode, courseRef) => {
    const origin = process.env.NEXT_PUBLIC_SERVER_URL;
    const token = process.env.PLATFORM_REVALIDATE_TOKEN ?? serviceToken;
    if (!origin || !token) {
      if (config.deployEnvironment === "production") throw new Error("PLATFORM_REVALIDATION_CONFIGURATION_REQUIRED");
      return;
    }
    const response = await fetch(new URL("/internal/revalidate", origin), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ mode, courseRef }), signal: AbortSignal.timeout(3_000), cache: "no-store",
    });
    if (!response.ok) throw new Error(`PLATFORM_REVALIDATION_HTTP_${response.status}`);
  },
  campaignUnsubscribeSecret,
  publicOrigin: process.env.NEXT_PUBLIC_SERVER_URL ?? process.env.PUBLIC_COMMERCE_ORIGIN,
  sendCampaignEmail: emailDeliveryEndpoint ? async (message) => {
    const response = await fetch(emailDeliveryEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.AUTH_EMAIL_DELIVERY_TOKEN ? { authorization: `Bearer ${process.env.AUTH_EMAIL_DELIVERY_TOKEN}` } : {}),
      },
      body: JSON.stringify({ type: "CAMPAIGN", ...message }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`CAMPAIGN_EMAIL_HTTP_${response.status}`);
  } : undefined,
  controlRoomAuth: controlRoomSessionSecret && controlRoomPasswordScrypt && controlRoomOrigin ? {
    sessionSecret: controlRoomSessionSecret,
    passwordScrypt: controlRoomPasswordScrypt,
    origin: controlRoomOrigin,
  } : undefined,
});

if (paymentRail) {
  let checkoutPollRunning = false;
  const checkoutPoll = async () => {
    if (checkoutPollRunning) return;
    checkoutPollRunning = true;
    try {
      await reconcilePendingCheckouts(db, paymentRail);
      await reconcilePendingRefunds(db, paymentRail);
    }
    catch (error) { console.error("checkout reconciliation sweep failed", error); }
    finally { checkoutPollRunning = false; }
  };
  const checkoutPollTimer = setInterval(() => { void checkoutPoll(); }, Number(process.env.CHECKOUT_POLL_INTERVAL_MS ?? 30_000));
  checkoutPollTimer.unref();
  void checkoutPoll();
}

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3002) });
