import { ErasureLedgerError } from "./erasure-ledger";

export type ErasureReadStage = "head" | "head_body" | "history_head" | "history_head_body"
  | "versioning" | "versions" | "packet" | "packet_body" | "head_signature" | "history"
  | "mirror" | "prefix" | "packet_verification" | "final_head" | "freshness";
export type ErasureReadReason = "TIMEOUT" | "TRANSPORT" | "SERVER_5XX" | "THROTTLED"
  | "AUTHORIZATION" | "HTTP_4XX" | "INVALID_RESPONSE" | "VERIFICATION" | "UNKNOWN";
const failureCodes = ["ERASURE_LIBRARY_READ_UNAVAILABLE", "ERASURE_HISTORY_NOT_QUALIFIED", "ERASURE_HISTORY_RECONCILIATION_REQUIRED",
  "ERASURE_HISTORY_CAPACITY_REVIEW_REQUIRED", "ERASURE_REMOTE_UNINITIALIZED", "ERASURE_CUSTODY_INVALID",
  "ERASURE_CUSTODY_RECIPIENT_INVALID", "ERASURE_REMOTE_LEDGER_ROLLBACK_OR_FORK", "ERASURE_REMOTE_READBACK_FAILED",
  "ERASURE_REMOTE_ACK_UNCONFIRMED", "ERASURE_CURRENT_READ_EXPIRED", "ERASURE_LEDGER_STALE_OR_INCOMPLETE",
  "ERASURE_RUNTIME_LEDGER_ROLLBACK_OR_FORK", "ERASURE_RUNTIME_LEDGER_UNAPPLIED", "ERASURE_RUNTIME_CLOSED",
  "ERASURE_ADMISSION_EXPIRED", "ERASURE_SUBJECT_KEY_MISSING", "ERASURE_DRAIN_PENDING", "ERASURE_OWNER_RECONCILIATION_REQUIRED",
  "ERASURE_RESTORE_UNCLASSIFIED_SCHEMA", "ERASURE_RESTORE_SCHEMA_REFUSED", "ERASURE_RESTORE_INTEGRITY_FAILED",
  "ERASURE_SUBJECT_BINDING_DRIFT", "ERASURE_FINANCIAL_REVIEW_REQUIRED", "ERASURE_AUDIT_REVIEW_REQUIRED", "ERASURE_SEND_OUTCOME_UNKNOWN"] as const;
export type ErasureFailureCode = typeof failureCodes[number];
export function erasureFailureCode(error: unknown): ErasureFailureCode | undefined {
  return error instanceof ErasureLedgerError && failureCodes.includes(error.message as ErasureFailureCode)
    ? error.message as ErasureFailureCode : undefined;
}
export type ErasureDiagnostic = {
  event: "ERASURE_READ_FAILURE" | "ERASURE_READ_RECOVERED" | "ERASURE_ADMISSION_CLOSED" | "ERASURE_BOOT_HOLD";
  scope: "canary" | "production";
  stage?: ErasureReadStage;
  reason?: ErasureReadReason;
  httpStatus?: number;
  code?: ErasureFailureCode;
  attempt?: number;
  elapsedMs: number;
  operation?: "READY" | "REQUEST" | "WORKER" | "SEND" | "BOOT";
};
export type ErasureDiagnostics = (event: Readonly<ErasureDiagnostic>) => void;
export function reportErasure(diagnostics: ErasureDiagnostics | undefined, event: ErasureDiagnostic) {
  // Observability is not an admission dependency. Never pass the caught Error,
  // message, stack, URL/key/version ID, headers or provider response to a sink.
  try { diagnostics?.(Object.freeze(event)); } catch { /* the authority decision is unchanged */ }
}
export class ErasureReaderFailure extends ErasureLedgerError {
  constructor(readonly stage: ErasureReadStage, readonly reason: ErasureReadReason, readonly httpStatus?: number, readonly code?: ErasureFailureCode) {
    super("ERASURE_LIBRARY_READ_UNAVAILABLE");
  }
  get retryable() { return ["TIMEOUT", "TRANSPORT", "SERVER_5XX", "THROTTLED"].includes(this.reason); }
}
export function erasureReadFailure(stage: ErasureReadStage, error: unknown): ErasureReaderFailure {
  if (error instanceof ErasureReaderFailure) return error;
  if (error instanceof ErasureLedgerError) return new ErasureReaderFailure(stage, "VERIFICATION", undefined, erasureFailureCode(error));
  // Only exact known names/codes and a numeric HTTP status are retained. SDK
  // error fields may contain reflected credentials, PII or a raw provider body.
  const e = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } | null;
  const status = e?.$metadata?.httpStatusCode;
  const httpStatus = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
  if (httpStatus === 401 || httpStatus === 403) return new ErasureReaderFailure(stage, "AUTHORIZATION", httpStatus);
  if (httpStatus === 429) return new ErasureReaderFailure(stage, "THROTTLED", httpStatus);
  if (httpStatus && httpStatus >= 500) return new ErasureReaderFailure(stage, "SERVER_5XX", httpStatus);
  if (httpStatus) return new ErasureReaderFailure(stage, "HTTP_4XX", httpStatus);
  if (["AbortError", "TimeoutError", "RequestTimeout", "RequestTimeoutException"].includes(typeof e?.name === "string" ? e.name : "")
    || e?.code === "ETIMEDOUT") return new ErasureReaderFailure(stage, "TIMEOUT");
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(typeof e?.code === "string" ? e.code : ""))
    return new ErasureReaderFailure(stage, "TRANSPORT");
  return new ErasureReaderFailure(stage, "UNKNOWN");
}
