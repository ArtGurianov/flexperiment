import { renderEmailTemplate } from "./email-templates";
import { unisenderGoConfigFromEnvironment, type UnisenderGoConfig } from "./provider-config";

export type EmailDeliveryState = "ACCEPTED" | "SENT" | "DELIVERED" | "BOUNCED" | "FAILED" | "UNKNOWN";
export interface EmailProvider {
  send(input: { recipientEmail: string; template: string; payload: Record<string, unknown>; idempotencyKey: string; outboxId?: string }): Promise<{ jobId: string }>;
  lookup(input: { jobId?: string; idempotencyKey: string }): Promise<{ status: EmailDeliveryState; jobId?: string }>;
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
    const payload = await response.json().catch(() => undefined) as { status?: unknown; job_id?: unknown } | undefined;
    if (!response.ok || payload?.status !== "success" || typeof payload.job_id !== "string") throw new Error(`Unisender send was not accepted (HTTP ${response.status}).`);
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
