import { createHash } from "node:crypto";
import type { LabInterestEmail } from "./lab-interest";

/**
 * FLEX-8 mail adapter for LAB interest: the double opt-in confirmation (service mail, no advertising)
 * and the single sales-opened notice. It reads the same NotiSend settings as the transactional
 * transport (auth-email-delivery.ts, not modified) and is configured only when all of them are
 * present; otherwise the server leaves sendLabInterestEmail unset and signups are refused unstored.
 * One attempt, no retry; errors are fixed codes and never carry the address, link or provider body.
 */
type Environment = Readonly<Record<string, string | undefined>>;
export class LabInterestMailError extends Error {
  constructor(code: "LAB_INTEREST_MAIL_REJECTED" | "LAB_INTEREST_MAIL_AMBIGUOUS" | "LAB_INTEREST_MAIL_INPUT_INVALID") {
    super(code); this.name = "LabInterestMailError";
  }
}

const SEND_URL = "https://api.notisend.ru/v1/email/messages";
const safe = (value: string | undefined) => Boolean(value && value.length <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const address = (value: string | undefined) => safe(value) && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value!);
const html = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function labInterestMailContent(message: LabInterestEmail) {
  if (message.kind === "CONFIRM") {
    const where = message.cityTitle ? ` (${message.cityTitle})` : "";
    return {
      subject: "Подтвердите предзапись Flexperiment LAB",
      text: `Подтвердите, что хотите получить одно уведомление о старте продаж Flexperiment LAB${where}: ${message.confirmUrl}\n`
        + "Ссылка действует 48 часов. Предзапись не резервирует место и не является покупкой билета.\n"
        + `Если вы не оставляли заявку, проигнорируйте письмо или откажитесь: ${message.withdrawUrl}`,
      html: `<html><body><p><a href="${html(message.confirmUrl)}">Подтвердить предзапись Flexperiment LAB${html(where)}</a></p>`
        + "<p>Ссылка действует 48 часов. Предзапись не резервирует место и не является покупкой билета.</p>"
        + `<p>Если вы не оставляли заявку, проигнорируйте письмо или <a href="${html(message.withdrawUrl)}">откажитесь</a>.</p></body></html>`,
      headers: {},
    };
  }
  return {
    subject: message.subject,
    text: `${message.message}\n${message.storefrontUrl}\n\nОтказаться от уведомлений: ${message.withdrawUrl}`,
    html: `<html><body><p>${html(message.message)}</p><p><a href="${html(message.storefrontUrl)}">Flexperiment LAB</a></p>`
      + `<p><a href="${html(message.withdrawUrl)}">Отказаться от уведомлений</a></p></body></html>`,
    headers: message.headers,
  };
}

export function createLabInterestMailDelivery(environment: Environment = process.env, request: typeof fetch = fetch) {
  const apiKey = environment.NOTISEND_API_KEY?.trim(), fromEmail = environment.NOTISEND_FROM_EMAIL?.trim();
  const fromName = environment.NOTISEND_FROM_NAME?.trim(), replyTo = environment.NOTISEND_REPLY_TO?.trim();
  const relay = (environment.AUTH_EMAIL_PROVIDER ?? (environment.AUTH_EMAIL_DELIVERY_ENDPOINT ? "http-relay" : "notisend")) !== "notisend";
  if (relay || !safe(apiKey) || !address(fromEmail) || !safe(fromName) || !address(replyTo)) return { configured: false as const };
  return { configured: true as const, send: async (message: LabInterestEmail) => {
    if (!address(message.email)) throw new LabInterestMailError("LAB_INTEREST_MAIL_INPUT_INVALID");
    const content = labInterestMailContent(message);
    const correlation = createHash("sha256").update(JSON.stringify(["LAB_INTEREST", message.kind, message.email,
      message.kind === "CONFIRM" ? message.confirmUrl : message.noticeKey])).digest("hex");
    let response: Response;
    try {
      response = await request(SEND_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ to: message.email, from_email: fromEmail, from_name: fromName, subject: content.subject,
          text: content.text, html: content.html, smtp_headers: { "Reply-To": replyTo, "X-Flexperiment-Lab-Interest-Key": correlation, ...content.headers } }),
      });
    } catch { throw new LabInterestMailError("LAB_INTEREST_MAIL_AMBIGUOUS"); }
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 408 || response.status >= 500) throw new LabInterestMailError("LAB_INTEREST_MAIL_AMBIGUOUS");
    if (!response.ok) throw new LabInterestMailError("LAB_INTEREST_MAIL_REJECTED");
  } };
}
