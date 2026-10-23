import { validatePlatformCanary } from "./canary-config";
import { CLOSED_PAID_TEST_PROFILE } from "../../../lib/closed-paid-test-profile";

/** Longer than Commerce's own /readyz deadline (READINESS_DEADLINE_MS, 8s, fresh S3
 * erasure-authority read included), so Platform always receives Commerce's answer.
 * 3s turned slow-but-valid reads into ~10% PLATFORM_NOT_READY (2026-10-22).
 * Every outer probe waits longer; scripts/v2/test_fast_cut.py pins the chain. */
export const COMMERCE_READINESS_TIMEOUT_MS = 10_000;

export type CommerceReadinessReason =
  "CONFIGURATION" | "UPSTREAM_TIMEOUT" | "UPSTREAM_TRANSPORT" | "UPSTREAM_STATUS" | "UPSTREAM_CONTRACT";

/** Carries only a fixed reason and an integer status: never upstream text, URL or exception message. */
export class CommerceReadinessError extends Error {
  constructor(readonly reason: CommerceReadinessReason, readonly upstreamStatus?: number) {
    super("CANARY_COMMERCE_UNAVAILABLE");
  }
}

const unavailable = (error: unknown) => error instanceof CommerceReadinessError ? error
  : new CommerceReadinessError(error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)
    ? "UPSTREAM_TIMEOUT" : "UPSTREAM_TRANSPORT");

export async function assertCommerceReady() {
  let canary: boolean;
  try { canary = validatePlatformCanary(); } catch { throw new CommerceReadinessError("CONFIGURATION"); }
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) throw new CommerceReadinessError("CONFIGURATION");
  const chunks: Uint8Array[] = [];
  try {
    const response = await fetch(new URL("/readyz", origin), {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(COMMERCE_READINESS_TIMEOUT_MS),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw response.status !== 200 ? new CommerceReadinessError("UPSTREAM_STATUS", response.status)
        : new CommerceReadinessError("UPSTREAM_CONTRACT");
    }
    const reader = response.body.getReader();
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new CommerceReadinessError("UPSTREAM_CONTRACT"); }
      chunks.push(next.value);
    }
  } catch (error) { throw unavailable(error); }
  let ready;
  try { ready = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CommerceReadinessError("UPSTREAM_CONTRACT"); }
  if (ready.ok !== true || ready.service !== "commerce-v2" || ready.core?.database !== "ok"
    || ready.foundationMode !== false
    || (canary && (ready.sourceCommit !== process.env.PLATFORM_EXPECTED_COMMERCE_SHA
      || ready.core?.paymentMode !== (process.env.CLOSED_PAID_TEST_PROFILE ? "refref" : "disabled")
      || (process.env.CLOSED_PAID_TEST_PROFILE && (ready.core?.closedPaidTestProfile !== CLOSED_PAID_TEST_PROFILE
        || ready.core?.closedPaidTestLegalSha256 !== process.env.CLOSED_PAID_TEST_LEGAL_SHA256
        || ready.core?.closedPaidTestRefrefSource !== process.env.CLOSED_PAID_TEST_REFREF_SOURCE))
      || ready.capabilities?.refref !== "ready"))) throw new CommerceReadinessError("UPSTREAM_CONTRACT");
}
