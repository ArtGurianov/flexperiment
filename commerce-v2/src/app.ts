import type Database from "better-sqlite3";
import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { createRestrictiveOverride, flagOrphanedOverrides, listPendingOverrides, releaseRolledBackOverride, type RestrictiveOverride, type RollbackReleaseProof } from "./access-overrides";
import { applyCourseManifest, type CourseManifest } from "./manifest";
import { assertPaymentCreationEnabled, type CommerceRuntimeConfig } from "./payment-mode";
import { saveResumePosition } from "./resume";
import { confirmCheckout, prepareCheckout, reconcileCheckout, type PaymentRail } from "./checkout";
import { activateSales, configureProduct, withdrawProduct } from "./catalog-control";
import { confirmCampaign, createCampaign, dispatchCampaign, unsubscribeCustomer, type CampaignEmail } from "./campaigns";
import { observeKinescopeStatus, pollKinescopeUpload, startVideoUpload, type KinescopeClient, type KinescopeStatus } from "./kinescope";
import { activateLegalRelease, currentLegalRelease, type LegalReleaseManifest } from "./legal-control";
import { issueCheckoutHandoffState, issueCheckoutPaymentReturnState, verifyCheckoutHandoffState, verifyCheckoutNavigationState } from "./checkout-handoff";
import { listMerchantPromotions, saveMerchantPromotion, type MerchantPromotionInput } from "./promotions";
import { decideRefund, executeApprovedRefund, listCustomerRefunds, listRefundCases, recordCourseAccessStart, requestRefund, type RefundDecisionInput, type RefundReason } from "./refunds";
import { grantManualEntitlement, revokeManualEntitlement } from "./entitlements";
import { listCustomerLibrary, listCustomerOrderHistory } from "./library";
import { controlRoomAttention, controlRoomAudit, controlRoomCatalogue, controlRoomCities, controlRoomCustomers, controlRoomEmailOperations, controlRoomEntitlements, controlRoomIncidents, controlRoomIntegrationSummary, controlRoomLabOccurrences, controlRoomOrders } from "./control-room";
import { auditControlRoom, consumeControlRoomLoginLimit, CONTROL_ROOM_SESSION_TTL_MS, controlRoomSessionCookie, issueControlRoomSession, parseControlRoomSession, verifyControlRoomPassword, type ControlRoomAuthConfig } from "./control-room-auth";
import type { MerchantPromotionCommand, ProductConfigurationCommand, ProductWithdrawalCommand } from "@flexperiment/control-room-contracts";
import { resolvePlaybackAccess } from "./playback-access";
import { issuePlaybackToken, verifyPlaybackToken } from "./playback-auth";
import { recordPlaybackAccessEvent } from "./playback-telemetry";
import { loadCommerceOrigins, storefrontOrigin, type CommerceOrigins, type Storefront } from "./origins";

type Dependencies = {
  readonly db: Database.Database;
  readonly config: CommerceRuntimeConfig;
  readonly sourceCommit: string;
  readonly serviceToken: string;
  readonly authenticateCustomer?: (headers: Headers) => Promise<string | null>;
  readonly authHandler?: (request: Request) => Promise<Response>;
  readonly prepareMagicLinkInitiation?: (input: {
    email: string; storefront: "COURSES" | "LAB"; personalDataConsent: boolean; personalDataVersion: string; personalDataSha256: string;
    accountTermsVersion: string; accountTermsSha256: string;
    marketingConsent?: boolean; marketingDocumentVersion: string; marketingDocumentSha256: string;
  }) => void;
  readonly verifyCaptcha?: (token: string, ip: string | undefined) => Promise<boolean>;
  readonly kinescopeDrmAuth?: { tokenSecret: string; username: string; password: string };
  readonly now?: () => Date;
  readonly kinescopeClient?: KinescopeClient;
  readonly kinescopeLessonsFolderId?: string;
  readonly kinescopeWebhookCredentials?: { username: string; password: string };
  readonly runtimeCapabilities?: {
    readonly authEmailConfigured: boolean;
    readonly captchaConfigured: boolean;
    readonly kinescopeApiConfigured: boolean;
  };
  readonly paymentRail?: PaymentRail;
  readonly invalidatePlatformCache?: (mode: "swr" | "immediate", courseRef?: string) => Promise<void>;
  readonly campaignUnsubscribeSecret?: string;
  readonly origins?: CommerceOrigins;
  readonly sendCampaignEmail?: (message: CampaignEmail) => Promise<void>;
  readonly controlRoomAuth?: ControlRoomAuthConfig;
};

type AppBindings = { Variables: { controlRoomAdminId?: string; controlRoomSessionId?: string } };

const secureEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const noStore = { "Cache-Control": "no-store" };
const CONTROL_ROOM_SESSION_SECONDS = CONTROL_ROOM_SESSION_TTL_MS / 1000;

export function createCommerceV2App(deps: Dependencies) {
  const app = new Hono<AppBindings>();
  const now = deps.now ?? (() => new Date());
  const origins = deps.origins ?? loadCommerceOrigins({ NODE_ENV: "test" });

  app.use("*", async (context, next) => {
    await next();
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });

  app.get("/identity", (context) => context.json({
    schema: "flexperiment.build-identity/1",
    service: "commerce-v2",
    sourceCommit: deps.sourceCommit,
  }, 200, noStore));
  app.get("/readyz", (context) => {
    const protectedKinescopeMissing = deps.config.kinescopeDeliveryMode === "protected"
      && (deps.runtimeCapabilities?.kinescopeApiConfigured === false || !deps.kinescopeDrmAuth);
    return context.json({
      ok: !protectedKinescopeMissing,
      service: "commerce-v2",
      sourceCommit: deps.sourceCommit,
      core: { database: "ok", configuration: protectedKinescopeMissing ? "incomplete" : "ok", paymentMode: deps.config.paymentMode },
      capabilities: {
        refref: deps.config.paymentMode === "refref" ? "configured_not_probed" : "not_required",
        authEmail: deps.runtimeCapabilities?.authEmailConfigured === false ? "missing" : "configured",
        captcha: deps.runtimeCapabilities?.captchaConfigured === false ? "missing" : "configured",
        kinescope: deps.runtimeCapabilities?.kinescopeApiConfigured === false ? "missing" : "configured_not_probed",
        kinescopeDrm: deps.config.kinescopeDeliveryMode === "protected" ? (deps.kinescopeDrmAuth ? "configured" : "missing") : "not_required",
        catalog: {
          projectedCourses: (deps.db.prepare("SELECT COUNT(*) AS count FROM catalog_course_projection").get() as { count: number }).count,
          pendingOverrides: (deps.db.prepare("SELECT COUNT(*) AS count FROM access_overrides WHERE state='PENDING'").get() as { count: number }).count,
          attentionOverrides: (deps.db.prepare("SELECT COUNT(*) AS count FROM access_overrides WHERE attention_reason IS NOT NULL").get() as { count: number }).count,
        },
      },
    }, protectedKinescopeMissing ? 503 : 200, noStore);
  });

  app.post("/v1/admin/login", async (context) => {
    const auth = deps.controlRoomAuth;
    if (!auth) return context.json({ error: { code: "CONTROL_ROOM_AUTH_NOT_CONFIGURED" } }, 503, noStore);
    const origin = context.req.header("origin");
    if (origin && origin !== auth.origin) return context.json({ error: { code: "ORIGIN_FORBIDDEN" } }, 403, noStore);
    const source = context.req.header("cf-connecting-ip") ?? context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    try {
      consumeControlRoomLoginLimit(deps.db, { source, secret: auth.sessionSecret, now: now(), windowMs: 15 * 60_000, limit: 5, label: "15m" });
      consumeControlRoomLoginLimit(deps.db, { source, secret: auth.sessionSecret, now: now(), windowMs: 24 * 60 * 60_000, limit: 20, label: "day" });
      const body = await context.req.json<{ password?: string }>();
      if (!body.password || !verifyControlRoomPassword(body.password, auth.passwordScrypt)) {
        return context.json({ error: { code: "INVALID_CREDENTIALS" } }, 401, noStore);
      }
      const issued = issueControlRoomSession(auth.sessionSecret, "singleton-admin", now().getTime());
      const login = deps.db.transaction(() => {
        deps.db.prepare("DELETE FROM control_room_admin_sessions WHERE expires_at<=? OR (revoked_at IS NOT NULL AND revoked_at<?)")
          .run(now().toISOString(), new Date(now().getTime() - 7 * 24 * 60 * 60_000).toISOString());
        deps.db.prepare(`INSERT INTO control_room_admin_sessions(id,admin_id,expires_at,created_at) VALUES (?,?,?,?)`)
          .run(issued.session.sid, issued.session.sub, new Date(issued.session.exp).toISOString(), now().toISOString());
        auditControlRoom(deps.db, { adminId: issued.session.sub, action: "SESSION_CREATED", entityType: "admin_session", entityId: issued.session.sid }, now().toISOString());
      });
      login.immediate();
      context.header("Set-Cookie", controlRoomSessionCookie(issued.token, CONTROL_ROOM_SESSION_SECONDS));
      return context.json({ ok: true }, 200, noStore);
    } catch (error) {
      const code = error instanceof Error ? error.message : "LOGIN_FAILED";
      return context.json({ error: { code } }, code === "RATE_LIMITED" ? 429 : 400, noStore);
    }
  });

  app.use("/v1/admin/*", async (context, next) => {
    const auth = deps.controlRoomAuth;
    if (!auth) return context.json({ error: { code: "CONTROL_ROOM_AUTH_NOT_CONFIGURED" } }, 503, noStore);
    const origin = context.req.header("origin");
    if (origin && origin !== auth.origin) return context.json({ error: { code: "ORIGIN_FORBIDDEN" } }, 403, noStore);
    const session = parseControlRoomSession(context.req.header("cookie"), auth.sessionSecret, now().getTime());
    const active = session && deps.db.prepare(`SELECT 1 FROM control_room_admin_sessions
      WHERE id=? AND admin_id=? AND revoked_at IS NULL AND expires_at>?`).get(session.sid, session.sub, now().toISOString());
    if (!session || !active) return context.json({ error: { code: "ADMIN_AUTH_REQUIRED" } }, 401, noStore);
    context.set("controlRoomAdminId", session.sub);
    context.set("controlRoomSessionId", session.sid);
    await next();
  });

  app.get("/v1/admin/session", (context) => context.json({ authenticated: true }, 200, noStore));
  app.post("/v1/admin/logout", (context) => {
    deps.db.prepare("UPDATE control_room_admin_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?")
      .run(now().toISOString(), context.get("controlRoomSessionId"));
    context.header("Set-Cookie", controlRoomSessionCookie("", 0));
    return context.json({ ok: true }, 200, noStore);
  });

  app.get("/v1/admin/v2/catalogue", (context) => context.json(controlRoomCatalogue(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/orders", (context) => context.json(controlRoomOrders(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/customers", (context) => context.json(controlRoomCustomers(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/entitlements", (context) => context.json(controlRoomEntitlements(deps.db, now().toISOString()), 200, noStore));
  app.post("/v1/admin/v2/entitlements/manual", async (context) => {
    try {
      const input = await context.req.json<{
        customerId: string;
        scope: "COURSE" | "ALL_COURSES";
        courseRef?: string;
        reason: string;
        evidenceRef: string;
        legalTermsRef: string;
        idempotencyKey: string;
      }>();
      const result = grantManualEntitlement(deps.db, {
        ...input,
        actor: context.get("controlRoomAdminId")!,
      }, now().toISOString());
      return context.json(result, result.created ? 201 : 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "MANUAL_GRANT_FAILED" } }, 409, noStore);
    }
  });
  app.post("/v1/admin/v2/entitlements/:entitlementId/revoke", async (context) => {
    try {
      const input = await context.req.json<{ reason: string; evidenceRef: string }>();
      return context.json(revokeManualEntitlement(deps.db, context.req.param("entitlementId"), {
        ...input,
        actor: context.get("controlRoomAdminId")!,
      }, now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "MANUAL_REVOCATION_FAILED" } }, 409, noStore);
    }
  });
  app.get("/v1/admin/v2/cities", (context) => context.json(controlRoomCities(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/lab", (context) => context.json(controlRoomLabOccurrences(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/refunds", (context) => context.json(listRefundCases(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/attention", (context) => {
    flagOrphanedOverrides(deps.db, now().toISOString());
    return context.json(controlRoomAttention(deps.db, now().toISOString()), 200, noStore);
  });
  app.get("/v1/admin/v2/integration", (context) =>
    context.json(controlRoomIntegrationSummary(deps.db, deps.config, now(), Number(process.env.CATALOG_LEASE_MS ?? 24 * 60 * 60 * 1000)), 200, noStore));
  app.get("/v1/admin/v2/promotions", (context) => context.json({
    generatedAt: now().toISOString(), reservedPrefix: deps.config.merchantPromotionPrefix,
    promotions: listMerchantPromotions(deps.db),
  }, 200, noStore));
  app.get("/v1/admin/v2/email", (context) => context.json(controlRoomEmailOperations(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/incidents", (context) => context.json(controlRoomIncidents(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/admin/v2/audit", (context) => context.json(controlRoomAudit(deps.db, now().toISOString()), 200, noStore));

  app.post("/v1/admin/v2/catalogue/products", async (context) => {
    try {
      const input = await context.req.json<ProductConfigurationCommand>();
      const actor = context.get("controlRoomAdminId")!;
      const result = configureProduct(deps.db, deps.config, { ...input, actor }, now().toISOString());
      auditControlRoom(deps.db, { adminId: actor, action: "PRODUCT_CONFIGURED", entityType: "product",
        entityId: input.productRef, details: { version: result.version, accessModel: input.accessModel, saleMode: input.saleMode } }, now().toISOString());
      await deps.invalidatePlatformCache?.("swr", input.courseRef);
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "PRODUCT_COMMAND_FAILED" } }, 409, noStore);
    }
  });

  app.post("/v1/admin/v2/catalogue/products/:productRef/withdraw", async (context) => {
    try {
      const input = await context.req.json<ProductWithdrawalCommand>();
      const actor = context.get("controlRoomAdminId")!;
      const productRef = context.req.param("productRef");
      const product = deps.db.prepare("SELECT course_ref FROM products WHERE product_ref=?").get(productRef) as { course_ref: string | null } | undefined;
      const result = withdrawProduct(deps.db, { productRef, ...input, actor }, now().toISOString());
      auditControlRoom(deps.db, { adminId: actor, action: "PRODUCT_WITHDRAWN", entityType: "product",
        entityId: productRef, details: { version: result.version, reason: input.reason, termsRef: input.termsRef } }, now().toISOString());
      await deps.invalidatePlatformCache?.("immediate", product?.course_ref ?? undefined);
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "WITHDRAWAL_FAILED" } }, 409, noStore);
    }
  });

  app.post("/v1/admin/v2/promotions", async (context) => {
    try {
      const input = await context.req.json<MerchantPromotionCommand>();
      const actor = context.get("controlRoomAdminId")!;
      const result = saveMerchantPromotion(deps.db, { ...input, actor }, deps.config.merchantPromotionPrefix, now().toISOString());
      auditControlRoom(deps.db, { adminId: actor, action: "MERCHANT_PROMOTION_SAVED", entityType: "merchant_promotion",
        entityId: result.id, details: { version: result.version, code: result.code } }, now().toISOString());
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "MERCHANT_PROMOTION_REJECTED" } }, 409, noStore);
    }
  });

  app.post("/v1/admin/v2/refunds/:requestPublicId/decision", async (context) => {
    try {
      const input = await context.req.json<Omit<RefundDecisionInput, "actor">>();
      const result = decideRefund(deps.db, context.req.param("requestPublicId"), {
        ...input, actor: context.get("controlRoomAdminId") ?? "unknown-admin",
      }, now().toISOString());
      auditControlRoom(deps.db, { adminId: context.get("controlRoomAdminId")!, action: `REFUND_${input.outcome}`,
        entityType: "refund_request", entityId: context.req.param("requestPublicId"), details: { amountKopecks: input.amountKopecks, policyBasis: input.policyBasis } }, now().toISOString());
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "REFUND_DECISION_FAILED" } }, 409, noStore);
    }
  });
  app.post("/v1/admin/v2/refunds/:requestPublicId/execute", async (context) => {
    if (!deps.paymentRail) return context.json({ error: { code: "PAYMENT_RAIL_UNAVAILABLE" } }, 503, noStore);
    try {
      const result = await executeApprovedRefund(deps.db, deps.paymentRail, context.req.param("requestPublicId"), now().toISOString());
      auditControlRoom(deps.db, { adminId: context.get("controlRoomAdminId")!, action: "REFUND_EXECUTION_REQUESTED",
        entityType: "refund_request", entityId: context.req.param("requestPublicId"), details: { state: result.state } }, now().toISOString());
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ error: { code: error instanceof Error ? error.message : "REFUND_EXECUTION_FAILED" } }, 409, noStore);
    }
  });

  app.use("/v1/internal/*", async (context, next) => {
    const presented = context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (!presented || !secureEqual(presented, deps.serviceToken)) return context.json({ code: "UNAUTHORIZED" }, 401, noStore);
    await next();
  });

  if (deps.authHandler) {
    app.post("/v1/auth/sign-in/magic-link", async (context) => {
      try {
        const input = await context.req.raw.clone().json() as { captchaToken?: string } & Parameters<NonNullable<Dependencies["prepareMagicLinkInitiation"]>>[0];
        if (deps.verifyCaptcha && !await deps.verifyCaptcha(input.captchaToken ?? "", context.req.header("x-forwarded-for")?.split(",")[0]?.trim())) {
          return context.json({ code: "SMARTCAPTCHA_REJECTED" }, 422, noStore);
        }
        deps.prepareMagicLinkInitiation?.(input);
        return deps.authHandler!(context.req.raw);
      } catch (error) {
        return context.json({ code: error instanceof Error ? error.message : "AUTH_INITIATION_REJECTED" }, 422, noStore);
      }
    });
    app.all("/v1/auth/*", (context) => deps.authHandler!(context.req.raw));
  }

  app.post("/v1/internal/access-overrides", async (context) => {
    try {
      const result = createRestrictiveOverride(deps.db, await context.req.json<RestrictiveOverride>());
      return context.json({ state: "PENDING", enforced: true }, result.created ? 201 : 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "INVALID_OVERRIDE" }, 409, noStore);
    }
  });

  app.get("/v1/internal/access-overrides/pending", (context) => {
    flagOrphanedOverrides(deps.db, now().toISOString());
    return context.json({ overrides: listPendingOverrides(deps.db) }, 200, noStore);
  });

  app.get("/v1/internal/catalog-summary", (context) => {
    const courses = deps.db.prepare(`SELECT product.course_ref AS courseRef,product.access_model AS accessModel,
      (product.withdrawn_at IS NOT NULL) AS withdrawn,offer.offer_ref AS offerRef,
      offer.sale_mode AS saleMode,offer.price_kopecks AS priceKopecks
      FROM products product LEFT JOIN offers offer ON offer.product_id=product.id
      WHERE product.kind='ONLINE_COURSE'`).all();
    return context.json({ courses }, 200, noStore);
  });

  app.get("/v1/internal/control-room/catalogue", (context) =>
    context.json(controlRoomCatalogue(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/orders", (context) =>
    context.json(controlRoomOrders(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/customers", (context) =>
    context.json(controlRoomCustomers(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/entitlements", (context) =>
    context.json(controlRoomEntitlements(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/cities", (context) =>
    context.json(controlRoomCities(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/lab", (context) =>
    context.json(controlRoomLabOccurrences(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/attention", (context) => {
    flagOrphanedOverrides(deps.db, now().toISOString());
    return context.json(controlRoomAttention(deps.db, now().toISOString()), 200, noStore);
  });
  app.get("/v1/internal/control-room/integration", (context) =>
    context.json(controlRoomIntegrationSummary(deps.db, deps.config, now(), Number(process.env.CATALOG_LEASE_MS ?? 24 * 60 * 60 * 1000)), 200, noStore));
  app.get("/v1/internal/control-room/email", (context) => context.json(controlRoomEmailOperations(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/incidents", (context) => context.json(controlRoomIncidents(deps.db, now().toISOString()), 200, noStore));
  app.get("/v1/internal/control-room/audit", (context) => context.json(controlRoomAudit(deps.db, now().toISOString()), 200, noStore));

  app.post("/v1/internal/catalog/products", async (context) => {
    try {
      const command = await context.req.json<Parameters<typeof configureProduct>[2]>();
      const result = configureProduct(deps.db, deps.config, command, now().toISOString());
      await deps.invalidatePlatformCache?.("swr", command.courseRef);
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "PRODUCT_COMMAND_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/catalog/products/:productRef/withdraw", async (context) => {
    try {
      const body = await context.req.json<{ reason: string; termsRef: string; actor: string; expectedVersion: number }>();
      const product = deps.db.prepare("SELECT course_ref FROM products WHERE product_ref=?").get(context.req.param("productRef")) as { course_ref: string | null } | undefined;
      const result = withdrawProduct(deps.db, { productRef: context.req.param("productRef"), ...body }, now().toISOString());
      await deps.invalidatePlatformCache?.("immediate", product?.course_ref ?? undefined);
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "WITHDRAWAL_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/sales-activations", async (context) => {
    try {
      return context.json(activateSales(deps.db, await context.req.json<Parameters<typeof activateSales>[1]>(), now().toISOString()), 201, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "SALES_ACTIVATION_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/legal-releases", async (context) => {
    try {
      return context.json(activateLegalRelease(deps.db, await context.req.json<{
        storefront: "COURSES" | "LAB"; version: string; manifest: LegalReleaseManifest; actor: string;
      }>(), now().toISOString()), 201, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "LEGAL_RELEASE_FAILED" }, 409, noStore);
    }
  });

  app.get("/v1/internal/merchant-promotions", (context) => context.json({
    reservedPrefix: deps.config.merchantPromotionPrefix,
    promotions: listMerchantPromotions(deps.db),
  }, 200, noStore));

  app.post("/v1/internal/merchant-promotions", async (context) => {
    try {
      const result = saveMerchantPromotion(
        deps.db,
        await context.req.json<MerchantPromotionInput>(),
        deps.config.merchantPromotionPrefix,
        now().toISOString(),
      );
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "MERCHANT_PROMOTION_REJECTED" }, 409, noStore);
    }
  });

  app.get("/v1/legal/current", (context) => {
    const storefront = context.req.query("storefront") === "LAB" ? "LAB" : "COURSES";
    const release = currentLegalRelease(deps.db, storefront);
    return release ? context.json(release, 200, noStore) : context.json({ code: "LEGAL_RELEASE_NOT_FOUND" }, 404, noStore);
  });

  app.post("/v1/internal/campaigns", async (context) => {
    try {
      return context.json(createCampaign(deps.db, await context.req.json<{ courseRef: string; payload: Record<string, unknown> }>()), 201, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CAMPAIGN_CREATE_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/campaigns/:id/confirm", async (context) => {
    try {
      const body = await context.req.json<{ actor: string }>();
      return context.json(confirmCampaign(deps.db, context.req.param("id"), body.actor, now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CAMPAIGN_CONFIRM_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/campaigns/:id/dispatch", async (context) => {
    if (!deps.campaignUnsubscribeSecret || !deps.sendCampaignEmail) return context.json({ code: "CAMPAIGN_DELIVERY_NOT_CONFIGURED" }, 503, noStore);
    try {
      return context.json(await dispatchCampaign(deps.db, context.req.param("id"), {
        secret: deps.campaignUnsubscribeSecret, publicOrigin: origins.platform, send: deps.sendCampaignEmail,
      }, now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CAMPAIGN_DISPATCH_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/email/unsubscribe", (context) => {
    if (!deps.campaignUnsubscribeSecret) return context.json({ code: "UNSUBSCRIBE_NOT_CONFIGURED" }, 503, noStore);
    try {
      const token = new URL(context.req.url).searchParams.get("token") ?? "";
      return context.json(unsubscribeCustomer(deps.db, token, deps.campaignUnsubscribeSecret, now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "UNSUBSCRIBE_FAILED" }, 422, noStore);
    }
  });

  app.post("/v1/internal/video-uploads", async (context) => {
    if (!deps.kinescopeClient || !deps.kinescopeLessonsFolderId) return context.json({ code: "KINESCOPE_UPLOAD_NOT_CONFIGURED" }, 503, noStore);
    try {
      const input = await context.req.json<{ lessonRef: string; title: string }>();
      if (!input.lessonRef || !input.title) throw new Error("VIDEO_UPLOAD_INPUT_INVALID");
      return context.json(await startVideoUpload(deps.db, deps.kinescopeClient, {
        ...input, parentId: deps.kinescopeLessonsFolderId,
      }), 201, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "VIDEO_UPLOAD_INIT_FAILED" }, 422, noStore);
    }
  });

  app.get("/v1/internal/video-uploads/:id", async (context) => {
    if (deps.kinescopeClient) {
      try { await pollKinescopeUpload(deps.db, deps.kinescopeClient, context.req.param("id"), now().toISOString()); }
      catch (error) {
        if (error instanceof Error && error.message === "KINESCOPE_UPLOAD_SESSION_NOT_FOUND") return context.json({ code: "VIDEO_UPLOAD_NOT_FOUND" }, 404, noStore);
        return context.json({ code: "KINESCOPE_STATUS_UNAVAILABLE" }, 503, noStore);
      }
    }
    const session = deps.db.prepare(`SELECT session.id AS uploadSessionId,session.status AS state,session.error_code AS errorCode,
      binding.duration_seconds AS durationSeconds FROM video_upload_sessions session
      LEFT JOIN lesson_video_bindings binding ON binding.lesson_ref=session.lesson_ref AND session.status='READY'
      WHERE session.id=?`).get(context.req.param("id"));
    return session ? context.json(session, 200, noStore) : context.json({ code: "VIDEO_UPLOAD_NOT_FOUND" }, 404, noStore);
  });

  app.post("/v1/internal/access-overrides/:operationId/release", async (context) => {
    try {
      releaseRolledBackOverride(deps.db, context.req.param("operationId"), await context.req.json<RollbackReleaseProof>());
      return context.json({ state: "RELEASED_ROLLED_BACK" }, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "RELEASE_REFUSED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/course-manifests", async (context) => {
    try {
      const result = applyCourseManifest(deps.db, await context.req.json<CourseManifest>(), now().toISOString());
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "MANIFEST_REJECTED" }, 409, noStore);
    }
  });

  app.post("/v1/checkout/preview", async (context) => {
    try {
      assertPaymentCreationEnabled(deps.config);
      const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
      if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
      if (!deps.paymentRail) return context.json({ code: "PAYMENT_RAIL_UNAVAILABLE" }, 503, noStore);
      const customer = deps.db.prepare("SELECT email_normalized FROM customers WHERE id=?").get(customerId) as { email_normalized: string } | undefined;
      if (!customer) return context.json({ code: "CUSTOMER_NOT_FOUND" }, 409, noStore);
      const body = await context.req.json<{ offerRef?: string; mockScenario?: string; handoffToken?: string; checkoutCode?: string; state?: string }>();
      if (!body.offerRef) throw new Error("OFFER_REF_REQUIRED");
      const handoff = deps.config.paymentMode === "refref"
        ? verifyCheckoutHandoffState(deps.config.refref!.handoffStateSecret, body.state ?? "", customerId, now().getTime())
        : undefined;
      const result = await prepareCheckout(deps.db, deps.paymentRail, {
        customerId, customerEmail: customer.email_normalized, offerRef: body.offerRef,
        previewIdempotencyKey: context.req.header("idempotency-key") ?? "",
        scenario: deps.config.paymentMode === "mock" ? body.mockScenario : undefined,
        handoffToken: body.handoffToken,
        checkoutCode: body.checkoutCode,
        orderPublicId: handoff?.orderPublicId,
        storefront: handoff?.storefront,
      }, now().toISOString(), deps.config.merchantPromotionPrefix);
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CHECKOUT_PREVIEW_UNAVAILABLE" }, 503, noStore);
    }
  });

  app.post("/v1/checkout", async (context) => {
    try {
      assertPaymentCreationEnabled(deps.config);
      const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
      if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
      if (!deps.paymentRail) return context.json({ code: "PAYMENT_RAIL_UNAVAILABLE" }, 503, noStore);
      const customer = deps.db.prepare("SELECT email_normalized FROM customers WHERE id=?").get(customerId) as { email_normalized: string } | undefined;
      if (!customer) return context.json({ code: "CUSTOMER_NOT_FOUND" }, 409, noStore);
      const body = await context.req.json<{ quoteId?: string; state?: string }>();
      if (!body.quoteId) throw new Error("CHECKOUT_QUOTE_REQUIRED");
      const handoff = deps.config.paymentMode === "refref"
        ? verifyCheckoutHandoffState(deps.config.refref!.handoffStateSecret, body.state ?? "", customerId, now().getTime())
        : undefined;
      const paymentReturn = handoff
        ? issueCheckoutPaymentReturnState(deps.config.refref!.handoffStateSecret, handoff, now().getTime())
        : undefined;
      const successUrl = paymentReturn ? new URL("/checkout/return", storefrontOrigin(origins, paymentReturn.state.storefront)) : undefined;
      successUrl?.searchParams.set("state", paymentReturn!.token);
      const result = await confirmCheckout(deps.db, deps.paymentRail, {
        customerId,
        customerEmail: customer.email_normalized,
        quoteId: body.quoteId,
        idempotencyKey: context.req.header("idempotency-key") ?? "",
        expectedOrderPublicId: handoff?.orderPublicId,
        storefront: handoff?.storefront,
        successUrl: successUrl?.toString(),
      }, now().toISOString());
      return context.json(result, result.state === "CREATE_UNKNOWN" ? 202 : 201, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CHECKOUT_UNAVAILABLE" }, 503, noStore);
    }
  });

  app.post("/v1/checkout/handoff", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    if (deps.config.paymentMode !== "refref") return context.json({ required: false }, 200, noStore);
    try {
      const { returnPath, storefront } = await context.req.json<{ returnPath: string; storefront: Storefront }>();
      if (storefront !== "COURSES" && storefront !== "LAB") throw new Error("CHECKOUT_STOREFRONT_INVALID");
      const issued = issueCheckoutHandoffState(deps.config.refref!.handoffStateSecret, { customerId, returnPath, storefront }, now().getTime());
      const target = new URL("/v1-rc/public/attribution-handoff", deps.config.refref!.checkoutOrigin);
      target.searchParams.set("merchant", deps.config.refref!.merchantSlug);
      target.searchParams.set("merchantOrderRef", issued.state.orderPublicId);
      target.searchParams.set("returnUrl", new URL("/checkout/return", storefrontOrigin(origins, storefront)).toString());
      target.searchParams.set("state", issued.token);
      return context.json({ required: true, url: target.toString() }, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CHECKOUT_HANDOFF_FAILED" }, 422, noStore);
    }
  });

  app.get("/v1/checkout/handoff/return", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    if (deps.config.paymentMode !== "refref") return context.json({ code: "CHECKOUT_HANDOFF_NOT_REQUIRED" }, 409, noStore);
    try {
      const state = verifyCheckoutNavigationState(deps.config.refref!.handoffStateSecret, context.req.query("state") ?? "", customerId, now().getTime());
      return context.json({ phase: state.phase, returnPath: state.returnPath, orderPublicId: state.orderPublicId, storefront: state.storefront }, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "CHECKOUT_STATE_INVALID" }, 422, noStore);
    }
  });

  app.get("/v1/checkout/:orderPublicId", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    if (!deps.paymentRail) return context.json({ code: "PAYMENT_RAIL_UNAVAILABLE" }, 503, noStore);
    const owned = deps.db.prepare("SELECT 1 FROM orders WHERE public_id=? AND customer_id=?").get(context.req.param("orderPublicId"), customerId);
    if (!owned) return context.json({ code: "ORDER_NOT_FOUND" }, 404, noStore);
    try {
      return context.json(await reconcileCheckout(deps.db, deps.paymentRail, context.req.param("orderPublicId"), now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "RECONCILE_FAILED" }, 409, noStore);
    }
  });

  app.get("/v1/refunds", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    return context.json({ refunds: listCustomerRefunds(deps.db, customerId) }, 200, noStore);
  });

  app.post("/v1/refunds", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    try {
      const body = await context.req.json<{ orderPublicId?: string; reasonCode?: RefundReason; customerNote?: string }>();
      if (!body.orderPublicId || !body.reasonCode) throw new Error("REFUND_REQUEST_INPUT_INVALID");
      return context.json(requestRefund(deps.db, {
        customerId, orderPublicId: body.orderPublicId, reasonCode: body.reasonCode, customerNote: body.customerNote,
        idempotencyKey: context.req.header("idempotency-key") ?? "",
      }, now().toISOString()), 201, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "REFUND_REQUEST_FAILED" }, 409, noStore);
    }
  });

  app.get("/v1/internal/refunds", (context) => context.json(listRefundCases(deps.db, now().toISOString()), 200, noStore));

  app.post("/v1/internal/refunds/:requestPublicId/decision", async (context) => {
    try {
      return context.json(decideRefund(deps.db, context.req.param("requestPublicId"), await context.req.json<RefundDecisionInput>(), now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "REFUND_DECISION_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/internal/refunds/:requestPublicId/execute", async (context) => {
    if (!deps.paymentRail) return context.json({ code: "PAYMENT_RAIL_UNAVAILABLE" }, 503, noStore);
    try {
      return context.json(await executeApprovedRefund(deps.db, deps.paymentRail, context.req.param("requestPublicId"), now().toISOString()), 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "REFUND_EXECUTION_FAILED" }, 409, noStore);
    }
  });

  app.post("/v1/webhooks/kinescope", async (context) => {
    const expected = deps.kinescopeWebhookCredentials;
    const authorization = context.req.header("authorization") ?? "";
    if (!expected || !authorization.startsWith("Basic ")) return context.json({ code: "KINESCOPE_WEBHOOK_UNAUTHORIZED" }, 401, noStore);
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    if (!secureEqual(decoded, `${expected.username}:${expected.password}`)) return context.json({ code: "KINESCOPE_WEBHOOK_UNAUTHORIZED" }, 401, noStore);
    if (!deps.kinescopeClient) return context.json({ code: "KINESCOPE_NOT_CONFIGURED" }, 503, noStore);
    try {
      const rawBody = await context.req.text();
      const body = JSON.parse(rawBody) as { event?: unknown; data?: { id?: unknown; status?: unknown } };
      const statuses = new Set<KinescopeStatus>(["pending", "uploading", "pre-processing", "processing", "aborted", "done", "error", "suspended"]);
      if (body.event !== "media.update.status" || typeof body.data?.id !== "string" || typeof body.data.status !== "string" || !statuses.has(body.data.status as KinescopeStatus)) {
        return context.json({ code: "KINESCOPE_WEBHOOK_SCHEMA_INVALID" }, 422, noStore);
      }
      const result = await observeKinescopeStatus(deps.db, deps.kinescopeClient, {
        videoId: body.data.id, status: body.data.status as KinescopeStatus, rawBody,
      }, now().toISOString());
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "KINESCOPE_WEBHOOK_FAILED" }, 422, noStore);
    }
  });

  app.post("/v1/kinescope/drm/authorize", async (context) => {
    const expected = deps.kinescopeDrmAuth;
    const authorization = context.req.header("authorization") ?? "";
    if (!expected || !authorization.startsWith("Basic ")) return context.json({ code: "KINESCOPE_DRM_UNAUTHORIZED" }, 401, noStore);
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    if (!secureEqual(decoded, `${expected.username}:${expected.password}`)) return context.json({ code: "KINESCOPE_DRM_UNAUTHORIZED" }, 401, noStore);
    const observedAt = now().toISOString();
    let body: { id?: unknown; token?: unknown; type?: unknown };
    try {
      body = await context.req.json<typeof body>();
    } catch {
      return context.json({ code: "KINESCOPE_DRM_SCHEMA_INVALID" }, 400, noStore);
    }
    if (typeof body.id !== "string" || !body.id || typeof body.token !== "string" || !body.token || body.type !== "video") {
      return context.json({ code: "KINESCOPE_DRM_SCHEMA_INVALID" }, 400, noStore);
    }
    let claims: ReturnType<typeof verifyPlaybackToken>;
    try {
      claims = verifyPlaybackToken(expected.tokenSecret, body.token, body.id, now());
    } catch (error) {
      recordPlaybackAccessEvent(deps.db, {
        videoId: body.id, eventType: "DRM_TOKEN_INVALID",
        reason: error instanceof Error ? error.message : "PLAYBACK_TOKEN_INVALID", occurredAt: observedAt,
      });
      return context.json({ code: "PLAYBACK_TOKEN_INVALID" }, 403, noStore);
    }
    const lesson = deps.db.prepare("SELECT lesson_ref FROM lesson_video_bindings WHERE active_video_id=?")
      .get(body.id) as { lesson_ref: string } | undefined;
    if (!lesson) {
      recordPlaybackAccessEvent(deps.db, {
        customerId: claims.customerId, videoId: body.id, eventType: "DRM_DENIED", reason: "VIDEO_NOT_BOUND", occurredAt: observedAt,
      });
      return context.json({ code: "PLAYBACK_DENIED" }, 403, noStore);
    }
    const resolution = resolvePlaybackAccess(deps.db, {
      customerId: claims.customerId,
      lessonRef: lesson.lesson_ref,
      now: now(),
      leaseMs: Number(process.env.CATALOG_LEASE_MS ?? 24 * 60 * 60 * 1000),
    });
    if (resolution.decision !== "ALLOW" || resolution.binding?.videoId !== body.id) {
      recordPlaybackAccessEvent(deps.db, {
        customerId: claims.customerId, lessonRef: lesson.lesson_ref, videoId: body.id,
        eventType: "DRM_DENIED", reason: resolution.decision, occurredAt: observedAt,
      });
      return context.json({ code: "PLAYBACK_DENIED" }, 403, noStore);
    }
    recordPlaybackAccessEvent(deps.db, {
      customerId: claims.customerId, lessonRef: lesson.lesson_ref, videoId: body.id,
      eventType: "DRM_ALLOWED", reason: "ALLOW", occurredAt: observedAt,
    });
    return context.json({ allowed: true }, 200, noStore);
  });

  app.get("/v1/me", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ customer: null }, 200, noStore);
    const customer = deps.db.prepare("SELECT id,email_normalized,display_name FROM customers WHERE id=?").get(customerId);
    const entitlements = deps.db.prepare(`SELECT scope,course_ref,granted_at FROM course_entitlements
      WHERE customer_id=? AND revoked_at IS NULL ORDER BY granted_at`).all(customerId);
    return context.json({ customer, entitlements }, 200, noStore);
  });

  app.get("/v1/library", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    return context.json(listCustomerLibrary(
      deps.db,
      customerId,
      now(),
      Number(process.env.CATALOG_LEASE_MS ?? 24 * 60 * 60 * 1000),
    ), 200, { "Cache-Control": "private, no-store" });
  });

  app.get("/v1/me/orders", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    return context.json({ orders: listCustomerOrderHistory(deps.db, customerId) }, 200, { "Cache-Control": "private, no-store" });
  });

  app.on(["PUT", "POST"], "/v1/lessons/:lessonRef/resume", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    try {
      const body = await context.req.json<{ seconds: number; clientSeq: number; clientTs: string }>();
      const result = saveResumePosition(deps.db, { customerId, lessonRef: context.req.param("lessonRef"), ...body }, now().toISOString());
      return context.json(result, 200, noStore);
    } catch (error) {
      return context.json({ code: error instanceof Error ? error.message : "INVALID_RESUME" }, 422, noStore);
    }
  });

  app.post("/v1/lessons/:lessonRef/playback", async (context) => {
    const customerId = await deps.authenticateCustomer?.(context.req.raw.headers) ?? null;
    if (!customerId) return context.json({ decision: "SIGN_IN_REQUIRED" }, 401, noStore);
    const windowStart = new Date(Math.floor(now().getTime() / 60_000) * 60_000).toISOString();
    const rate = deps.db.prepare(`INSERT INTO playback_grant_rate_limits(customer_id,window_start,request_count)
      VALUES (?,?,1) ON CONFLICT(customer_id,window_start) DO UPDATE SET request_count=request_count+1
      RETURNING request_count`).get(customerId, windowStart) as { request_count: number };
    if (rate.request_count > 30) {
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef: context.req.param("lessonRef"), eventType: "GRANT_RATE_LIMITED",
        reason: "PER_CUSTOMER_MINUTE_LIMIT", occurredAt: now().toISOString(),
      });
      return context.json({ code: "PLAYBACK_RATE_LIMITED" }, 429, { ...noStore, "Retry-After": "60" });
    }
    const lessonRef = context.req.param("lessonRef");
    const observedAt = now().toISOString();
    const resolution = resolvePlaybackAccess(deps.db, {
      customerId, lessonRef, now: now(), leaseMs: Number(process.env.CATALOG_LEASE_MS ?? 24 * 60 * 60 * 1000),
    });
    if (resolution.decision !== "ALLOW") {
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef, eventType: "GRANT_DENIED", reason: resolution.decision, occurredAt: observedAt,
      });
      return context.json({ decision: resolution.decision }, resolution.decision === "PURCHASE_REQUIRED" ? 402 : 403, noStore);
    }
    if (!resolution.binding) {
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef, eventType: "GRANT_DENIED", reason: "VIDEO_NOT_READY", occurredAt: observedAt,
      });
      return context.json({ decision: "DENY", code: "VIDEO_NOT_READY" }, 409, noStore);
    }
    const recordPaidAccessStart = () => {
      if (resolution.courseRef && resolution.paidEntitled) {
        recordCourseAccessStart(deps.db, { customerId, courseRef: resolution.courseRef, lessonRef }, observedAt);
      }
    };
    if (deps.config.kinescopeDeliveryMode === "open") {
      recordPaidAccessStart();
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef, videoId: resolution.binding.videoId, eventType: "GRANT_ALLOWED", reason: "OPEN", occurredAt: observedAt,
      });
      return context.json({ mode: "open", videoId: resolution.binding.videoId, resumeAt: resolution.resumeAt }, 200, noStore);
    }
    if (!deps.kinescopeDrmAuth) {
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef, videoId: resolution.binding.videoId, eventType: "GRANT_DENIED",
        reason: "KINESCOPE_GRANT_UNAVAILABLE", occurredAt: observedAt,
      });
      return context.json({ code: "KINESCOPE_GRANT_UNAVAILABLE" }, 503, noStore);
    }
    try {
      const protectedGrant = issuePlaybackToken(deps.kinescopeDrmAuth.tokenSecret, {
        videoId: resolution.binding.videoId, customerId,
      }, now());
      recordPaidAccessStart();
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef, videoId: resolution.binding.videoId, eventType: "GRANT_ALLOWED", reason: "PROTECTED", occurredAt: observedAt,
      });
      return context.json({ mode: "protected", videoId: resolution.binding.videoId, ...protectedGrant, resumeAt: resolution.resumeAt }, 200, noStore);
    } catch {
      recordPlaybackAccessEvent(deps.db, {
        customerId, lessonRef, videoId: resolution.binding.videoId, eventType: "GRANT_DENIED",
        reason: "KINESCOPE_GRANT_UNAVAILABLE", occurredAt: observedAt,
      });
      return context.json({ code: "KINESCOPE_GRANT_UNAVAILABLE" }, 503, noStore);
    }
  });

  return app;
}
