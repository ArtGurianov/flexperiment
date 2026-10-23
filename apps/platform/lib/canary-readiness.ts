import { validatePlatformCanary } from "./canary-config";
import { CLOSED_PAID_TEST_PROFILE } from "../../../lib/closed-paid-test-profile";

/** Longer than Commerce's own /readyz deadline (READINESS_DEADLINE_MS, 8s, fresh S3
 * erasure-authority read included), so Platform always receives Commerce's answer.
 * 3s turned slow-but-valid reads into ~10% PLATFORM_NOT_READY (2026-10-22).
 * Every outer probe waits longer; scripts/v2/test_fast_cut.py pins the chain. */
export const COMMERCE_READINESS_TIMEOUT_MS = 10_000;

export async function assertCommerceReady() {
  const canary = validatePlatformCanary();
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) throw new Error("COMMERCE_NOT_CONFIGURED");
  const response = await fetch(new URL("/readyz", origin), {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(COMMERCE_READINESS_TIMEOUT_MS),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error("CANARY_COMMERCE_UNAVAILABLE");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new Error("CANARY_COMMERCE_UNAVAILABLE"); }
    chunks.push(next.value);
  }
  const ready = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (ready.ok !== true || ready.service !== "commerce-v2" || ready.core?.database !== "ok"
    || ready.foundationMode !== false
    || (canary && (ready.sourceCommit !== process.env.PLATFORM_EXPECTED_COMMERCE_SHA
      || ready.core?.paymentMode !== (process.env.CLOSED_PAID_TEST_PROFILE ? "refref" : "disabled")
      || (process.env.CLOSED_PAID_TEST_PROFILE && (ready.core?.closedPaidTestProfile !== CLOSED_PAID_TEST_PROFILE
        || ready.core?.closedPaidTestLegalSha256 !== process.env.CLOSED_PAID_TEST_LEGAL_SHA256
        || ready.core?.closedPaidTestRefrefSource !== process.env.CLOSED_PAID_TEST_REFREF_SOURCE))
      || ready.capabilities?.refref !== "ready"))) throw new Error("CANARY_COMMERCE_UNAVAILABLE");
}
