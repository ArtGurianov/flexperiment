import { serve } from "@hono/node-server";
import { labTicketQrSecretFromEnv } from "./lab-tickets";
import { createCommerceV2App } from "./app";
import { migrateV2, openV2Database } from "./db";
import { loadCommerceRuntimeConfig } from "./payment-mode";
import { createAuthRuntime } from "./auth";
import { loadMyIdentityConfig } from "./my-session";
import { createMyOtp, myAccountLegalStorefront } from "./my-session-otp";
import { createSessionExchange } from "./session-exchange";
import { verifySmartCaptcha } from "./smartcaptcha";
import { playbackKeyringFromEnvironment } from "./playback-auth";
import { HttpKinescopeClient } from "./kinescope";
import { MockPaymentRail, reconcilePendingCheckouts } from "./checkout";
import { RefrefPaymentRail } from "./refref-payment-rail";
import { readBuildIdentity } from "./build-identity";
import { createRefrefReadinessProbe } from "./readiness";
import { hostStorefrontSwitchSource } from "./storefront-switch";
import { refundEnvelopeKeyringFromEnvironment } from "./refund-envelope";
import { reconcilePendingRefunds } from "./refunds";
import { loadCommerceOrigins } from "./origins";
import { labGuestTrustedProxyIps } from "./lab-guest-client-ip";
import { controlRoomTrustedProxyIps } from "./control-room-client-ip";
import { controlRoomTotpKey } from "./control-room-totp";
import { dispatchPendingCampaigns, type CampaignEmail } from "./campaigns";
import { createLabTicketEmailDelivery, createMagicLinkEmailDelivery, createMyOtpEmailDelivery } from "./auth-email-delivery";
import { dirname } from "node:path";
import { prepareErasureRuntime } from "./erasure-runtime";
import { ErasureInstallationEvidence, readErasureInstallation } from "./erasure-installation";
import { AfterResponseTasks } from "./after-response";
import { BrowserContexts, loadBrowserContextConfig } from "./browser-context";
import { RefrefArrivalExchange } from "./refref-arrival-exchange";
import { contourOfOrder } from "./native-payment-ledger";
import { nativePaymentsFromConfig, startNativeSweeps } from "./native-payment-runtime";

async function startServer() {
const installation=readErasureInstallation(process.env);
ErasureInstallationEvidence.assertRuntime(installation,process.env);
// The owner's storefront switch is attached here only, from the fixed read-only host mount (ART-319).
const config = { ...loadCommerceRuntimeConfig(), storefrontSwitch: hostStorefrontSwitchSource() };
// Preserve the configured foundation dependency when switching to normal mode.
// Native sales do not depend on the historical provider's availability.
const probeRefref = config.paymentMode !== "native"
  && (process.env.REFREF_READINESS_URL || config.deployEnvironment === "production" || config.paymentMode === "refref")
  ? createRefrefReadinessProbe(process.env) : undefined;
const origins = loadCommerceOrigins();
const db = openV2Database();
migrateV2(db);
// Before traffic, auth construction or timers. Installation is separately admitted;
// an enabled but unqualified authority/control DB fails closed, without fallback.
const erasureFence=await prepareErasureRuntime({db,environment:process.env,
  forbiddenRoots:[dirname(db.name)],installation,diagnostics:event=>console.error(JSON.stringify({...event,observedAt:new Date().toISOString()}))});
const buildIdentity = readBuildIdentity("commerce-v2");
if (buildIdentity.sourceCommit === "development" && config.deployEnvironment === "production") throw new Error("SOURCE_COMMIT_REQUIRED");

const serviceToken = process.env.PLATFORM_SERVICE_TOKEN;
if (!serviceToken && config.deployEnvironment === "production") throw new Error("PLATFORM_SERVICE_TOKEN_REQUIRED");
const emailDeliveryEndpoint = process.env.AUTH_EMAIL_DELIVERY_ENDPOINT;
const magicLinkDelivery = createMagicLinkEmailDelivery();
const labTicketDelivery = createLabTicketEmailDelivery();
const campaignUnsubscribeSecret = process.env.CAMPAIGN_UNSUBSCRIBE_SECRET;
if (!campaignUnsubscribeSecret && config.deployEnvironment === "production") throw new Error("CAMPAIGN_UNSUBSCRIBE_SECRET_REQUIRED");
const marketingBroadcastsEnabled = process.env.MARKETING_BROADCASTS_ENABLED === "true";
if (marketingBroadcastsEnabled && (!campaignUnsubscribeSecret || !emailDeliveryEndpoint)) {
  throw new Error("CAMPAIGN_DELIVERY_CONFIGURATION_REQUIRED");
}
const controlRoomSessionSecret = process.env.COMMERCE_SESSION_SECRET;
const controlRoomPasswordScrypt = process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
const controlRoomOrigin = origins.admin;
const controlRoomTotp = controlRoomTotpKey(process.env.CONTROL_ROOM_TOTP_KEY);
if (config.deployEnvironment === "production" && (!controlRoomSessionSecret || !controlRoomPasswordScrypt || !controlRoomOrigin || !controlRoomTotp)) {
  throw new Error("CONTROL_ROOM_AUTH_CONFIGURATION_REQUIRED");
}

// FLEX-120/121 (B block): MY identity. MY_IDENTITY_MODE defaults to `off` (Stage A unchanged).
const myIdentity = loadMyIdentityConfig(process.env, origins);
const myOtpDelivery = createMyOtpEmailDelivery();
const auth = createAuthRuntime({
  db,
  sendMagicLinkEmail: magicLinkDelivery.send,
  sendMyOtpEmail: myOtpDelivery.send,
  myIdentity,
  erasureFence,
});
const smartCaptchaSecret = process.env.SMARTCAPTCHA_SERVER_KEY;
if (!smartCaptchaSecret && config.deployEnvironment === "production") throw new Error("SMARTCAPTCHA_SERVER_KEY_REQUIRED");

const kinescopeToken = process.env.KINESCOPE_API_TOKEN;
const kinescopeClient = kinescopeToken ? new HttpKinescopeClient(kinescopeToken) : undefined;
// The signing keyring (ART-221): an invalid or ambiguous one refuses to start whatever the mode.
const kinescopeDrmKeyring = playbackKeyringFromEnvironment(process.env);
const kinescopeDrmUsername = process.env.KINESCOPE_DRM_USERNAME;
const kinescopeDrmPassword = process.env.KINESCOPE_DRM_PASSWORD;
if (config.kinescopeDeliveryMode === "protected" && (!kinescopeDrmKeyring || !kinescopeDrmUsername || !kinescopeDrmPassword)) {
  throw new Error("KINESCOPE_DRM_CONFIGURATION_REQUIRED");
}
const kinescopeDrmAuth = kinescopeDrmKeyring && kinescopeDrmUsername && kinescopeDrmPassword ? {
  keyring: kinescopeDrmKeyring,
  username: kinescopeDrmUsername,
  password: kinescopeDrmPassword,
} : undefined;
// The refund envelope keyring (ART-174): Refref's rail does not start without one, and an invalid one never starts.
const refundEnvelopeKeys = refundEnvelopeKeyringFromEnvironment(process.env);
if (config.paymentMode === "refref" && !refundEnvelopeKeys) throw new Error("REFUND_ENVELOPE_KEYS_REQUIRED");
// FLEX-119 · the direct native contour (PAYMENT_MODE=native): quote rail, ledger context and sweeps.
// payment-mode.ts already refused the fake provider outside local/test.
const native = nativePaymentsFromConfig(db, config, refundEnvelopeKeys);
const historicalPaymentRail = config.historicalRefref ? new RefrefPaymentRail(config.historicalRefref) : undefined;
const paymentRail = native ? native.quoteRail : config.paymentMode === "mock" ? new MockPaymentRail()
  : config.paymentMode === "refref" && config.refref ? new RefrefPaymentRail({
    apiBaseUrl: config.refref.apiBaseUrl,
    apiKey: config.refref.apiKey,
    merchantId: config.refref.merchantId,
  }) : undefined;

// ART-378: arrival endpoints and browser contexts. Off unless BROWSER_CONTEXT_ENABLED=true; the
// claim/close client exists only where the Refref vNext surface is configured.
const diagnostic = (event: string, code?: string) => {
  try { console.error(JSON.stringify({ event, ...(code ? { code } : {}) })); } catch { /* never fail the caller */ }
};
const afterResponse = new AfterResponseTasks(() => diagnostic("AFTER_RESPONSE_TASK_FAILED"));
const browserContextConfig = loadBrowserContextConfig();
const browserContexts = browserContextConfig ? new BrowserContexts({
  db, origins, config: browserContextConfig, now: () => new Date(),
  exchange: config.refref?.vnextApiBaseUrl
    ? new RefrefArrivalExchange({ apiBaseUrl: config.refref.vnextApiBaseUrl, apiKey: config.refref.apiKey }) : undefined,
  schedule: (task) => afterResponse.schedule(erasureFence ? () => erasureFence.run("WORKER", task) : task),
  alert: (code) => diagnostic("BROWSER_CONTEXT_ALERT", code),
}) : undefined;

const campaignTransport = emailDeliveryEndpoint ? async (message: CampaignEmail) => {
  const response = await fetch(emailDeliveryEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": message.idempotencyKey,
      ...(process.env.AUTH_EMAIL_DELIVERY_TOKEN ? { authorization: `Bearer ${process.env.AUTH_EMAIL_DELIVERY_TOKEN}` } : {}),
    },
    body: JSON.stringify({ type: "CAMPAIGN", ...message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`CAMPAIGN_EMAIL_HTTP_${response.status}`);
} : undefined;
const sendCampaignEmail=campaignTransport ? async(message:CampaignEmail)=>{
  if(erasureFence) await erasureFence.send(message.recipient,()=>campaignTransport(message),"MARKETING");
  else await campaignTransport(message);
}:undefined;

const app = createCommerceV2App({
  db,
  config,
  sourceCommit: buildIdentity.sourceCommit,
  serviceToken: serviceToken ?? "development-platform-token",
  probeRefref,
  authHandler: auth.auth.handler,
  prepareMagicLinkInitiation: auth.prepareMagicLinkInitiation,
  authenticateCustomer: auth.authenticateCustomer,
  myIdentity,
  myOtp: createMyOtp({ db, api: auth.auth.api, erasureFence,
    accountLegalStorefront: myAccountLegalStorefront(process.env.MY_ACCOUNT_LEGAL_STOREFRONT),
    verifyCaptcha: smartCaptchaSecret ? (token, ip) => verifySmartCaptcha(token, ip, smartCaptchaSecret) : undefined }),
  resolveSession: auth.resolveSession,
  signOutMySession: (headers) => auth.auth.api.signOut({ headers, asResponse: true }),
  sessionExchange: createSessionExchange({ db }),

  // FLEX-60/123: owned LAB ticket QR; absent or short LAB_TICKET_QR_SECRET keeps the route closed.
  labTicketQrSecret: labTicketQrSecretFromEnv(process.env),
  myOrigin: origins.my,
  resolveSessionAudience: async (headers) => {
    const session = await auth.resolveSession(headers);
    if (!session || (session.kind === "MY" && session.surface !== "MY")) return null;
    return { customerId: session.customerId, audience: session.kind };
  },
  verifyCaptcha: smartCaptchaSecret ? (token, ip) => verifySmartCaptcha(token, ip, smartCaptchaSecret) : undefined,
  kinescopeClient,
  kinescopeLessonsFolderId: process.env.KINESCOPE_LESSONS_FOLDER_ID,
  kinescopeWebhookCredentials: process.env.KINESCOPE_WEBHOOK_USERNAME && process.env.KINESCOPE_WEBHOOK_PASSWORD ? {
    username: process.env.KINESCOPE_WEBHOOK_USERNAME,
    password: process.env.KINESCOPE_WEBHOOK_PASSWORD,
  } : undefined,
  kinescopeDrmAuth,
  runtimeCapabilities: {
    authEmailConfigured: magicLinkDelivery.configured,
    captchaConfigured: Boolean(smartCaptchaSecret),
    kinescopeApiConfigured: Boolean(kinescopeClient),
  },
  paymentRail,
  historicalPaymentRail,
  refundEnvelopeKeys,
  campaignUnsubscribeSecret,
  marketingBroadcastsEnabled,
  origins,
  sendCampaignEmail,
  labGuestTrustedProxyIps: labGuestTrustedProxyIps(process.env.LAB_GUEST_TRUSTED_PROXY_IPS),
  sendLabTicketEmail: labTicketDelivery.configured ? async message => {
    if (erasureFence) await erasureFence.send(message.email, () => labTicketDelivery.send(message), "AUTH_MAIL");
    else await labTicketDelivery.send(message);
  } : undefined,
  controlRoomAuth: controlRoomSessionSecret && controlRoomPasswordScrypt && controlRoomOrigin ? {
    sessionSecret: controlRoomSessionSecret,
    passwordScrypt: controlRoomPasswordScrypt,
    origin: controlRoomOrigin,
    trustedProxyIps: controlRoomTrustedProxyIps(process.env.CONTROL_ROOM_TRUSTED_PROXY_IPS),
    totpKey: controlRoomTotp,
  } : undefined,
  erasureFence,
  browserContexts,
  nativePayments: native?.ledger,
  labRouteContour: ({ orderPublicId }) => contourOfOrder(db, orderPublicId),
  labRailContour: config.paymentMode === "refref" ? "REFREF_RC2" : undefined,
});
if (native) startNativeSweeps(db, native, {
  intervalMs: Number(process.env.CHECKOUT_POLL_INTERVAL_MS ?? 30_000),
  run: (task) => (erasureFence ? erasureFence.run("WORKER", task) : task()),
});

if (browserContexts) {
  let contextSweepRunning = false;
  const contextSweep = async () => {
    if (contextSweepRunning) return;
    contextSweepRunning = true;
    try {
      const sweep = () => browserContexts.maintain();
      if (erasureFence) await erasureFence.run("WORKER", sweep); else await sweep();
    } catch { diagnostic("BROWSER_CONTEXT_SWEEP_FAILED"); }
    finally { contextSweepRunning = false; }
  };
  const contextSweepTimer = setInterval(() => { void contextSweep(); }, Number(process.env.BROWSER_CONTEXT_SWEEP_INTERVAL_MS ?? 30_000));
  contextSweepTimer.unref();
}

if (marketingBroadcastsEnabled && campaignUnsubscribeSecret && sendCampaignEmail) {
  let campaignDispatchRunning = false;
  const campaignDispatch = async () => {
    if (campaignDispatchRunning) return;
    campaignDispatchRunning = true;
    try {
      const dispatch=()=>dispatchPendingCampaigns(db, {
        secret: campaignUnsubscribeSecret,
        publicOrigin: origins.platform,
        send: sendCampaignEmail,
      });
      if(erasureFence) await erasureFence.run("WORKER",dispatch);else await dispatch();
    } catch (error) { console.error("campaign dispatch sweep failed", error); }
    finally { campaignDispatchRunning = false; }
  };
  const campaignDispatchTimer = setInterval(() => { void campaignDispatch(); }, Number(process.env.CAMPAIGN_DISPATCH_INTERVAL_MS ?? 5_000));
  campaignDispatchTimer.unref();
  void campaignDispatch();
}

const reconciliationRail = native ? historicalPaymentRail : paymentRail;
if (reconciliationRail) {
  let checkoutPollRunning = false;
  const checkoutPoll = async () => {
    if (checkoutPollRunning) return;
    checkoutPollRunning = true;
    try {
      const reconcile=async()=>{
        // Native checkout attempts and refunds use their own tables and sweeps.
        await reconcilePendingCheckouts(db, reconciliationRail, undefined, native ? undefined : config);
        if (refundEnvelopeKeys) await reconcilePendingRefunds(db, reconciliationRail, refundEnvelopeKeys);
      };
      if(erasureFence) await erasureFence.run("WORKER",reconcile);else await reconcile();
    }
    catch (error) { console.error("checkout reconciliation sweep failed", error); }
    finally { checkoutPollRunning = false; }
  };
  const checkoutPollTimer = setInterval(() => { void checkoutPoll(); }, Number(process.env.CHECKOUT_POLL_INTERVAL_MS ?? 30_000));
  checkoutPollTimer.unref();
  void checkoutPoll();
}

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3002) });
// After-response work is owned by the process: stop accepting requests, let tracked attempts finish
// within their bound, then exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    server.close();
    void afterResponse.drain(2_000).finally(() => process.exit(0));
  });
}
}
// Expose completion, not a detached task: composition tests and supervisors must
// observe async boot admission before treating a module import as a running server.
export const serverStartup = startServer();
void serverStartup.catch(()=>{console.error("COMMERCE_V2_START_REFUSED");process.exitCode=1;});
