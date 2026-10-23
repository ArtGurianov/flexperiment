import type Database from "better-sqlite3";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import QRCode from "qrcode";
import { consumeLabLimit, labAccess, LabTicketError, labEmail, prepareLabRecovery, readLabTicket, redeemLabRecovery,
  reissueOwnedLabTicket, startLabGuest, assertLabCapability, capabilityHash, type LabTicketEmail } from "./lab-tickets";
import { listCustomerRefunds, requestRefund, type RefundReason } from "./refunds";
import type { ErasureRuntimeFence } from "./erasure-fence";

const noStore = { "Cache-Control": "no-store" };
export const labBearer = (context: Context) => context.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
export function registerLabGuestRoutes(parent: Hono, deps: {
  db: Database.Database; origin: string; now: () => Date;
  requestSource: (context: Context) => string | undefined;
  authenticateCustomer?: (headers: Headers) => Promise<string | null>;
  sendLabTicketEmail?: (message: LabTicketEmail) => Promise<void>;
  erasureFence?: ErasureRuntimeFence;
  retireCheckout: (orderPublicId: string) => Promise<{ restartAllowed: true }>;
}) {
  const app = new Hono();
  app.onError((error, c) => c.json({ code: error instanceof LabTicketError ? error.message : "LAB_REQUEST_UNAVAILABLE" }, error instanceof LabTicketError ? 409 : 503, noStore));
  const accessFor = (c: Context) => {
    const access = labAccess(deps.db, labBearer(c));
    deps.erasureFence?.assertIdentity({ customerId: access.customer_id }, "ACCOUNT");
    return access;
  };
  app.use("/v1/lab/guest/*", bodyLimit({ maxSize: 8192, onError: c => c.json({ code: "LAB_INPUT_TOO_LARGE" }, 413, noStore) }));
  app.use("/v1/lab/guest/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.header("origin") !== deps.origin) return c.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    try { await next(); }
    catch (error) {
      return c.json({ code: error instanceof LabTicketError ? error.message : "LAB_REQUEST_UNAVAILABLE" }, error instanceof LabTicketError ? 409 : 503, noStore);
    }
  });
  app.post("/v1/lab/guest/start", async c => {
    const body = await c.req.json<{ email: unknown; accessToken: unknown }>();
    const email = labEmail(body.email), time = deps.now().toISOString();
    deps.erasureFence?.assertIdentity({ email }, "AUTH_MAIL");
    const source = deps.requestSource(c);
    if (!source) return c.json({ code: "LAB_SOURCE_UNAVAILABLE" }, 503, noStore);
    const token = assertLabCapability(body.accessToken);
    const result = deps.db.transaction(() => {
      // Capability/email replay creates nothing and consumes no creation quota. Keep lookup, quota
      // and creation under one write lock; rotating tokens/emails still charges trusted-source limits.
      const existing = deps.db.prepare("SELECT 1 FROM lab_guest_access WHERE token_sha256=?").get(capabilityHash(token));
      if (!existing && (!consumeLabLimit(deps.db, "start-source", source, 30, time)
        || !consumeLabLimit(deps.db, "start-source-email", JSON.stringify([source, email]), 10, time))) return null;
      return startLabGuest(deps.db, body, time);
    }).immediate();
    return result ? c.json(result, 201, noStore) : c.json({ code: "LAB_RATE_LIMITED" }, 429, noStore);
  });
  app.post("/v1/lab/guest/restart", async c => {
    const access = accessFor(c);
    try { return c.json(await deps.retireCheckout(access.order_public_id), 200, noStore); }
    catch { return c.json({ code: "LAB_CHECKOUT_RESTART_UNSAFE" }, 409, noStore); }
  });
  app.get("/v1/lab/guest/ticket", async c => {
    accessFor(c);
    const ticket = readLabTicket(deps.db, labBearer(c));
    return c.json({ ...ticket, ...("qrToken" in ticket && ticket.qrToken ? { qrImage: await QRCode.toDataURL(ticket.qrToken, { errorCorrectionLevel: "M", margin: 4, width: 320 }) } : {}) }, 200, noStore);
  });
  app.post("/v1/lab/guest/recover", async c => {
    if (!deps.sendLabTicketEmail) return c.json({ code: "LAB_EMAIL_UNAVAILABLE" }, 503, noStore);
    const body = await c.req.json<{ email: unknown; orderPublicId?: string }>();
    const email = labEmail(body.email), time = deps.now().toISOString();
    if (body.orderPublicId !== undefined && (typeof body.orderPublicId !== "string" || body.orderPublicId.length > 128)) throw new LabTicketError("LAB_INPUT_INVALID");
    // Same public acknowledgement for absent, throttled, suppressed and delivery-failed requests.
    const source = deps.requestSource(c);
    if (!source) return c.json({ code: "LAB_SOURCE_UNAVAILABLE" }, 503, noStore);
    const allowed = consumeLabLimit(deps.db, "recovery-source", source, 10, time)
      && consumeLabLimit(deps.db, "recovery-source-email", JSON.stringify([source, email]), 3, time);
    if (allowed) {
      try {
        deps.erasureFence?.assertIdentity({ email }, "AUTH_MAIL");
        const suppressed = deps.db.prepare("SELECT 1 FROM email_suppressions WHERE email_normalized=? AND removed_at IS NULL").get(email);
        if (!suppressed) {
          const orders = body.orderPublicId ? [{ order_public_id: body.orderPublicId }] : deps.db.prepare(`SELECT access.order_public_id
            FROM lab_guest_access access JOIN customers customer ON customer.id=access.customer_id
            JOIN orders ON orders.public_id=access.order_public_id WHERE customer.email_normalized=?
            ORDER BY access.created_at DESC LIMIT 20`).all(email) as Array<{ order_public_id: string }>;
          const messages = orders.map(order => prepareLabRecovery(deps.db, email, order.order_public_id, deps.origin, time)).filter(message => message !== null);
          if (messages.length) await deps.sendLabTicketEmail({ ...messages[0], ticketLinks: messages.map(message => message.url) });
        }
      } catch { /* Never log the email/link/provider body or retry an unknown delivery. */ }
    }
    return c.json({ accepted: true }, 202, noStore);
  });
  app.post("/v1/lab/guest/recover/confirm", async c => {
    const body = await c.req.json<{ recoveryToken: string; accessToken: string }>();
    const result = deps.db.transaction(() => {
      const result = redeemLabRecovery(deps.db, body.recoveryToken, body.accessToken, deps.now().toISOString());
      const access = labAccess(deps.db, body.accessToken);
      deps.erasureFence?.assertIdentity({ customerId: access.customer_id }, "ACCOUNT");
      return result;
    }).immediate();
    return c.json(result, 200, noStore);
  });
  app.post("/v1/lab/guest/reissue", async c => {
    const customerId = await deps.authenticateCustomer?.(c.req.raw.headers);
    if (!customerId) return c.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    const body = await c.req.json<{ orderPublicId: string; accessToken: string }>();
    return c.json(reissueOwnedLabTicket(deps.db, customerId, body.orderPublicId, body.accessToken, deps.now().toISOString()), 200, noStore);
  });
  app.get("/v1/lab/guest/refunds", c => {
    const access = accessFor(c);
    return c.json({ refunds: (listCustomerRefunds(deps.db, access.customer_id) as Array<{ orderPublicId: string }>).filter(refund => refund.orderPublicId === access.order_public_id) }, 200, noStore);
  });
  app.post("/v1/lab/guest/refunds", async c => {
    const access = accessFor(c);
    const body = await c.req.json<{ reasonCode: RefundReason; customerNote?: string }>();
    if (!c.req.header("idempotency-key")?.trim()) throw new LabTicketError("IDEMPOTENCY_KEY_REQUIRED");
    const result = requestRefund(deps.db, { customerId: access.customer_id, orderPublicId: access.order_public_id,
      reasonCode: body.reasonCode, customerNote: body.customerNote, idempotencyKey: `${access.order_public_id}:refund:${c.req.header("idempotency-key") ?? ""}` }, deps.now().toISOString());
    return c.json(result, 201, noStore);
  });
  parent.route("/", app);
}
