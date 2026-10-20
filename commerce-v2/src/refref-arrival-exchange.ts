import { z } from "zod";

/**
 * Refref vNext arrival claims and context close (refref docs/openapi-vnext.yaml `claimArrival`,
 * `closeBrowserContext`; docs/29 §3–§4). The body is closed: proof, context and origin, never a buyer.
 */
export type ArrivalClaimInput = { arrivalProof: string; browserContextId: string; storefrontOrigin: string };
export type ArrivalClaimOutcome =
  /** 201 committed or 200 exact replay of a committed claim (lost-ACK readback). */
  | { kind: "CONFIRMED"; claimId: string; eligibleUntil: string }
  /** Final for this proof: a repeat is refused the same way. */
  | { kind: "REFUSED"; code: string }
  /** The context is CLOSED, expired or tombstoned at Refref; the proof may still be claimed elsewhere. */
  | { kind: "CONTEXT_CLOSED" }
  /** No authoritative answer: timeout, transport, 5xx/429 or an operator-side configuration refusal. */
  | { kind: "UNKNOWN"; code: string };
export type ContextCloseOutcome = "CLOSED" | "REFUSED" | "UNKNOWN";

export interface ArrivalExchange {
  claim(input: ArrivalClaimInput, signal: AbortSignal): Promise<ArrivalClaimOutcome>;
  close(browserContextId: string, signal: AbortSignal): Promise<ContextCloseOutcome>;
}

const receiptSchema = z.object({
  claimId: z.string().uuid(),
  browserContextId: z.string(),
  storefrontOrigin: z.string(),
  claimedAt: z.string(),
  eligibleUntil: z.string().datetime({ offset: true }),
});
const closedSchema = z.object({ browserContextId: z.string(), status: z.literal("CLOSED") });
const errorSchema = z.object({ error: z.object({ code: z.string() }).passthrough() });

/** Codes a repeat of the same claim cannot change. BROWSER_CONTEXT_IDLE_POLICY_REQUIRED is the owner's to fix. */
const FINAL_CLAIM_REFUSALS = new Set(["ARRIVAL_PROOF_INVALID", "ARRIVAL_ALREADY_CLAIMED", "CONTEXT_SCOPE_MISMATCH", "INVALID_REQUEST"]);

export class RefrefArrivalExchange implements ArrivalExchange {
  private readonly request: typeof fetch;
  constructor(private readonly config: { apiBaseUrl: string; apiKey: string; fetch?: typeof fetch }) {
    this.request = config.fetch ?? fetch;
  }

  private async post(path: string, body: unknown, signal: AbortSignal) {
    const target = new URL(this.config.apiBaseUrl);
    target.pathname = `${target.pathname.replace(/\/$/, "")}${path}`;
    const response = await this.request(target, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    const error = errorSchema.safeParse(payload);
    return { status: response.status, payload, code: error.success ? error.data.error.code : `HTTP_${response.status}` };
  }

  async claim(input: ArrivalClaimInput, signal: AbortSignal): Promise<ArrivalClaimOutcome> {
    let answer: Awaited<ReturnType<RefrefArrivalExchange["post"]>>;
    try { answer = await this.post("/integrations/arrival-claims", input, signal); }
    catch { return { kind: "UNKNOWN", code: "TRANSPORT" }; }
    if (answer.status === 200 || answer.status === 201) {
      const receipt = receiptSchema.safeParse(answer.payload);
      if (!receipt.success) return { kind: "UNKNOWN", code: "RECEIPT_INVALID" };
      // A receipt for another context or origin is not this claim's: never treat it as delivery.
      if (receipt.data.browserContextId !== input.browserContextId || receipt.data.storefrontOrigin !== input.storefrontOrigin) {
        return { kind: "REFUSED", code: "CLAIM_RECEIPT_MISMATCH" };
      }
      return { kind: "CONFIRMED", claimId: receipt.data.claimId, eligibleUntil: receipt.data.eligibleUntil };
    }
    if (answer.code === "CONTEXT_CLOSED") return { kind: "CONTEXT_CLOSED" };
    if ((answer.status === 400 || answer.status === 409 || answer.status === 422) && FINAL_CLAIM_REFUSALS.has(answer.code)) {
      return { kind: "REFUSED", code: answer.code };
    }
    if (answer.status === 422) return { kind: "REFUSED", code: "ARRIVAL_PROOF_INVALID" };
    return { kind: "UNKNOWN", code: answer.code };
  }

  async close(browserContextId: string, signal: AbortSignal): Promise<ContextCloseOutcome> {
    let answer: Awaited<ReturnType<RefrefArrivalExchange["post"]>>;
    try { answer = await this.post(`/integrations/browser-contexts/${encodeURIComponent(browserContextId)}/close`, undefined, signal); }
    catch { return "UNKNOWN"; }
    if (answer.status === 200) {
      const closed = closedSchema.safeParse(answer.payload);
      return closed.success && closed.data.browserContextId === browserContextId ? "CLOSED" : "UNKNOWN";
    }
    if (answer.status === 409 && answer.code === "CONTEXT_SCOPE_MISMATCH") return "REFUSED";
    return "UNKNOWN";
  }
}
