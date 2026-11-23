import { createHash, randomUUID } from "node:crypto";
import type { MagicLinkEmail } from "./auth";
import { loadCommerceOrigins } from "./origins";
import { readNotiSendOutcome } from "./notisend-response";

type LinkEmail = MagicLinkEmail & { ticketLinks?: readonly string[] };
/** FLEX-120: a MY sign-in code. Never logged, persisted or used in correlation metadata. */
export type MyOtpEmail = { readonly email: string; readonly code: string };
type Purpose = "MAGIC_LINK" | "LAB_TICKET" | "MY_OTP";
type Message = LinkEmail | (MyOtpEmail & { url?: undefined; ticketLinks?: undefined });
type Environment = Readonly<Record<string, string | undefined>>;
type Refusal = "AUTH_EMAIL_NOT_CONFIGURED" | "AUTH_EMAIL_INPUT_INVALID" | "AUTH_EMAIL_REJECTED" | "AUTH_EMAIL_AMBIGUOUS";
export class AuthEmailDeliveryError extends Error {
  constructor(code: Refusal) { super(code); this.name = "AuthEmailDeliveryError"; }
}

const SEND_URL = "https://api.notisend.ru/v1/email/messages";
const safeText = (value: string) => value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const emailAddress = (value: string) => value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) && safeText(value);
const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const required = (environment: Environment, key: string) => {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key}_REQUIRED`);
  if (!safeText(value)) throw new Error(`${key}_INVALID`);
  return value;
};

/** Better Auth owns tokens/verification. This is only its transactional email transport.
 * One attempt, no automatic retry: NotiSend does not supply a durable send dedupe key.
 * Errors are fixed enums; never propagate provider bodies, recipients, URLs or transport exceptions.
 */
function createLinkEmailDelivery(environment: Environment, request: typeof fetch, purpose: Purpose) {
  const production = environment.DEPLOY_ENV === "production";
  const provider = environment.AUTH_EMAIL_PROVIDER
    ?? (environment.AUTH_EMAIL_DELIVERY_ENDPOINT ? "http-relay" : "notisend");
  if (provider !== "notisend" && provider !== "http-relay") throw new Error("AUTH_EMAIL_PROVIDER_INVALID");
  const origins = loadCommerceOrigins(environment);
  const validate = (message: Message) => {
    if (purpose === "MY_OTP") {
      const code = (message as MyOtpEmail).code;
      if (!emailAddress(message.email) || typeof code !== "string" || !/^\d{6}$/.test(code)) throw new AuthEmailDeliveryError("AUTH_EMAIL_INPUT_INVALID");
      return;
    }
    const { email, url } = message as LinkEmail;
    try {
      const target = new URL(url);
      if (!emailAddress(email) || url.length > 8_192 || /[\u0000-\u001f\u007f-\u009f]/u.test(url)
        || target.username || target.password
        || (purpose === "MAGIC_LINK"
          ? target.hash || ![origins.platform, origins.lab].includes(target.origin)
            || target.pathname !== "/v1/auth/magic-link/verify" || !target.searchParams.get("token")
          : target.origin !== origins.lab || target.pathname !== "/ticket" || target.search
            || !/^#recover=[A-Za-z0-9_-]{43}$/.test(target.hash))) throw new Error();
    } catch { throw new AuthEmailDeliveryError("AUTH_EMAIL_INPUT_INVALID"); }
  };

  if (provider === "http-relay") {
    const endpoint = required(environment, "AUTH_EMAIL_DELIVERY_ENDPOINT");
    const parsed = new URL(endpoint);
    if (parsed.username || parsed.password || parsed.hash || (production && parsed.protocol !== "https:")
      || !["http:", "https:"].includes(parsed.protocol)) throw new Error("AUTH_EMAIL_DELIVERY_ENDPOINT_INVALID");
    return { configured: true, provider, send: async (message: Message) => {
      validate(message);
      if (purpose === "LAB_TICKET") for (const url of message.ticketLinks ?? []) validate({ email: message.email, url });
      try {
        const relayBody = purpose === "MY_OTP" ? { type: purpose, recipientEmail: message.email, code: (message as MyOtpEmail).code }
          : { type: purpose, recipientEmail: message.email, url: message.url, ...(purpose === "LAB_TICKET" && message.ticketLinks ? { ticketLinks: message.ticketLinks } : {}) };
        const response = await request(endpoint, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json", ...(environment.AUTH_EMAIL_DELIVERY_TOKEN
            ? { authorization: `Bearer ${environment.AUTH_EMAIL_DELIVERY_TOKEN}` } : {}) },
          body: JSON.stringify(relayBody),
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

  return { configured: true, provider, send: async (message: Message) => {
    validate(message);
    if (purpose === "LAB_TICKET") for (const url of message.ticketLinks ?? []) validate({ email: message.email, url });
    // Correlation only, not an idempotency/replay promise. Never send the plaintext token as metadata.
    // A 6-digit code is brute-forceable from any hash, so MY_OTP correlation never includes it.
    const correlationKey = createHash("sha256").update(JSON.stringify(purpose === "MY_OTP"
      ? [purpose, message.email, randomUUID()] : [purpose, message.email, message.url])).digest("hex");
    const code = purpose === "MY_OTP" ? (message as MyOtpEmail).code : "";
    const content = purpose === "MY_OTP" ? {
      subject: "Код входа в Flexperiment",
      text: `Ваш код входа: ${code}\nКод действует 10 минут. Если вы не запрашивали вход, проигнорируйте письмо.`,
      html: `<html><body><p>Ваш код входа: <strong>${code}</strong></p><p>Код действует 10 минут. Если вы не запрашивали вход, проигнорируйте письмо.</p></body></html>`,
    } : {
      subject: purpose === "MAGIC_LINK" ? "Вход в Flexperiment" : "Ваш билет LAB",
      text: purpose === "LAB_TICKET" ? `Откройте билеты LAB: ${(message.ticketLinks ?? [message.url]).join("\n")}\nПодтвердите восстановление в течение 15 минут. Старый QR заменится; использованный билет не станет действительным снова.` : `Войдите в Flexperiment по ссылке: ${message.url}\nСсылка действует 10 минут. Если вы не запрашивали вход, проигнорируйте письмо.`,
      html: purpose === "LAB_TICKET" ? `<html><body>${(message.ticketLinks ?? [message.url!]).map(url => `<p><a href="${htmlEscape(url)}">Открыть билет LAB</a></p>`).join("")}<p>Подтвердите восстановление в течение 15 минут. Отметка о проходе сохраняется.</p></body></html>` : `<html><body><p><a href="${htmlEscape(message.url!)}">Войти в Flexperiment</a></p><p>Ссылка действует 10 минут. Если вы не запрашивали вход, проигнорируйте письмо.</p></body></html>`,
    };
    try {
      const response = await request(SEND_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          to: message.email, from_email: fromEmail, from_name: fromName,
          ...content,
          smtp_headers: { "Reply-To": replyTo, "X-Flexperiment-Auth-Key": correlationKey },
          // No unsubscribe/suppression bypass, marketing activation, or legacy provider callbacks.
        }),
      });
      const outcome = await readNotiSendOutcome(response);
      if (outcome !== "ACCEPTED") throw new AuthEmailDeliveryError(outcome === "REJECTED" ? "AUTH_EMAIL_REJECTED" : "AUTH_EMAIL_AMBIGUOUS");
    } catch (error) {
      if (error instanceof AuthEmailDeliveryError) throw error;
      throw new AuthEmailDeliveryError("AUTH_EMAIL_AMBIGUOUS");
    }
  } };
}

/** Separate URL allowlist and transactional content; no account or marketing consent is created. */
export const createLabTicketEmailDelivery = (environment: Environment = process.env, request: typeof fetch = fetch) =>
  createLinkEmailDelivery(environment, request, "LAB_TICKET");
export const createMagicLinkEmailDelivery = (environment: Environment = process.env, request: typeof fetch = fetch) =>
  createLinkEmailDelivery(environment, request, "MAGIC_LINK");
/** FLEX-120: same transport and refusals, a 6-digit code instead of a link. */
export const createMyOtpEmailDelivery = (environment: Environment = process.env, request: typeof fetch = fetch) =>
  createLinkEmailDelivery(environment, request, "MY_OTP") as { configured: boolean; provider: string; send: (message: MyOtpEmail) => Promise<void> };
