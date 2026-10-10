import { execFileSync } from "node:child_process";

const operations = new Set(["config", "api", "runtime", "snapshot", "backup-runtime", "deploy",
  "deployment", "restart", "storage", "archive", "record"]);
const reasons = new Set(["VALIDATION_REFUSED", "HTTP_FAILURE", "CONTROL_TRANSPORT_FAILED",
  "SUBPROCESS_FAILED", "SUBPROCESS_TIMEOUT", "INVALID_RESPONSE", "OWNER_INTERNAL_ERROR"]);

function refusedResponse(raw) {
  try {
    const value = JSON.parse(String(raw));
    if (value?.error !== "V2_OWNER_OPERATION_REFUSED" || !reasons.has(value.reason)) return null;
    return { reason: value.reason,
      ...(Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? { status: value.status } : {}) };
  } catch { return null; }
}

// Error objects may contain stdin, commands, URLs, provider bodies and stderr.
// Never serialize them: construct diagnostics from fixed labels and numeric status only.
/** @param {(file: string, args: string[], options: import("node:child_process").ExecFileSyncOptionsWithStringEncoding) => string} execute */
export function ownerRpc(message, args, options, execute = execFileSync, report = console.error) {
  const context = { operation: operations.has(message.operation) ? message.operation : "unknown",
    target: ["canary", "production"].includes(message.target) ? message.target : "none" };
  let output;
  try {
    output = execute("ssh", args, { ...options, input: JSON.stringify(message),
      encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
  } catch (error) {
    const refused = refusedResponse(error?.stdout);
    const reason = refused?.reason ?? (error?.code === "ETIMEDOUT" ? "SSH_TIMEOUT"
      : error?.status === 255 ? "SSH_FAILED" : "TRANSPORT_OR_OPERATION_UNKNOWN");
    report(JSON.stringify({ event: "V2_OWNER_RPC_STOP", ...context, reason,
      ...(refused?.status ? { status: refused.status } : {}) }));
    throw new Error("V2_OWNER_TRANSPORT_OR_OPERATION_FAILED");
  }
  try {
    const value = JSON.parse(output);
    if (value === null && message.operation === "runtime" && message.optional === true) return value;
    if (!value || typeof value !== "object" || value.error) throw new Error("REFUSED");
    return value;
  } catch {
    report(JSON.stringify({ event: "V2_OWNER_RPC_STOP", ...context,
      reason: refusedResponse(output)?.reason ?? "INVALID_RESPONSE" }));
    throw new Error("V2_OWNER_TRANSPORT_OR_OPERATION_FAILED");
  }
}
