import { renderEmailTemplate } from "./email-templates";
import { unisenderGoConfigFromEnvironment, type UnisenderGoConfig } from "./provider-config";

export type EmailDeliveryState = "ACCEPTED" | "SENT" | "DELIVERED" | "BOUNCED" | "FAILED" | "UNKNOWN";
export interface EmailProvider {
  send(input: { recipientEmail: string; template: string; payload: Record<string, unknown>; idempotencyKey: string; outboxId?: string }): Promise<{ jobId: string }>;
  lookup(input: { jobId?: string; idempotencyKey: string }): Promise<{ status: EmailDeliveryState; jobId?: string }>;
}

/**
 * Event Dump is intentionally separate from `lookup()`: the provider creates
 * an asynchronous CSV export, so it is recovery evidence rather than a cheap
 * synchronous status lookup.
 */
export type UnisenderDumpEvent = {
  eventTime: string;
  jobId: string;
  status: string;
  deliveryStatus: string;
  metadata: unknown;
};

export type UnisenderEventDump =
  | { status: "queued" | "in_process"; events: UnisenderDumpEvent[] }
  | { status: "ready"; events: UnisenderDumpEvent[] }
  | { status: "failed" };

/** The documented maximum result count for one Event Dump export request. */
export const UNISENDER_EVENT_DUMP_EVENT_LIMIT = 100_000;

export interface EmailDeliveryEvidenceProvider {
  /** Read-only provider count used to stay safely below Event Dump capacity. */
  listEventDumps(): Promise<{ count: number }>;
  createEventDump(input: { startTime: string; endTime: string; jobId?: string }): Promise<{ dumpId: string }>;
  getEventDump(input: { dumpId: string }): Promise<UnisenderEventDump>;
}

export const isEmailDeliveryEvidenceProvider = (provider: EmailProvider): provider is EmailProvider & EmailDeliveryEvidenceProvider =>
  typeof (provider as Partial<EmailDeliveryEvidenceProvider>).listEventDumps === "function"
  && typeof (provider as Partial<EmailDeliveryEvidenceProvider>).createEventDump === "function"
  && typeof (provider as Partial<EmailDeliveryEvidenceProvider>).getEventDump === "function";

type UnisenderSendResponse = { status?: unknown; job_id?: unknown; code?: unknown; error_code?: unknown; message?: unknown; error?: unknown };
type UnisenderDumpCreateResponse = { status?: unknown; dump_id?: unknown };
type UnisenderDumpListResponse = { status?: unknown; event_dumps?: unknown };
type UnisenderDumpGetResponse = {
  status?: unknown;
  event_dump?: { dump_status?: unknown; files?: Array<{ url?: unknown }> };
};

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

const hasExplicitRejectionEvidence = (payload: UnisenderSendResponse | undefined) => {
  const status = typeof payload?.status === "string" ? payload.status.toLowerCase() : "";
  return ["error", "failed", "failure", "rejected"].includes(status)
    || typeof payload?.error_code === "string" || typeof payload?.error_code === "number"
    || typeof payload?.error === "string";
};

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

/** A 2xx response that does not prove whether dispatch was accepted. */
export class EmailProviderAmbiguousError extends Error {
  constructor() {
    super("Unisender response did not contain usable dispatch evidence.");
    this.name = "EmailProviderAmbiguousError";
  }
}

/** A received 4xx response conclusively rejected an Event Dump create request. */
export class EventDumpCreateRejectedError extends Error {
  constructor(readonly httpStatus: number) {
    super(`Unisender rejected Event Dump creation (HTTP ${httpStatus}).`);
    this.name = "EventDumpCreateRejectedError";
  }
}

const EVENT_DUMP_URL = "https://goapi.unisender.ru/ru/transactional/api/v1/event-dump";
const EVENT_DUMP_TIMEOUT_MS = 10_000;

const parseCsv = (csv: string) => {
  const rows: string[][] = [];
  let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (quoted) return [];
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
};

const dumpEventsFromCsv = (csv: string): UnisenderDumpEvent[] => {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const columns = new Map(header.map((name, index) => [name, index]));
  const required = ["event_time", "job_id", "status", "delivery_status", "metadata"];
  if (required.some((name) => columns.get(name) === undefined)) return [];
  return rows.flatMap((row) => {
    const eventTime = row[columns.get("event_time")!];
    const jobId = row[columns.get("job_id")!];
    const status = row[columns.get("status")!];
    const deliveryStatus = row[columns.get("delivery_status")!];
    const rawMetadata = row[columns.get("metadata")!];
    if (![eventTime, jobId, status, deliveryStatus, rawMetadata].every((value) => typeof value === "string")) return [];
    try { return [{ eventTime, jobId, status, deliveryStatus, metadata: JSON.parse(rawMetadata) }]; }
    catch { return []; }
  });
};

export class UnisenderGoProvider implements EmailProvider, EmailDeliveryEvidenceProvider {
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
    if (!response.ok || hasExplicitRejectionEvidence(payload)) {
      const details = rejectionDetails(payload);
      throw new EmailProviderRejectedError(response.status, details.code, details.message);
    }
    if (payload?.status !== "success" || typeof payload.job_id !== "string") throw new EmailProviderAmbiguousError();
    return { jobId: payload.job_id };
  }

  async lookup(): Promise<{ status: EmailDeliveryState; jobId?: string }> {
    // The confirmed Transactional API contract has no idempotence/metadata lookup.
    // Do not invent one or use it as evidence that a send did not happen.
    return { status: "UNKNOWN" };
  }

  private requestEventDump(input: RequestInfo | URL, init: RequestInit = {}) {
    return this.request(input, { ...init, signal: AbortSignal.timeout(EVENT_DUMP_TIMEOUT_MS) });
  }

  async listEventDumps() {
    const response = await this.requestEventDump(`${EVENT_DUMP_URL}/list.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": this.config.apiKey },
      body: "{}",
    });
    const payload = await response.json().catch(() => undefined) as UnisenderDumpListResponse | undefined;
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) throw new EventDumpCreateRejectedError(response.status);
      throw new EmailProviderAmbiguousError();
    }
    if (payload?.status !== "success" || !Array.isArray(payload.event_dumps)) throw new EmailProviderAmbiguousError();
    return { count: payload.event_dumps.length };
  }

  async createEventDump(input: { startTime: string; endTime: string; jobId?: string }) {
    const response = await this.requestEventDump(`${EVENT_DUMP_URL}/create.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": this.config.apiKey },
      // Batch one small time window. Request only fields needed for strict
      // opaque correlation; the export never includes recipient/address data.
      body: JSON.stringify({ start_time: input.startTime, end_time: input.endTime, limit: UNISENDER_EVENT_DUMP_EVENT_LIMIT,
        ...(input.jobId ? { filter: { job_id: input.jobId } } : {}),
        dump_fields: ["event_time", "job_id", "status", "delivery_status", "metadata"], format: "csv" }),
    });
    const payload = await response.json().catch(() => undefined) as UnisenderDumpCreateResponse | undefined;
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) throw new EventDumpCreateRejectedError(response.status);
      throw new EmailProviderAmbiguousError();
    }
    if (payload?.status !== "success" || typeof payload.dump_id !== "string" || !payload.dump_id) throw new EmailProviderAmbiguousError();
    return { dumpId: payload.dump_id };
  }

  async getEventDump(input: { dumpId: string }): Promise<UnisenderEventDump> {
    const response = await this.requestEventDump(`${EVENT_DUMP_URL}/get.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-API-KEY": this.config.apiKey },
      body: JSON.stringify({ dump_id: input.dumpId }),
    });
    const payload = await response.json().catch(() => undefined) as UnisenderDumpGetResponse | undefined;
    if (!response.ok || payload?.status !== "success") throw new Error("Unisender Event Dump lookup failed.");
    const dump = payload.event_dump;
    if (!dump || typeof dump.dump_status !== "string") throw new Error("Unisender Event Dump lookup returned malformed status.");
    if (dump.dump_status === "failed") return { status: "failed" };
    if (!(["queued", "in_process", "ready"] as string[]).includes(dump.dump_status)
      || (dump.files !== undefined && !Array.isArray(dump.files))) throw new Error("Unisender Event Dump lookup returned an unsupported status.");
    const events: UnisenderDumpEvent[] = [];
    for (const file of dump.files ?? []) {
      if (typeof file?.url !== "string") continue;
      const url = new URL(file.url);
      if (url.protocol !== "https:" || !/(^|\.)unisender\.ru$/i.test(url.hostname)) throw new Error("Unisender Event Dump returned an untrusted file URL.");
      const fileResponse = await this.requestEventDump(url, { headers: { Accept: "text/csv" } });
      if (!fileResponse.ok) throw new Error("Unisender Event Dump file download failed.");
      events.push(...dumpEventsFromCsv(await fileResponse.text()));
    }
    return { status: dump.dump_status as "queued" | "in_process" | "ready", events };
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
