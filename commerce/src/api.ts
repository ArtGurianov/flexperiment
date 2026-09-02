import { Hono } from "hono";
import { ZodError } from "zod";
import type { Sqlite } from "./db";
import { assertAdminOrigin, issueAdminSession, parseSession, verifyAdminPassword, verifyReleaseControlToken } from "./auth";
import { emailHash, publicId, sha256 } from "./crypto";
import { CommerceDomain, DomainError } from "./domain";
import { type EmailProvider, UnconfiguredEmailProvider, UnisenderGoProvider } from "./email-provider";
import { TochkaProvider, type PaymentProvider } from "./provider";
import { clientIpRateLimitKey, rateLimit, trustedClientIp } from "./rate-limit";
import { TochkaWebhookVerifier, webhookAmountKopecks } from "./tochka-webhook";
import { verifyUnisenderWebhook } from "./unisender-webhook";
import { type SmartCaptchaVerifier, UnconfiguredSmartCaptchaVerifier } from "./smartcaptcha";
import { adminReauthSchema, agentPatchSchema, agentSchema, checkoutContextSchema, checkoutRequestSchema, cityCreateSchema, cityInterestSchema, cityInterestWithdrawalSchema, cityPatchSchema, compensationRefundSchema, customerCancellationSchema, customerRefundRequestSchema, customerRefundTokenSchema, emailAttentionAcknowledgeSchema, emergencySalesCommandSchema, occurrenceCancelSchema, occurrenceCompleteSchema, occurrenceCreateSchema, occurrenceNotificationSchema, occurrencePatchSchema, outboxDispatchFenceSchema, postActivationEmailProviderDefectSchema, preActivationDefectSchema, promoPatchSchema, promoSchema, providerReferenceSchema, reservationAbandonSchema, settlementCancelSchema, settlementDocumentSchema, settlementPaymentMadeSchema, settlementPrepareSchema, settlementRecoverySchema } from "./types";
import { completeRollingSchema, releaseControlSchema } from "./release-control-schema";

type AppBindings = { Variables: { adminId?: string; adminSessionId?: string } };
const noStore = (headers: Headers) => headers.set("Cache-Control", "no-store");
const adminSessionCookie = (value: string, maxAge: number) => `fx_admin_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
const publicBrowserOrigin = () => process.env.COMMERCE_PUBLIC_ORIGIN ?? "https://flexperiment.ru";
const canonicalWebhookPayload = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalWebhookPayload).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalWebhookPayload(entry)}`).join(",")}}`;
  return JSON.stringify(value);
};

const jsonBody = async (request: Request) => {
  try { return await request.json(); } catch { throw new DomainError("INVALID_JSON", 400); }
};

export function createApp(sqlite: Sqlite, provider: PaymentProvider, emailProvider: EmailProvider = new UnconfiguredEmailProvider(), smartCaptcha: SmartCaptchaVerifier = new UnconfiguredSmartCaptchaVerifier()) {
  const app = new Hono<AppBindings>();
  const domain = new CommerceDomain(sqlite, provider, emailProvider);
  const tochkaVerifier = provider instanceof TochkaProvider ? new TochkaWebhookVerifier() : undefined;
  const unisenderConfig = emailProvider instanceof UnisenderGoProvider ? emailProvider.config : undefined;

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });

  app.onError((error, c) => {
    if (error instanceof ZodError) return c.json({ error: { code: "VALIDATION_ERROR" } }, 422);
    if (error instanceof DomainError) {
      if (error.code === "RATE_LIMITED") c.header("Retry-After", error.message);
      return c.json({ error: { code: error.code } }, error.status as 400);
    }
    console.error("commerce request failed", error instanceof Error ? error.message : "unknown error");
    return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
  });

  app.use("/v1/public/*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin) {
      if (origin !== publicBrowserOrigin()) throw new DomainError("CORS_ORIGIN_FORBIDDEN", 403);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
      if (c.req.method === "OPTIONS") return c.body(null, 204);
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => {
    const migration = sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
    return migration ? c.json({ ok: true }) : c.json({ ok: false, reason: "MIGRATIONS_MISSING" }, 503);
  });

  const publicApi = new Hono();
  publicApi.use("*", async (c, next) => { noStore(c.res.headers); await next(); noStore(c.res.headers); });
  publicApi.get("/tour", (c) => { rateLimit(clientIpRateLimitKey("tour", c.req.raw.headers), 120, 60_000); return c.json({ cities: domain.tour() }); });
  publicApi.get("/cities/:city/occurrences", (c) => {
    rateLimit(clientIpRateLimitKey("occurrences", c.req.raw.headers), 120, 60_000);
    const entries = domain.tour().filter((item) => item.city === c.req.param("city") && item.id);
    return c.json({ occurrences: entries });
  });
  publicApi.get("/occurrences/:id", (c) => { rateLimit(clientIpRateLimitKey("occurrence", c.req.raw.headers), 120, 60_000); return c.json(domain.occurrence(c.req.param("id"))); });
  publicApi.get("/legal-config", (c) => c.json(domain.legalConfig()));
  const verifyCaptcha = async (token: string, headers: Headers) => {
    const result = await smartCaptcha.verify(token, trustedClientIp(headers));
    if (result === "PASS") return;
    if (result === "INVALID") throw new DomainError("CAPTCHA_INVALID", 422);
    throw new DomainError("CAPTCHA_UNAVAILABLE", 503);
  };
  publicApi.post("/city-interest", async (c) => {
    rateLimit(clientIpRateLimitKey("city-interest-ip", c.req.raw.headers), 5, 10 * 60_000);
    const input = cityInterestSchema.parse(await jsonBody(c.req.raw));
    rateLimit(`city-interest-email:${emailHash(input.email)}:${input.city}`, 3, 30 * 60_000);
    await verifyCaptcha(input.captcha_token, c.req.raw.headers);
    return c.json(domain.registerCityInterest(input), 202);
  });
  publicApi.post("/occurrence-notifications", async (c) => {
    rateLimit(clientIpRateLimitKey("occurrence-notification-ip", c.req.raw.headers), 5, 10 * 60_000);
    const input = occurrenceNotificationSchema.parse(await jsonBody(c.req.raw));
    const hash = emailHash(input.email);
    rateLimit(`occurrence-notification-email:${hash}`, 10, 60 * 60_000);
    rateLimit(`occurrence-notification-email-occurrence:${hash}:${input.occurrence_id}`, 3, 30 * 60_000);
    await verifyCaptcha(input.captcha_token, c.req.raw.headers);
    return c.json(domain.registerOccurrenceNotification(input), 202);
  });
  publicApi.post("/refunds/request", async (c) => {
    rateLimit(clientIpRateLimitKey("customer-refund-request-ip", c.req.raw.headers), 5, 10 * 60_000);
    const input = customerRefundRequestSchema.parse(await jsonBody(c.req.raw));
    rateLimit(`customer-refund-request-order:${sha256(input.order_number)}`, 3, 30 * 60_000);
    await verifyCaptcha(input.captcha_token, c.req.raw.headers);
    // The response is deliberately identical for unknown, ineligible, and
    // eligible references so this endpoint cannot enumerate customer orders.
    return c.json(domain.requestCustomerRefund(input.order_number), 202);
  });
  publicApi.post("/refunds/confirmation-context", async (c) => {
    const input = customerRefundTokenSchema.parse(await jsonBody(c.req.raw));
    rateLimit(clientIpRateLimitKey("customer-refund-context-ip", c.req.raw.headers), 30, 60_000);
    rateLimit(`customer-refund-context-token:${sha256(input.token)}`, 20, 60_000);
    return c.json(domain.customerRefundConfirmationContext(input.token));
  });
  publicApi.post("/refunds/confirm", async (c) => {
    const input = customerRefundTokenSchema.parse(await jsonBody(c.req.raw));
    rateLimit(clientIpRateLimitKey("customer-refund-confirm-ip", c.req.raw.headers), 20, 60_000);
    rateLimit(`customer-refund-confirm-token:${sha256(input.token)}`, 5, 60_000);
    return c.json(domain.confirmCustomerRefund(input.token));
  });
  publicApi.post("/referrals/eligibility", async (c) => {
    rateLimit(clientIpRateLimitKey("referral", c.req.raw.headers), 60, 60_000);
    const input = await jsonBody(c.req.raw) as { slug?: string };
    const slug = input.slug?.trim() ?? ""; rateLimit(`referral-slug:${slug}`, 20, 60_000);
    const agent = sqlite.prepare("SELECT slug, display_name FROM agents WHERE slug = ? AND enabled = 1").get(slug);
    return c.json({ eligible: Boolean(agent), agent: agent ?? null });
  });
  publicApi.post("/checkout-context", async (c) => {
    rateLimit(clientIpRateLimitKey("checkout-context", c.req.raw.headers), 30, 60_000);
    const input = checkoutContextSchema.parse(await jsonBody(c.req.raw));
    rateLimit(`checkout-context-occurrence:${input.occurrence_id}`, 120, 10 * 60_000);
    return c.json(domain.checkoutContext({ occurrenceId: input.occurrence_id, promoCode: input.promo_code, referralSlug: input.referral_slug }));
  });
  publicApi.post("/checkouts", async (c) => {
    rateLimit(clientIpRateLimitKey("checkout", c.req.raw.headers), 20, 60_000);
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const keyHash = sha256(idempotencyKey);
    const existing = sqlite.prepare("SELECT 1 FROM checkout_idempotency WHERE idempotency_key_hash = ?").get(keyHash);
    const raw = await jsonBody(c.req.raw);
    // Keep the durable pause ahead of request-schema validation, while allowing
    // only the server-verified lease scope to reach the normal checkout path.
    const quoteId = raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { quote_id?: unknown }).quote_id === "string"
      ? (raw as { quote_id: string }).quote_id : undefined;
    const leaseScope = quoteId ? sqlite.prepare("SELECT occurrence_id, promo_id FROM quotes WHERE id = ?").get(quoteId) as { occurrence_id: string; promo_id: string | null } | undefined : undefined;
    if (!existing) domain.assertNewOrdersOpen(leaseScope ? { occurrence_id: leaseScope.occurrence_id, promo_id: leaseScope.promo_id, idempotency_key_hash: keyHash } : undefined);
    if (existing) return c.json(domain.replayCheckout(raw, idempotencyKey), 200);
    const input = checkoutRequestSchema.parse(raw);
    rateLimit(clientIpRateLimitKey("checkout-new", c.req.raw.headers), 3, 10 * 60_000);
    const quoteForLimit = sqlite.prepare("SELECT occurrence_id FROM quotes WHERE id = ?").get(input.quote_id) as { occurrence_id: string } | undefined;
    rateLimit(`checkout-email:${emailHash(input.customer_email)}:${quoteForLimit?.occurrence_id ?? input.quote_id}`, 2, 30 * 60_000);
    rateLimit(`checkout-reservation:${quoteForLimit?.occurrence_id ?? input.quote_id}`, 60, 10 * 60_000);
    const origin = process.env.COMMERCE_PUBLIC_ORIGIN ?? "https://flexperiment.ru";
    return c.json(await domain.checkoutAsync(input, idempotencyKey, origin, { ip: trustedClientIp(c.req.raw.headers), userAgent: c.req.header("User-Agent") ?? undefined }), existing ? 200 : 201);
  });
  publicApi.get("/checkout-status/:statusId", (c) => {
    rateLimit(clientIpRateLimitKey("checkout-status-ip", c.req.raw.headers), 60, 60_000); rateLimit(`checkout-status-id:${c.req.param("statusId")}`, 20, 60_000);
    return c.json(domain.checkoutStatus(c.req.param("statusId")));
  });
  publicApi.get("/ticket", (c) => {
    const authorization = c.req.header("Authorization");
    const capability = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!capability) throw new DomainError("TICKET_CAPABILITY_REQUIRED", 401);
    rateLimit(clientIpRateLimitKey("ticket-ip", c.req.raw.headers), 20, 60_000); rateLimit(`ticket-capability:${sha256(capability)}`, 5, 60_000);
    const ticket = sqlite.prepare(`SELECT t.id, t.status, o.id AS order_id, o.participant_age_band,
      COALESCE(o.participant_requires_adult_accompaniment, 0) AS requires_adult_accompaniment,
      oc.title, oc.starts_at, oc.timezone, oc.venue_name, oc.venue_address
      FROM tickets t JOIN bookings b ON b.id = t.booking_id JOIN orders o ON o.id = b.order_id JOIN occurrences oc ON oc.id = b.occurrence_id WHERE t.capability_hash = ?`).get(sha256(capability));
    if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
    c.header("Referrer-Policy", "no-referrer"); return c.json(ticket);
  });
  app.route("/v1/public", publicApi);

  app.post("/v1/webhooks/tochka", async (c) => {
    rateLimit(clientIpRateLimitKey("webhook", c.req.raw.headers), 600, 60_000);
    if (!c.req.header("content-type")?.startsWith("text/plain")) throw new DomainError("UNSUPPORTED_CONTENT_TYPE", 415);
    const body = await c.req.text();
    if (body.length > 65_536) throw new DomainError("PAYLOAD_TOO_LARGE", 413);
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(body)) throw new DomainError("TOCHKA_WEBHOOK_MALFORMED", 400);
    if (!tochkaVerifier || !(provider instanceof TochkaProvider)) throw new DomainError("TOCHKA_WEBHOOK_NOT_CONFIGURED", 503);
    let payload: Record<string, unknown>;
    try { payload = await tochkaVerifier.verify(body); } catch { throw new DomainError("TOCHKA_WEBHOOK_SIGNATURE_INVALID", 401); }
    const text = (field: string) => typeof payload[field] === "string" ? payload[field] : undefined;
    const operationId = text("operationId"); const paymentLinkId = text("paymentLinkId"); const customerCode = text("customerCode"); const merchantId = text("merchantId"); const paymentType = text("paymentType"); const status = text("status"); const webhookType = text("webhookType"); const currency = text("currency");
    if (!operationId || !paymentLinkId || !customerCode || !merchantId || !paymentType || !status || !webhookType) throw new DomainError("TOCHKA_WEBHOOK_SCHEMA_INVALID", 422);
    let amountKopecks: number;
    try { amountKopecks = webhookAmountKopecks(payload.amount); } catch { throw new DomainError("TOCHKA_WEBHOOK_SCHEMA_INVALID", 422); }
    const applied = domain.applyTochkaPaymentWebhook({ rawHash: sha256(body), operationId, paymentLinkId, amountKopecks, customerCode, merchantId, paymentType, status, webhookType, currency }, provider.config);
    return c.json({ accepted: true, duplicate: applied.duplicate }, 200);
  });

  // Unisender webhook/set verifies the URL with a parameterless GET.
  // Delivery callbacks are POST-only and always retain raw-body MD5 auth.
  app.get("/v1/webhooks/unisender", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true }, 200);
  });

  app.post("/v1/webhooks/unisender", async (c) => {
    rateLimit(clientIpRateLimitKey("unisender-webhook", c.req.raw.headers), 600, 60_000);
    if (!c.req.header("content-type")?.startsWith("application/json")) throw new DomainError("UNSUPPORTED_CONTENT_TYPE", 415);
    if (!unisenderConfig) throw new DomainError("UNISENDER_WEBHOOK_NOT_CONFIGURED", 503);
    const raw = await c.req.text();
    if (raw.length > 65_536) throw new DomainError("PAYLOAD_TOO_LARGE", 413);
    if (!verifyUnisenderWebhook(raw, unisenderConfig.apiKey)) throw new DomainError("UNISENDER_WEBHOOK_AUTH_INVALID", 401);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { throw new DomainError("INVALID_JSON", 400); }
    const users = Array.isArray(payload.events_by_user) ? payload.events_by_user : undefined;
    if (!users) throw new DomainError("UNISENDER_WEBHOOK_SCHEMA_INVALID", 422);
    let handled = 0;
    for (const user of users) {
      if (!user || typeof user !== "object") continue;
      const candidateEvents = (user as Record<string, unknown>).events;
      const events: unknown[] = Array.isArray(candidateEvents) ? candidateEvents : [];
      for (const event of events) {
        if (!event || typeof event !== "object") continue;
        const eventRecord = event as Record<string, unknown>;
        if (eventRecord.event_name !== "transactional_email_status" || !eventRecord.event_data || typeof eventRecord.event_data !== "object") continue;
        const data = eventRecord.event_data as Record<string, unknown>;
        const metadata = data.metadata as Record<string, unknown> | undefined;
        const outboxId = typeof metadata?.outbox_id === "string" ? metadata.outbox_id : undefined;
        const providerStatus = typeof data.status === "string" ? data.status : undefined;
        const status = providerStatus === "accepted" ? "ACCEPTED" : providerStatus === "sent" ? "SENT" : providerStatus === "delivered" ? "DELIVERED" : ["soft_bounced", "hard_bounced", "spam"].includes(providerStatus ?? "") ? "BOUNCED" : undefined;
        if (!outboxId || !status || !providerStatus || !["accepted", "sent", "delivered", "soft_bounced", "hard_bounced", "spam"].includes(providerStatus)) continue;
        const jobId = typeof data.job_id === "string" ? data.job_id : undefined;
        const semanticKey = `unisender:${sha256(canonicalWebhookPayload(data))}`;
        try { domain.applyUnisenderDelivery({ outboxId, status, providerStatus: providerStatus as "accepted" | "sent" | "delivered" | "soft_bounced" | "hard_bounced" | "spam", jobId, semanticKey }); handled += 1; } catch (error) { if (!(error instanceof DomainError) || error.code !== "UNISENDER_OUTBOX_NOT_FOUND") throw error; }
      }
    }
    return c.json({ accepted: true, handled }, 200);
  });

  const admin = new Hono<AppBindings>();
  admin.use("*", async (c, next) => {
    if (!assertAdminOrigin(c.req.header("Origin"))) throw new DomainError("ORIGIN_FORBIDDEN", 403);
    const session = parseSession(c.req.header("Cookie"));
    const activeSession = session && sqlite.prepare(`SELECT 1 FROM admin_sessions
      WHERE id = ? AND admin_id = ? AND revoked_at IS NULL AND expires_at > ?`).get(session.sid, session.sub, new Date().toISOString());
    if (!session || !activeSession) throw new DomainError("ADMIN_AUTH_REQUIRED", 401);
    noStore(c.res.headers);
    rateLimit(`admin:${session.sub}`, 120, 60_000); c.set("adminId", session.sub); c.set("adminSessionId", session.sid); await next();
    noStore(c.res.headers);
  });
  const audit = (adminId: string, action: string, type: string, entityId: string, details: unknown) => sqlite.prepare("INSERT INTO admin_audit_log(id, admin_id, action, entity_type, entity_id, details_json) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)").run(adminId, action, type, entityId, JSON.stringify(details, (key, value) => /email|inn|authorization|cookie|capability/i.test(key) ? "[REDACTED]" : value));
  admin.get("/session", (c) => c.json({ authenticated: true }));
  admin.get("/system/evidence", (c) => {
    const migration = sqlite.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: string; applied_at: string } | undefined;
    // SOURCE_COMMIT is trusted deployment metadata.  In development it may be
    // absent; consumers must treat null as unavailable rather than asserted.
    const sourceCommit = process.env.SOURCE_COMMIT?.trim() || null;
    return c.json({
      source_commit: sourceCommit,
      source_commit_evidence: sourceCommit ? "machine" : "unavailable",
      migration_head: migration ?? null,
      migration_evidence: migration ? "machine" : "unavailable",
      migration_versions: sqlite.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      active_legal_release: domain.legalConfig(),
      release_control: domain.releaseControlStatus(),
    });
  });
  admin.post("/logout", (c) => {
    // The middleware proved this session was active. Persist revocation before
    // returning so a copied pre-logout cookie cannot be replayed.
    sqlite.prepare("UPDATE admin_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(new Date().toISOString(), c.var.adminSessionId);
    c.header("Set-Cookie", adminSessionCookie("", 0));
    return c.json({ ok: true });
  });
  admin.post("/reauth", async (c) => {
    const payload = adminReauthSchema.parse(await jsonBody(c.req.raw));
    // Password verification needs much tighter limits than ordinary authenticated
    // admin traffic. Both dimensions are charged before verification so a wrong
    // password cannot be sprayed through one session or one source address.
    rateLimit(`admin-reauth-session:${c.var.adminSessionId!}`, 5, 10 * 60_000);
    rateLimit(clientIpRateLimitKey("admin-reauth-ip", c.req.raw.headers), 10, 10 * 60_000);
    if (!verifyAdminPassword(payload.password)) throw new DomainError("INVALID_CREDENTIALS", 401);
    const capability = publicId();
    const result = domain.createAdminReauth({ adminId: c.var.adminId!, sessionId: c.var.adminSessionId!, purpose: payload.purpose, resourceId: payload.resource_id, capability });
    audit(c.var.adminId!, "ADMIN_REAUTH_CREATED", "occurrence", payload.resource_id, { purpose: payload.purpose });
    return c.json({ capability, expires_at: result.expires_at });
  });
  admin.get("/dashboard", (c) => c.json({
    today: sqlite.prepare(`SELECT
      (SELECT COUNT(*) FROM orders WHERE date(created_at) = date('now')) AS orders,
      (SELECT COALESCE(SUM(o.amount_kopecks), 0) FROM orders o JOIN payments p ON p.order_id = o.id
        WHERE date(o.created_at) = date('now') AND p.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')) AS revenue_kopecks,
      (SELECT COALESCE(SUM(amount_kopecks), 0) FROM refunds WHERE date(created_at) = date('now') AND status = 'SUCCEEDED') AS refunded_kopecks`).get(),
    health: {
      create_unknown: sqlite.prepare("SELECT COUNT(*) AS count FROM payments WHERE state = 'CREATE_UNKNOWN'").get(),
      review_required_payments: sqlite.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'REVIEW_REQUIRED'").get(),
      review_required_refunds: sqlite.prepare("SELECT COUNT(*) AS count FROM refunds WHERE status = 'REVIEW_REQUIRED'").get(),
      pending_refunds: sqlite.prepare("SELECT COUNT(*) AS count FROM refunds WHERE status IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING')").get(),
      email_attention: { count: domain.emailAttentionCount() },
      operational_incidents: { count: domain.operationalIncidentCount() },
      provider_drift: sqlite.prepare("SELECT COUNT(*) AS count FROM provider_drift_reviews WHERE status = 'OPEN'").get(),
      stale_prepared_settlements: sqlite.prepare("SELECT COUNT(*) AS count FROM settlement_prepared_reviews WHERE status = 'OPEN'").get(),
    },
    sales_control: domain.salesControl(),
    upcoming: sqlite.prepare(`SELECT o.id, o.title, o.starts_at, o.capacity, o.sales_status, o.visibility, c.title AS city_title,
      o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) AS availability
      FROM occurrences o JOIN cities c ON c.id = o.city_id WHERE o.fulfillment_status = 'SCHEDULED' AND o.ends_at >= datetime('now') ORDER BY o.starts_at LIMIT 8`).all(),
  }));
  admin.get("/cities", (c) => c.json({ cities: sqlite.prepare(`SELECT c.id, c.slug, c.title, c.created_at, COUNT(o.id) AS occurrence_count
    FROM cities c LEFT JOIN occurrences o ON o.city_id = c.id GROUP BY c.id ORDER BY c.title`).all() }));
  admin.get("/cities/:id", (c) => {
    const city = sqlite.prepare("SELECT id, slug, title, created_at FROM cities WHERE id = ?").get(c.req.param("id"));
    if (!city) throw new DomainError("CITY_NOT_FOUND", 404);
    const occurrences = sqlite.prepare("SELECT id, title, starts_at, sales_status, visibility FROM occurrences WHERE city_id = ? ORDER BY starts_at DESC").all(c.req.param("id"));
    return c.json({ city, occurrences });
  });
  admin.get("/occurrences", (c) => {
    const cityId = c.req.query("city_id");
    return c.json({ occurrences: sqlite.prepare(`SELECT o.*, c.slug AS city_slug, c.title AS city_title,
      o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) AS availability
      FROM occurrences o JOIN cities c ON c.id = o.city_id ${cityId ? "WHERE o.city_id = ?" : ""} ORDER BY o.starts_at DESC`).all(...(cityId ? [cityId] : [])) });
  });
  admin.get("/occurrences/:id", (c) => {
    const occurrence = sqlite.prepare(`SELECT o.*, c.slug AS city_slug, c.title AS city_title,
      o.capacity - (SELECT COUNT(*) FROM bookings b WHERE b.occurrence_id = o.id AND b.status IN ('RESERVED', 'CONFIRMED')) AS availability
      FROM occurrences o JOIN cities c ON c.id = o.city_id WHERE o.id = ?`).get(c.req.param("id"));
    if (!occurrence) throw new DomainError("OCCURRENCE_NOT_FOUND", 404);
    return c.json(occurrence);
  });
  admin.get("/occurrences/:id/cancellation-financial-overview", (c) => c.json(domain.cancellationFinancialOverview(c.req.param("id"))));
  admin.get("/orders", (c) => {
    const filters: string[] = []; const params: string[] = [];
    const add = (query: string, column: string) => { const value = c.req.query(query); if (value) { filters.push(`${column} = ?`); params.push(value); } };
    add("city_id", "oc.city_id"); add("occurrence_id", "o.occurrence_id"); add("payment_status", "p.status"); add("payment_state", "p.state"); add("booking_status", "b.status");
    const from = c.req.query("from"); if (from) { filters.push("o.created_at >= ?"); params.push(from); }
    const to = c.req.query("to"); if (to) { filters.push("o.created_at < ?"); params.push(to); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return c.json({ orders: sqlite.prepare(`SELECT o.id, o.public_status_id, o.public_order_number, o.occurrence_id, o.customer_name, o.customer_email, o.participant_name, o.participant_age_band, o.participant_age_at_occurrence, o.participant_is_customer, o.participant_is_minor, o.participant_requires_adult_accompaniment, o.minor_legal_representative_confirmed_at, o.amount_kopecks, o.created_at,
      oc.title AS occurrence_title, c.id AS city_id, c.title AS city_title, p.state AS payment_state, p.status AS payment_status,
      b.status AS booking_status, (SELECT COUNT(*) FROM refunds r WHERE r.order_id = o.id) AS refund_count
      FROM orders o JOIN occurrences oc ON oc.id = o.occurrence_id JOIN cities c ON c.id = oc.city_id
      LEFT JOIN payments p ON p.order_id = o.id LEFT JOIN bookings b ON b.order_id = o.id ${where} ORDER BY o.created_at DESC LIMIT 100`).all(...params) });
  });
  admin.get("/orders/:id", (c) => { const order = sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(c.req.param("id")); if (!order) throw new DomainError("ORDER_NOT_FOUND", 404); return c.json(order); });
  admin.get("/orders/:id/evidence", (c) => { c.header("Cache-Control", "no-store"); return c.json(domain.orderEvidence(c.req.param("id"))); });
  admin.get("/email-attention", (c) => c.json({ incidents: domain.emailAttentionIncidents(), attention_count: domain.emailAttentionCount() }));
  admin.get("/operational-incidents", (c) => {
    const status = c.req.query("status");
    const filter = status === "OPEN" || status === "RESOLVED" ? status : undefined;
    return c.json({ incidents: domain.operationalIncidents(filter), open_count: domain.operationalIncidentCount() });
  });
  admin.post("/operational-incidents/:id/resolve", async (c) => {
    const payload = emailAttentionAcknowledgeSchema.parse(await jsonBody(c.req.raw));
    const incident = domain.resolveOperationalIncident(c.req.param("id"), payload.audit_context);
    audit(c.var.adminId!, "OPERATIONAL_INCIDENT_RESOLVED", "operational_incident", c.req.param("id"), { audit_context: payload.audit_context ?? null });
    return c.json(incident);
  });
  admin.post("/email-attention/:id/acknowledge", async (c) => {
    const payload = emailAttentionAcknowledgeSchema.parse(await jsonBody(c.req.raw));
    const result = domain.acknowledgeEmailAttention(c.req.param("id"), payload.audit_context);
    if (result.acknowledged_now) audit(c.var.adminId!, "EMAIL_ATTENTION_ACKNOWLEDGED", "email_outbox", c.req.param("id"), { audit_context: payload.audit_context ?? null });
    return c.json(result);
  });
  admin.post("/orders/:id/abandon-reservation", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = reservationAbandonSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.abandonReservation(c.req.param("id"), payload, key, c.var.adminId!));
  });
  admin.post("/notification-consent/withdraw", async (c) => {
    const payload = cityInterestWithdrawalSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.withdrawNotificationConsent(payload.email, payload.reason, c.var.adminId!));
  });
  admin.post("/city-interest/withdraw", async (c) => {
    const payload = cityInterestWithdrawalSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.withdrawCityInterest(payload.email, payload.reason, c.var.adminId!));
  });
  admin.get("/sales-control", (c) => c.json(domain.salesControl()));
  admin.post("/emergency-sales/pause", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    return c.json(domain.pauseEmergencySales(emergencySalesCommandSchema.parse(await jsonBody(c.req.raw)), c.var.adminId!, key));
  });
  admin.post("/emergency-sales/reopen", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    return c.json(domain.reopenEmergencySales(emergencySalesCommandSchema.parse(await jsonBody(c.req.raw)), c.var.adminId!, key));
  });
  admin.post("/cities", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = cityCreateSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.createCity(payload, key, c.var.adminId!), 201);
  });
  admin.patch("/cities/:id", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = cityPatchSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.patchCity(c.req.param("id"), payload, key, c.var.adminId!));
  });
  admin.post("/occurrences", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = occurrenceCreateSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.createOccurrence(payload, key, c.var.adminId!), 201);
  });
  admin.post("/occurrences/:id/complete", async (c) => {
    const payload = occurrenceCompleteSchema.parse(await jsonBody(c.req.raw));
    if (payload.confirmation_text !== `COMPLETE ${c.req.param("id")}`) throw new DomainError("CONFIRMATION_REQUIRED", 422);
    const occurrence = domain.completeOccurrence(c.req.param("id")); audit(c.var.adminId!, "OCCURRENCE_COMPLETED", "occurrence", c.req.param("id"), { reason: payload.reason }); return c.json(occurrence);
  });
  admin.post("/occurrences/:id/cancel", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = occurrenceCancelSchema.parse(await jsonBody(c.req.raw)); const occurrence = domain.cancelOccurrence(c.req.param("id"), { reason: payload.reason, reauthCapability: payload.reauth_capability }, key, c.var.adminId!, c.var.adminSessionId!);
    return c.json(occurrence);
  });
  admin.patch("/occurrences/:id", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = occurrencePatchSchema.parse(await jsonBody(c.req.raw)); const occurrence = domain.patchOccurrence(c.req.param("id"), payload, key, c.var.adminId!);
    return c.json(occurrence);
  });
  admin.get("/refunds", (c) => {
    const filters: string[] = []; const params: string[] = [];
    // status is repeatable (?status=A&status=B) so a destination filter can
    // express the same multi-state predicate a dashboard counter counted,
    // e.g. pending_refunds' IN ('REQUESTED', 'SUBMITTING', 'SUBMIT_UNKNOWN', 'RECONCILING').
    const statuses = c.req.queries("status"); if (statuses?.length) { filters.push(`r.status IN (${statuses.map(() => "?").join(", ")})`); params.push(...statuses); }
    const source = c.req.query("source"); if (source) { filters.push("r.source = ?"); params.push(source); }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    return c.json({ refunds: sqlite.prepare(`SELECT r.*, o.public_status_id, o.customer_name, o.customer_email,
      oc.title AS occurrence_title, c.title AS city_title FROM refunds r JOIN orders o ON o.id = r.order_id
      JOIN occurrences oc ON oc.id = o.occurrence_id JOIN cities c ON c.id = oc.city_id ${where} ORDER BY r.created_at DESC LIMIT 100`).all(...params) });
  });
  admin.get("/refunds/:id", (c) => { const refund = sqlite.prepare("SELECT * FROM refunds WHERE id = ?").get(c.req.param("id")); if (!refund) throw new DomainError("REFUND_NOT_FOUND", 404); return c.json(refund); });
  admin.get("/audit", (c) => c.json({ events: sqlite.prepare("SELECT id, action, entity_type, entity_id, details_json, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 200").all() }));
  admin.post("/bookings/:id/cancel-customer-initiated", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = customerCancellationSchema.parse(await jsonBody(c.req.raw)); const booking = domain.cancelCustomerBooking(c.req.param("id"), payload, key);
    audit(c.var.adminId!, "BOOKING_CANCELLED_BY_CUSTOMER_REQUEST", "booking", c.req.param("id"), { reason: payload.reason }); return c.json(booking);
  });
  admin.post("/orders/:orderId/refunds", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = compensationRefundSchema.parse(await jsonBody(c.req.raw)); const refund = domain.createCompensationRefund(c.req.param("orderId"), payload, key);
    audit(c.var.adminId!, "ADMIN_COMPENSATION_REFUND_REQUESTED", "refund", String(refund.id), { amount_kopecks: payload.amount_kopecks, reason: payload.reason }); return c.json(refund, 201);
  });
  admin.post("/payments/:id/reconcile", async (c) => { try { const payment = await domain.reconcilePayment(c.req.param("id")); audit(c.var.adminId!, "PAYMENT_RECONCILED", "payment", c.req.param("id"), {}); return c.json(payment); } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("PROVIDER_RECONCILIATION_UNAVAILABLE", 503); } });
  admin.post("/refunds/:id/reconcile", async (c) => { try { const refund = await domain.reconcileRefund(c.req.param("id")); audit(c.var.adminId!, "REFUND_RECONCILED", "refund", c.req.param("id"), {}); return c.json(refund); } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("PROVIDER_RECONCILIATION_UNAVAILABLE", 503); } });
  admin.post("/payments/:id/provider-reference", async (c) => { const payload = providerReferenceSchema.parse(await jsonBody(c.req.raw)); sqlite.prepare("UPDATE payments SET provider_payment_id = COALESCE(provider_payment_id, ?), updated_at = datetime('now') WHERE id = ?").run(payload.provider_reference, c.req.param("id")); audit(c.var.adminId!, "PAYMENT_PROVIDER_EVIDENCE_ATTACHED", "payment", c.req.param("id"), payload); try { return c.json(await domain.reconcilePayment(c.req.param("id"))); } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("PROVIDER_RECONCILIATION_UNAVAILABLE", 503); } });
  admin.post("/refunds/:id/provider-reference", async (c) => { const payload = providerReferenceSchema.parse(await jsonBody(c.req.raw)); sqlite.prepare("UPDATE refunds SET provider_reference = COALESCE(provider_reference, ?) WHERE id = ?").run(payload.provider_reference, c.req.param("id")); audit(c.var.adminId!, "REFUND_PROVIDER_EVIDENCE_ATTACHED", "refund", c.req.param("id"), payload); try { return c.json(await domain.reconcileRefund(c.req.param("id"))); } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError("PROVIDER_RECONCILIATION_UNAVAILABLE", 503); } });
  admin.get("/agents", (c) => c.json({ agents: domain.agentList() }));
  admin.post("/agents", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const raw = await jsonBody(c.req.raw) as Record<string, unknown>; const { audit_context, ...body } = raw;
    const payload = agentSchema.parse(body); const agent = domain.createAgentCommand(payload, key, c.var.adminId!, typeof audit_context === "string" ? audit_context : undefined);
    return c.json(agent, 201);
  });
  admin.patch("/agents/:id", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const raw = await jsonBody(c.req.raw) as Record<string, unknown>; if ("slug" in raw) throw new DomainError("IMMUTABLE_FIELD", 409);
    const { audit_context, ...body } = raw; const payload = agentPatchSchema.parse(body);
    const agent = domain.patchAgentCommand(c.req.param("id"), payload, key, c.var.adminId!, typeof audit_context === "string" ? audit_context : undefined);
    return c.json(agent);
  });
  admin.get("/agents/:id/balances", (c) => { const occurrenceId = c.req.query("occurrence_id"); if (!occurrenceId) throw new DomainError("OCCURRENCE_ID_REQUIRED", 400); return c.json(domain.rewardBalance(c.req.param("id"), occurrenceId)); });
  admin.get("/promo-codes", (c) => c.json({ promo_codes: domain.promoList() }));
  admin.post("/promo-codes", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const raw = await jsonBody(c.req.raw) as Record<string, unknown>; const { audit_context, ...body } = raw;
    const payload = promoSchema.parse(body); const promo = domain.createPromoCommand(payload, key, c.var.adminId!, typeof audit_context === "string" ? audit_context : undefined);
    return c.json(promo, 201);
  });
  admin.patch("/promo-codes/:id", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const raw = await jsonBody(c.req.raw) as Record<string, unknown>; if ("code" in raw) throw new DomainError("IMMUTABLE_FIELD", 409);
    const { audit_context, ...body } = raw; const payload = promoPatchSchema.parse(body);
    const promo = domain.patchPromoCommand(c.req.param("id"), payload, key, c.var.adminId!, typeof audit_context === "string" ? audit_context : undefined);
    return c.json(promo);
  });
  admin.post("/reward-settlements", async (c) => { const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400); const payload = settlementPrepareSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.prepareSettlement(payload, key, c.var.adminId!); audit(c.var.adminId!, "SETTLEMENT_PREPARED", "reward_settlement", String(settlement.id), payload); return c.json(settlement, 201); });
  admin.get("/reward-settlements", (c) => c.json({ settlements: domain.settlementList({ stalePrepared: c.req.query("stale_prepared") === "1" ? true : undefined }) }));
  admin.get("/reward-settlements/:id", (c) => c.json(domain.settlementDetail(c.req.param("id"))));
  admin.post("/reward-settlements/:id/payment-made", async (c) => { const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400); const payload = settlementPaymentMadeSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.markSettlementPaymentMade(c.req.param("id"), payload.confirmation_text, key, payload.reason); audit(c.var.adminId!, "SETTLEMENT_PAYMENT_MADE", "reward_settlement", c.req.param("id"), { reason: payload.reason }); return c.json(settlement); });
  admin.post("/reward-settlements/:id/documents-complete", async (c) => { const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400); const payload = settlementDocumentSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.completeSettlementDocuments(c.req.param("id"), payload, key); audit(c.var.adminId!, "SETTLEMENT_DOCUMENTS_COMPLETE", "reward_settlement", c.req.param("id"), {}); return c.json(settlement); });
  admin.post("/reward-settlements/:id/cancel-before-payment", async (c) => { const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400); const payload = settlementCancelSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.cancelSettlementBeforePayment(c.req.param("id"), payload, key); audit(c.var.adminId!, "SETTLEMENT_CANCELLED_BEFORE_PAYMENT", "reward_settlement", c.req.param("id"), { reason: payload.reason }); return c.json(settlement); });
  admin.post("/reward-settlements/:id/recoveries", async (c) => { const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400); const payload = settlementRecoverySchema.parse(await jsonBody(c.req.raw)); const recovery = domain.addSettlementRecovery(c.req.param("id"), payload, key); audit(c.var.adminId!, "SETTLEMENT_RECOVERY_RECORDED", "reward_settlement", c.req.param("id"), { amount_kopecks: payload.amount_recovered_kopecks, reason: payload.reason }); return c.json(recovery, 201); });
  admin.get("/provider-drift-reviews", (c) => c.json({ reviews: sqlite.prepare(`SELECT review.*, drift_refund.id AS refund_id, drift_refund.source AS refund_source,
    payment.id AS payment_id, payment.status AS payment_status, order_row.id AS order_id, order_row.public_order_number
    FROM provider_drift_reviews review
    LEFT JOIN refunds drift_refund ON review.entity_type = 'REFUND' AND drift_refund.id = review.entity_id
    LEFT JOIN payments payment ON payment.id = CASE
      WHEN review.entity_type = 'PAYMENT' THEN review.entity_id
      WHEN review.entity_type = 'REFUND' THEN drift_refund.payment_id
    END
    LEFT JOIN orders order_row ON order_row.id = payment.order_id
    WHERE review.status = 'OPEN' ORDER BY review.created_at DESC`).all() }));
  admin.post("/provider-drift-reviews/:id/resolve", async (c) => { const body = await jsonBody(c.req.raw) as { note?: string }; if (!body.note?.trim()) throw new DomainError("RESOLUTION_NOTE_REQUIRED", 422); const result = sqlite.prepare("UPDATE provider_drift_reviews SET status = 'RESOLVED', resolution_note = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'OPEN'").run(body.note.trim(), c.req.param("id")); if (!result.changes) throw new DomainError("DRIFT_REVIEW_NOT_OPEN", 409); audit(c.var.adminId!, "PROVIDER_DRIFT_RESOLVED", "provider_drift_review", c.req.param("id"), { note: body.note.trim() }); return c.json({ resolved: true }); });
  app.post("/v1/admin/login", async (c) => {
    if (!assertAdminOrigin(c.req.header("Origin"))) throw new DomainError("ORIGIN_FORBIDDEN", 403);
    rateLimit(clientIpRateLimitKey("login-15m", c.req.raw.headers), 5, 15 * 60_000); rateLimit(clientIpRateLimitKey("login-day", c.req.raw.headers), 20, 24 * 60 * 60_000);
    const body = await jsonBody(c.req.raw) as { password?: string }; if (!body.password || !verifyAdminPassword(body.password)) throw new DomainError("INVALID_CREDENTIALS", 401);
    const cookieValue = issueAdminSession();
    const session = parseSession(`fx_admin_session=${cookieValue}`)!;
    const now = new Date().toISOString();
    sqlite.transaction(() => {
      // Expired rows have no authorization value. Retain recently revoked rows
      // briefly for forensic continuity, then remove them opportunistically.
      sqlite.prepare("DELETE FROM admin_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(now, new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString());
      sqlite.prepare("INSERT INTO admin_sessions(id, admin_id, expires_at) VALUES (?, ?, ?)").run(session.sid, session.sub, new Date(session.exp).toISOString());
    })();
    c.header("Set-Cookie", adminSessionCookie(cookieValue, 43_200)); return c.json({ ok: true });
  });
  const releaseControl = new Hono();
  releaseControl.use("*", async (c, next) => {
    if (!verifyReleaseControlToken(c.req.header("Authorization"))) throw new DomainError("RELEASE_CONTROL_AUTH_REQUIRED", 401);
    noStore(c.res.headers);
    await next();
    noStore(c.res.headers);
  });
  releaseControl.get("/status", (c) => c.json({ ...domain.releaseControlStatus(), emergency_sales_paused: domain.emergencySalesPaused(), outbox_authority: domain.outboxAuthority(), runtime: domain.releaseRuntimeEvidence() }));
  releaseControl.get("/provider-readiness", async (c) => c.json(await domain.providerReadiness()));
  releaseControl.get("/outbox-authority", (c) => c.json(domain.outboxAuthority()));
  releaseControl.post("/outbox-dispatch/fence", async (c) => {
    const input = outboxDispatchFenceSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.fenceEmailDispatch(input, { release_id: input.release_id, generation: input.generation ?? null }));
  });
  releaseControl.post("/outbox-authority/activate", async (c) => {
    const input = outboxDispatchFenceSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.activateAttemptAuthority(input, { release_id: input.release_id, generation: input.generation ?? null }));
  });
  releaseControl.post("/outbox-dispatch/unfence", async (c) => {
    const input = outboxDispatchFenceSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.unfenceEmailDispatch(input, { release_id: input.release_id, generation: input.generation ?? null }));
  });
  releaseControl.get("/completion/:releaseId", (c) => c.json(domain.releaseControlCompletion(c.req.param("releaseId"))));
  releaseControl.post("/candidates/acquire", async (c) => c.json(domain.acquirePromoCandidate(await jsonBody(c.req.raw) as { head: import("./release-generation").GenerationHead })));
  releaseControl.post("/candidates/adopt", async (c) => c.json(domain.adoptPromoCandidate(await jsonBody(c.req.raw) as import("./release-control").CandidateAdoptRequest)));
  releaseControl.post("/candidates/phase", async (c) => c.json(domain.changePromoCandidatePhase(await jsonBody(c.req.raw) as import("./release-control").CandidatePhaseRequest)));
  releaseControl.post("/candidates/runtime-readiness-defect", async (c) => c.json(domain.markPromoCandidateRuntimeReadinessDefect(await jsonBody(c.req.raw) as import("./release-control").RuntimeReadinessDefectRequest)));
  releaseControl.get("/candidates/head/:releaseId", (c) => c.json(domain.releaseCandidateHead(c.req.param("releaseId"))));
  releaseControl.get("/certification-dispatch/:releaseId", (c) => c.json(domain.certificationDispatchEvidence(c.req.param("releaseId"))));
  releaseControl.get("/post-activation-email-provider-defect/:releaseId", (c) => c.json(domain.postActivationEmailProviderDefectEvidence(c.req.param("releaseId"))));
  releaseControl.post("/candidates/post-activation-email-provider-defect", async (c) =>
    c.json(domain.markPostActivationEmailProviderDefect(postActivationEmailProviderDefectSchema.parse(await jsonBody(c.req.raw)))));
  releaseControl.post("/candidates/pre-activation-defect", async (c) => {
    const input = preActivationDefectSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.markPreActivationDefect({ ...input, defect_code: input.defect_code ?? "" }));
  });
  releaseControl.post("/candidates/certification/activate", async (c) => c.json(domain.activatePromoCertificationLease(await jsonBody(c.req.raw) as import("./release-control").CertificationLeaseRequest)));
  releaseControl.post("/candidates/certification/certify", async (c) => c.json(domain.certifyPromoCandidate(await jsonBody(c.req.raw) as import("./release-control").CertificationEvidenceRequest)));
  releaseControl.post("/candidates/certification/retry", async (c) => c.json(domain.retryPromoCertification(await jsonBody(c.req.raw) as import("./release-control").CertificationRetryRequest)));
  releaseControl.post("/candidates/abort", async (c) => c.json(domain.abortPromoCandidate(await jsonBody(c.req.raw) as import("./release-control").CandidateAbortRequest)));
  releaseControl.post("/candidates/complete", async (c) => c.json(domain.completePromoCandidate(await jsonBody(c.req.raw) as import("./release-control").CandidateCompleteRequest)));
  releaseControl.post("/acquire", async (c) => c.json(domain.acquireReleaseControl(releaseControlSchema.parse(await jsonBody(c.req.raw)))));
  releaseControl.post("/pause", async (c) => c.json(domain.pauseNewOrders(releaseControlSchema.parse(await jsonBody(c.req.raw)))));
  releaseControl.post("/expectations", async (c) => c.json(domain.updateReleaseControlExpectations(releaseControlSchema.parse(await jsonBody(c.req.raw)))));
  releaseControl.post("/legal-publish", async (c) => c.json(domain.publishCandidateLegalRelease(releaseControlSchema.parse(await jsonBody(c.req.raw)))));
  releaseControl.post("/verify", async (c) => {
    const input = releaseControlSchema.parse(await jsonBody(c.req.raw));
    return c.json({ release_id: input.release_id, status: domain.releaseControlStatus(), runtime: domain.releaseRuntimeEvidence() });
  });
  releaseControl.get("/contract", (c) => c.json({
    participant_age_bands: ["ADULT", "MINOR_14_17", "MINOR_UNDER_14"],
    deprecated_date_of_birth_rejected: !checkoutRequestSchema.safeParse({
      quote_id: "00000000-0000-4000-8000-000000000000", customer_email: "buyer@example.test",
      customer_adult_confirmed: true, participant_age_band: "ADULT", participant: { date_of_birth: "1990-01-01" }, offer_accepted: true, pd_consent_accepted: true,
    }).success,
    deprecated_name_rejected: !checkoutRequestSchema.safeParse({
      quote_id: "00000000-0000-4000-8000-000000000000", customer_name: "Покупатель", customer_email: "buyer@example.test",
      customer_adult_confirmed: true, participant_age_band: "ADULT", offer_accepted: true, pd_consent_accepted: true,
    }).success,
  }));
  releaseControl.post("/reopen", async (c) => c.json(domain.reopenNewOrders(releaseControlSchema.parse(await jsonBody(c.req.raw)))));
  releaseControl.post("/complete-rolling", async (c) => {
    const input = completeRollingSchema.parse(await jsonBody(c.req.raw));
    // No DORMANT feature ships in PR1 for this predicate to check (Agent
    // Referrals lands in PR3-PR9), so this wiring fails closed until a real
    // feature-readiness reader replaces it - never treat "no feature yet" as
    // "ready".
    return c.json(domain.completeRolling(input, () => false));
  });
  const releaseControlHead = new Hono();
  releaseControlHead.use("*", async (c, next) => {
    if (!verifyReleaseControlToken(c.req.header("Authorization"))) throw new DomainError("RELEASE_CONTROL_AUTH_REQUIRED", 401);
    noStore(c.res.headers);
    await next();
    noStore(c.res.headers);
  });
  releaseControlHead.get("/candidates/head", (c) => c.json(domain.promoCandidateHead()));
  app.route("/v1/internal/release-control", releaseControl);
  app.route("/v1/admin/release-control", releaseControlHead);
  app.route("/v1/admin", admin);
  return app;
}
