import { renderEmailTemplate } from "./email-templates";
import { unisenderGoConfigFromEnvironment, type UnisenderGoConfig } from "./provider-config";

export type EmailDeliveryState = "ACCEPTED" | "SENT" | "DELIVERED" | "BOUNCED" | "FAILED" | "UNKNOWN";
export interface EmailProvider {
  send(input: { recipientEmail: string; template: string; payload: Record<string, unknown>; idempotencyKey: string; outboxId?: string }): Promise<{ jobId: string }>;
  lookup(input: { jobId?: string; idempotencyKey: string }): Promise<{ status: EmailDeliveryState; jobId?: string }>;
}

type UnisenderSendResponse = { status?: unknown; job_id?: unknown; code?: unknown; error_code?: unknown; message?: unknown; error?: unknown };

const sanitizedProviderCode = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const code = String(value).replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80);
  return code || undefined;
};

const sanitizedProviderMessage = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const message = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(?:api[-_ ]?key|authorization|token|payload|request(?:\s+body)?|body)\b\s*[:=]?\s*\S*/gi, "[redacted-sensitive]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-value]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return message || undefined;
};

const rejectionDetails = (payload: UnisenderSendResponse | undefined) => ({
  code: sanitizedProviderCode(payload?.code ?? payload?.error_code),
  message: sanitizedProviderMessage(payload?.message ?? payload?.error),
});

/** A provider response that conclusively rejected this dispatch request. */
export class EmailProviderRejectedError extends Error {
  readonly providerCode?: string;
  readonly providerMessage?: string;

  constructor(readonly httpStatus: number, providerCode?: string, providerMessage?: string) {
    super(`Unisender rejected email dispatch (HTTP ${httpStatus})`);
    this.name = "EmailProviderRejectedError";
    this.providerCode = sanitizedProviderCode(providerCode);
    this.providerMessage = sanitizedProviderMessage(providerMessage);
  }
}

export class UnisenderGoProvider implements EmailProvider {
  constructor(readonly config: UnisenderGoConfig, readonly request: typeof fetch = fetch) {}

  async send(input: { recipientEmail: string; template: string; payload: Record<string, unknown>; idempotencyKey: string; outboxId?: string }) {
    if (input.idempotencyKey.length > 64) throw new Error("Unisender idempotence_key exceeds 64 characters.");
    if (!input.outboxId) throw new Error("Unisender requires the persistent outbox id for callback correlation.");
    const rendered = renderEmailTemplate(input.template, input.payload);
    const response = await this.request("https://goapi.unisender.ru/ru/transactional/api/v1/email/send.json", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": this.config.apiKey },
      body: JSON.stringify({ message: {
        recipients: [{ email: input.recipientEmail, metadata: { outbox_id: input.outboxId } }],
        global_metadata: { outbox_id: input.outboxId }, body: { html: rendered.html, plaintext: rendered.plaintext }, subject: rendered.subject,
        from_email: this.config.fromEmail, from_name: this.config.fromName, reply_to: this.config.replyToEmail,
        template_engine: "none", idempotence_key: input.idempotencyKey,
      } }),
    });
    const payload = await response.json().catch(() => undefined) as UnisenderSendResponse | undefined;
    if (!response.ok || payload?.status !== "success" || typeof payload.job_id !== "string") {
      const details = rejectionDetails(payload);
      throw new EmailProviderRejectedError(response.status, details.code, details.message);
    }
    return { jobId: payload.job_id };
  }

  async lookup(): Promise<{ status: EmailDeliveryState; jobId?: string }> {
    // The confirmed Transactional API contract has no idempotence/metadata lookup.
    // Do not invent one or use it as evidence that a send did not happen.
    return { status: "UNKNOWN" };
  }
}

export class UnconfiguredEmailProvider implements EmailProvider {
  private unavailable(): never { throw new Error("The Unisender Go adapter is not configured in this runtime."); }
  send(): Promise<never> { return Promise.reject(this.unavailable()); }
  lookup(): Promise<never> { return Promise.reject(this.unavailable()); }
}

export class MockEmailProvider implements EmailProvider {
  async send(input: { idempotencyKey: string }) { return { jobId: `mock-email-${input.idempotencyKey}` }; }
  async lookup(input: { jobId?: string }) { return { status: "ACCEPTED" as const, jobId: input.jobId }; }
}

export const emailProviderFromEnvironment = (): EmailProvider => process.env.COMMERCE_EMAIL_PROVIDER === "mock" || process.env.COMMERCE_PROVIDER === "mock" ? new MockEmailProvider() : new UnisenderGoProvider(unisenderGoConfigFromEnvironment());
