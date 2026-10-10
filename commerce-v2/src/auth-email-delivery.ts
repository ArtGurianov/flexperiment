import { createHash } from "node:crypto";
import type { MagicLinkEmail } from "./auth";
import { loadCommerceOrigins } from "./origins";

type Environment = Readonly<Record<string, string | undefined>>;
type Refusal = "AUTH_EMAIL_NOT_CONFIGURED" | "AUTH_EMAIL_INPUT_INVALID" | "AUTH_EMAIL_REJECTED" | "AUTH_EMAIL_AMBIGUOUS";
export class AuthEmailDeliveryError extends Error {
  constructor(code: Refusal) { super(code); this.name = "AuthEmailDeliveryError"; }
}

const SEND_URL = "https://api.notisend.ru/v1/email/messages";
const MAX_RESPONSE_BYTES = 16_384;
const safeText = (value: string) => value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const emailAddress = (value: string) => value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && safeText(value);
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const required = (environment: Environment, key: string) => {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key}_REQUIRED`);
  if (!safeText(value)) throw new Error(`${key}_INVALID`);
  return value;
};

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
      parts.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Better Auth owns tokens/verification. This is only its transactional email transport.
 * One attempt, no automatic retry: NotiSend does not supply a durable send dedupe key.
 * Errors are fixed enums; never propagate provider bodies, recipients, URLs or transport exceptions.
 */
export function createMagicLinkEmailDelivery(environment: Environment = process.env, request: typeof fetch = fetch) {
  const production = environment.DEPLOY_ENV === "production";
  const provider = environment.AUTH_EMAIL_PROVIDER
    ?? (environment.AUTH_EMAIL_DELIVERY_ENDPOINT ? "http-relay" : "notisend");
  if (provider !== "notisend" && provider !== "http-relay") throw new Error("AUTH_EMAIL_PROVIDER_INVALID");
  const origins = loadCommerceOrigins(environment);
  const validate = ({ email, url }: MagicLinkEmail) => {
    try {
      const target = new URL(url);
      if (!emailAddress(email) || url.length > 8_192 || /[\u0000-\u001f\u007f-\u009f]/u.test(url)
        || target.username || target.password || target.hash
        || ![origins.platform, origins.lab].includes(target.origin)
        || target.pathname !== "/v1/auth/magic-link/verify" || !target.searchParams.get("token")) throw new Error();
    } catch { throw new AuthEmailDeliveryError("AUTH_EMAIL_INPUT_INVALID"); }
  };

  if (provider === "http-relay") {
    const endpoint = required(environment, "AUTH_EMAIL_DELIVERY_ENDPOINT");
    const parsed = new URL(endpoint);
    if (parsed.username || parsed.password || parsed.hash || (production && parsed.protocol !== "https:")
      || !["http:", "https:"].includes(parsed.protocol)) throw new Error("AUTH_EMAIL_DELIVERY_ENDPOINT_INVALID");
    return { configured: true, provider, send: async (message: MagicLinkEmail) => {
      validate(message);
      try {
        const response = await request(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json", ...(environment.AUTH_EMAIL_DELIVERY_TOKEN
            ? { authorization: `Bearer ${environment.AUTH_EMAIL_DELIVERY_TOKEN}` } : {}) },
          body: JSON.stringify({ type: "MAGIC_LINK", recipientEmail: message.email, url: message.url }),
        });
        await response.body?.cancel();
        if (response.status === 408 || response.status >= 500) throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
        if (!response.ok) throw new AuthEmailDeliveryError("AUTH_EMAIL_REJECTED");
      } catch (error) {
        if (error instanceof AuthEmailDeliveryError) throw error;
        throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
      }
    } };
  }

  if (!production && !environment.NOTISEND_API_KEY) {
    return { configured: false, provider, send: async () => { throw new AuthEmailDeliveryError("AUTH_EMAIL_NOT_CONFIGURED"); } };
  }
  const apiKey = required(environment, "NOTISEND_API_KEY");
  const fromEmail = required(environment, "NOTISEND_FROM_EMAIL");
  const fromName = required(environment, "NOTISEND_FROM_NAME");
  const replyTo = required(environment, "NOTISEND_REPLY_TO");
  if (!emailAddress(fromEmail) || !emailAddress(replyTo)) throw new Error("NOTISEND_SENDER_INVALID");

  return { configured: true, provider, send: async (message: MagicLinkEmail) => {
    validate(message);
    // Correlation only, not an idempotency/replay promise. Never send the plaintext token as metadata.
    const correlationKey = createHash("sha256").update(JSON.stringify(["MAGIC_LINK", message.email, message.url])).digest("hex");
    try {
      const response = await request(SEND_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          to: message.email, from_email: fromEmail, from_name: fromName,
          subject: "Вход в Flexperiment",
          text: `Войдите в Flexperiment по ссылке: ${message.url}\nСсылка действует 10 минут. Если вы не запрашивали вход, проигнорируйте письмо.`,
          html: `<html><body><p><a href="${htmlEscape(message.url)}">Войти в Flexperiment</a></p><p>Ссылка действует 10 минут. Если вы не запрашивали вход, проигнорируйте письмо.</p></body></html>`,
          smtp_headers: { "Reply-To": replyTo, "X-Flexperiment-Auth-Key": correlationKey },
          // No unsubscribe/suppression bypass, marketing activation, or legacy provider callbacks.
        }),
      });
      if (response.status === 408 || response.status >= 500) {
        await response.body?.cancel();
        throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AuthEmailDeliveryError("AUTH_EMAIL_REJECTED");
      }
      const payload = await boundedJson(response);
      if (payload.errors !== undefined || ["skipped", "soft_bounced", "hard_bounced"].includes(String(payload.status))) {
        throw new AuthEmailDeliveryError("AUTH_EMAIL_REJECTED");
      }
      const validId = (typeof payload.id === "number" && Number.isSafeInteger(payload.id) && payload.id > 0)
        || (typeof payload.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.id));
      if (!validId || !["queued", "sent", "delivered"].includes(String(payload.status))) {
        throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
      }
    } catch (error) {
      if (error instanceof AuthEmailDeliveryError) throw error;
      throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
    }
  } };
}
