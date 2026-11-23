const MAX_RESPONSE_BYTES = 16_384;

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("NOTISEND_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("NOTISEND_RESPONSE_INVALID");
      parts.push(value);
    }
    const result: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new Error("NOTISEND_RESPONSE_INVALID");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Acceptance is a provider acknowledgement. Inbox delivery is a separate observation. */
export async function readNotiSendOutcome(response: Response): Promise<"ACCEPTED" | "REJECTED" | "AMBIGUOUS"> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return response.status === 408 || response.status >= 500 ? "AMBIGUOUS" : "REJECTED";
  }
  try {
    const payload = await boundedJson(response);
    if (payload.errors !== undefined || ["skipped", "soft_bounced", "hard_bounced"].includes(String(payload.status))) return "REJECTED";
    const validId = (typeof payload.id === "number" && Number.isSafeInteger(payload.id) && payload.id > 0)
      || (typeof payload.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(payload.id));
    return validId && ["queued", "sent", "delivered"].includes(String(payload.status)) ? "ACCEPTED" : "AMBIGUOUS";
  } catch { return "AMBIGUOUS"; }
}
