import { Hono } from "hono";
import { ZodError } from "zod";
import type { Sqlite } from "./db";
import { assertAdminOrigin, makeSession, parseSession, verifyAdminPassword } from "./auth";
import { emailHash, sha256 } from "./crypto";
import { CommerceDomain, DomainError } from "./domain";
import { type EmailProvider, UnconfiguredEmailProvider, UnisenderGoProvider } from "./email-provider";
import { TochkaProvider, type PaymentProvider } from "./provider";
import { clientIp, rateLimit } from "./rate-limit";
import { TochkaWebhookVerifier, webhookAmountKopecks } from "./tochka-webhook";
import { verifyUnisenderWebhook } from "./unisender-webhook";
import { agentPatchSchema, agentSchema, checkoutContextSchema, checkoutRequestSchema, cityCreateSchema, compensationRefundSchema, customerCancellationSchema, occurrenceCancelSchema, occurrenceCompleteSchema, occurrenceCreateSchema, occurrencePatchSchema, promoPatchSchema, promoSchema, providerReferenceSchema, settlementCancelSchema, settlementDocumentSchema, settlementPaymentMadeSchema, settlementPrepareSchema, settlementRecoverySchema } from "./types";

type AppBindings = { Variables: { adminId?: string } };
const noStore = (headers: Headers) => headers.set("Cache-Control", "no-store");
const publicBrowserOrigin = () => process.env.COMMERCE_PUBLIC_ORIGIN ?? "https://flexperiment.ru";
const canonicalWebhookPayload = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalWebhookPayload).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalWebhookPayload(entry)}`).join(",")}}`;
  return JSON.stringify(value);
};

const jsonBody = async (request: Request) => {
  try { return await request.json(); } catch { throw new DomainError("INVALID_JSON", 400); }
};

export function createApp(sqlite: Sqlite, provider: PaymentProvider, emailProvider: EmailProvider = new UnconfiguredEmailProvider()) {
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
  publicApi.get("/tour", (c) => { rateLimit(`tour:${clientIp(c.req.raw.headers)}`, 120, 60_000); return c.json({ cities: domain.tour() }); });
  publicApi.get("/cities/:city/occurrences", (c) => {
    rateLimit(`occurrences:${clientIp(c.req.raw.headers)}`, 120, 60_000);
    const entries = domain.tour().filter((item) => item.city === c.req.param("city") && item.id);
    return c.json({ occurrences: entries });
  });
  publicApi.get("/occurrences/:id", (c) => { rateLimit(`occurrence:${clientIp(c.req.raw.headers)}`, 120, 60_000); return c.json(domain.occurrence(c.req.param("id"))); });
  publicApi.get("/legal-config", (c) => c.json(domain.legalConfig()));
  publicApi.post("/referrals/eligibility", async (c) => {
    const ip = clientIp(c.req.raw.headers); rateLimit(`referral:${ip}`, 60, 60_000);
    const input = await jsonBody(c.req.raw) as { slug?: string };
    const slug = input.slug?.trim() ?? ""; rateLimit(`referral-slug:${slug}`, 20, 60_000);
    const agent = sqlite.prepare("SELECT slug, display_name FROM agents WHERE slug = ? AND enabled = 1").get(slug);
    return c.json({ eligible: Boolean(agent), agent: agent ?? null });
  });
  publicApi.post("/checkout-context", async (c) => {
    rateLimit(`checkout-context:${clientIp(c.req.raw.headers)}`, 30, 60_000);
    const input = checkoutContextSchema.parse(await jsonBody(c.req.raw));
    rateLimit(`checkout-context-occurrence:${input.occurrence_id}`, 120, 10 * 60_000);
    return c.json(domain.checkoutContext({ occurrenceId: input.occurrence_id, promoCode: input.promo_code, referralSlug: input.referral_slug }));
  });
  publicApi.post("/checkouts", async (c) => {
    const ip = clientIp(c.req.raw.headers); rateLimit(`checkout:${ip}`, 20, 60_000);
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const input = checkoutRequestSchema.parse(await jsonBody(c.req.raw));
    const keyHash = sha256(idempotencyKey);
    const existing = sqlite.prepare("SELECT 1 FROM checkout_idempotency WHERE idempotency_key_hash = ?").get(keyHash);
    if (!existing) {
      rateLimit(`checkout-new:${ip}`, 3, 10 * 60_000);
      const quoteForLimit = sqlite.prepare("SELECT occurrence_id FROM quotes WHERE id = ?").get(input.quote_id) as { occurrence_id: string } | undefined;
      rateLimit(`checkout-email:${emailHash(input.customer_email)}:${quoteForLimit?.occurrence_id ?? input.quote_id}`, 2, 30 * 60_000);
      rateLimit(`checkout-reservation:${quoteForLimit?.occurrence_id ?? input.quote_id}`, 60, 10 * 60_000);
    }
    const origin = process.env.COMMERCE_PUBLIC_ORIGIN ?? "https://flexperiment.ru";
    return c.json(await domain.checkoutAsync(input, idempotencyKey, origin), existing ? 200 : 201);
  });
  publicApi.get("/checkout-status/:statusId", (c) => {
    const ip = clientIp(c.req.raw.headers); rateLimit(`checkout-status-ip:${ip}`, 60, 60_000); rateLimit(`checkout-status-id:${c.req.param("statusId")}`, 20, 60_000);
    return c.json(domain.checkoutStatus(c.req.param("statusId")));
  });
  publicApi.get("/ticket", (c) => {
    const authorization = c.req.header("Authorization");
    const capability = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!capability) throw new DomainError("TICKET_CAPABILITY_REQUIRED", 401);
    const ip = clientIp(c.req.raw.headers); rateLimit(`ticket-ip:${ip}`, 20, 60_000); rateLimit(`ticket-capability:${sha256(capability)}`, 5, 60_000);
    const ticket = sqlite.prepare(`SELECT t.id, t.status, o.id AS order_id, oc.title, oc.starts_at, oc.timezone, oc.venue_name, oc.venue_address
      FROM tickets t JOIN bookings b ON b.id = t.booking_id JOIN orders o ON o.id = b.order_id JOIN occurrences oc ON oc.id = b.occurrence_id WHERE t.capability_hash = ?`).get(sha256(capability));
    if (!ticket) throw new DomainError("TICKET_NOT_FOUND", 404);
    c.header("Referrer-Policy", "no-referrer"); return c.json(ticket);
  });
  app.route("/v1/public", publicApi);

  app.post("/v1/webhooks/tochka", async (c) => {
    rateLimit(`webhook:${clientIp(c.req.raw.headers)}`, 600, 60_000);
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

  app.post("/v1/webhooks/unisender", async (c) => {
    rateLimit(`unisender-webhook:${clientIp(c.req.raw.headers)}`, 600, 60_000);
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
        if (!outboxId || !status) continue;
        const jobId = typeof data.job_id === "string" ? data.job_id : undefined;
        const semanticKey = `unisender:${sha256(canonicalWebhookPayload(data))}`;
        try { domain.applyUnisenderDelivery({ outboxId, status, jobId, semanticKey }); handled += 1; } catch (error) { if (!(error instanceof DomainError) || error.code !== "UNISENDER_OUTBOX_NOT_FOUND") throw error; }
      }
    }
    return c.json({ accepted: true, handled }, 200);
  });

  const admin = new Hono<AppBindings>();
  admin.use("*", async (c, next) => {
    if (!assertAdminOrigin(c.req.header("Origin"))) throw new DomainError("ORIGIN_FORBIDDEN", 403);
    const session = parseSession(c.req.header("Cookie"));
    if (!session) throw new DomainError("ADMIN_AUTH_REQUIRED", 401);
    rateLimit(`admin:${session.sub}`, 120, 60_000); c.set("adminId", session.sub); await next();
  });
  const audit = (adminId: string, action: string, type: string, entityId: string, details: unknown) => sqlite.prepare("INSERT INTO admin_audit_log(id, admin_id, action, entity_type, entity_id, details_json) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)").run(adminId, action, type, entityId, JSON.stringify(details, (key, value) => /email|inn|authorization|cookie|capability/i.test(key) ? "[REDACTED]" : value));
  admin.get("/orders", (c) => c.json({ orders: sqlite.prepare("SELECT id, public_status_id, occurrence_id, amount_kopecks, created_at FROM orders ORDER BY created_at DESC LIMIT 100").all() }));
  admin.get("/orders/:id", (c) => { const order = sqlite.prepare("SELECT * FROM orders WHERE id = ?").get(c.req.param("id")); if (!order) throw new DomainError("ORDER_NOT_FOUND", 404); return c.json(order); });
  admin.post("/cities", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = cityCreateSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.createCity(payload, key, c.var.adminId!), 201);
  });
  admin.post("/occurrences", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = occurrenceCreateSchema.parse(await jsonBody(c.req.raw));
    return c.json(domain.createOccurrence(payload, key, c.var.adminId!), 201);
  });
  admin.post("/occurrences/:id/complete", async (c) => {
    const payload = occurrenceCompleteSchema.parse(await jsonBody(c.req.raw));
    if (payload.confirmation_text !== `COMPLETE ${c.req.param("id")}`) throw new DomainError("CONFIRMATION_REQUIRED", 422);
    const occurrence = domain.completeOccurrence(c.req.param("id")); audit(c.var.adminId!, "OCCURRENCE_COMPLETED", "occurrence", c.req.param("id"), {}); return c.json(occurrence);
  });
  admin.post("/occurrences/:id/cancel", async (c) => {
    const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400);
    const payload = occurrenceCancelSchema.parse(await jsonBody(c.req.raw)); const occurrence = domain.cancelOccurrence(c.req.param("id"), payload, key);
    audit(c.var.adminId!, "OCCURRENCE_CANCELLED", "occurrence", c.req.param("id"), { reason: payload.reason }); return c.json(occurrence);
  });
  admin.patch("/occurrences/:id", async (c) => {
    const payload = occurrencePatchSchema.parse(await jsonBody(c.req.raw)); const occurrence = domain.patchOccurrence(c.req.param("id"), payload);
    audit(c.var.adminId!, "OCCURRENCE_EDITED", "occurrence", c.req.param("id"), { reason: payload.reason }); return c.json(occurrence);
  });
  admin.get("/refunds", (c) => c.json({ refunds: sqlite.prepare("SELECT * FROM refunds ORDER BY created_at DESC LIMIT 100").all() }));
  admin.get("/refunds/:id", (c) => { const refund = sqlite.prepare("SELECT * FROM refunds WHERE id = ?").get(c.req.param("id")); if (!refund) throw new DomainError("REFUND_NOT_FOUND", 404); return c.json(refund); });
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
  admin.post("/agents", async (c) => { const payload = agentSchema.parse(await jsonBody(c.req.raw)); const agent = domain.createAgent(payload); audit(c.var.adminId!, "AGENT_CREATED", "agent", String(agent.id), {}); return c.json(agent, 201); });
  admin.patch("/agents/:id", async (c) => { const payload = agentPatchSchema.parse(await jsonBody(c.req.raw)); const agent = domain.patchAgent(c.req.param("id"), payload); audit(c.var.adminId!, "AGENT_EDITED", "agent", c.req.param("id"), payload); return c.json(agent); });
  admin.get("/agents/:id/balances", (c) => { const occurrenceId = c.req.query("occurrence_id"); if (!occurrenceId) throw new DomainError("OCCURRENCE_ID_REQUIRED", 400); return c.json(domain.rewardBalance(c.req.param("id"), occurrenceId)); });
  admin.post("/promo-codes", async (c) => { const payload = promoSchema.parse(await jsonBody(c.req.raw)); const promo = domain.createPromo(payload); audit(c.var.adminId!, "PROMO_CREATED", "promo", String(promo.id), {}); return c.json(promo, 201); });
  admin.patch("/promo-codes/:id", async (c) => { const payload = promoPatchSchema.parse(await jsonBody(c.req.raw)); const promo = domain.patchPromo(c.req.param("id"), payload); audit(c.var.adminId!, "PROMO_EDITED", "promo", c.req.param("id"), payload); return c.json(promo); });
  admin.post("/reward-settlements", async (c) => { const key = c.req.header("Idempotency-Key"); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", 400); const payload = settlementPrepareSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.prepareSettlement(payload, key, c.var.adminId!); audit(c.var.adminId!, "SETTLEMENT_PREPARED", "reward_settlement", String(settlement.id), payload); return c.json(settlement, 201); });
  admin.post("/reward-settlements/:id/payment-made", async (c) => { const payload = settlementPaymentMadeSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.markSettlementPaymentMade(c.req.param("id"), payload.confirmation_text); audit(c.var.adminId!, "SETTLEMENT_PAYMENT_MADE", "reward_settlement", c.req.param("id"), {}); return c.json(settlement); });
  admin.post("/reward-settlements/:id/documents-complete", async (c) => { const payload = settlementDocumentSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.completeSettlementDocuments(c.req.param("id"), payload); audit(c.var.adminId!, "SETTLEMENT_DOCUMENTS_COMPLETE", "reward_settlement", c.req.param("id"), {}); return c.json(settlement); });
  admin.post("/reward-settlements/:id/cancel-before-payment", async (c) => { const payload = settlementCancelSchema.parse(await jsonBody(c.req.raw)); const settlement = domain.cancelSettlementBeforePayment(c.req.param("id"), payload); audit(c.var.adminId!, "SETTLEMENT_CANCELLED_BEFORE_PAYMENT", "reward_settlement", c.req.param("id"), { reason: payload.reason }); return c.json(settlement); });
  admin.post("/reward-settlements/:id/recoveries", async (c) => { const payload = settlementRecoverySchema.parse(await jsonBody(c.req.raw)); const recovery = domain.addSettlementRecovery(c.req.param("id"), payload); audit(c.var.adminId!, "SETTLEMENT_RECOVERY_RECORDED", "reward_settlement", c.req.param("id"), { amount_kopecks: payload.amount_recovered_kopecks }); return c.json(recovery, 201); });
  admin.get("/provider-drift-reviews", (c) => c.json({ reviews: sqlite.prepare("SELECT * FROM provider_drift_reviews WHERE status = 'OPEN' ORDER BY created_at DESC").all() }));
  admin.post("/provider-drift-reviews/:id/resolve", async (c) => { const body = await jsonBody(c.req.raw) as { note?: string }; if (!body.note?.trim()) throw new DomainError("RESOLUTION_NOTE_REQUIRED", 422); const result = sqlite.prepare("UPDATE provider_drift_reviews SET status = 'RESOLVED', resolution_note = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'OPEN'").run(body.note.trim(), c.req.param("id")); if (!result.changes) throw new DomainError("DRIFT_REVIEW_NOT_OPEN", 409); audit(c.var.adminId!, "PROVIDER_DRIFT_RESOLVED", "provider_drift_review", c.req.param("id"), { note: body.note.trim() }); return c.json({ resolved: true }); });
  app.post("/v1/admin/login", async (c) => {
    if (!assertAdminOrigin(c.req.header("Origin"))) throw new DomainError("ORIGIN_FORBIDDEN", 403);
    const ip = clientIp(c.req.raw.headers); rateLimit(`login-15m:${ip}`, 5, 15 * 60_000); rateLimit(`login-day:${ip}`, 20, 24 * 60 * 60_000);
    const body = await jsonBody(c.req.raw) as { password?: string }; if (!body.password || !verifyAdminPassword(body.password)) throw new DomainError("INVALID_CREDENTIALS", 401);
    c.header("Set-Cookie", `fx_admin_session=${makeSession()}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`); return c.json({ ok: true });
  });
  app.route("/v1/admin", admin);
  return app;
}
