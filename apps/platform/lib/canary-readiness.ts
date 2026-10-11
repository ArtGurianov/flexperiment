import { validatePlatformCanary } from "./canary-config";

export async function assertCanaryCommerceReady() {
  if (!validatePlatformCanary()) return;
  const response = await fetch(new URL("/readyz", process.env.COMMERCE_INTERNAL_ORIGIN), {
    method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000),
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
  if (ready.ok !== true || ready.service !== "commerce-v2" || ready.foundationMode !== false
    || ready.sourceCommit !== process.env.PLATFORM_EXPECTED_COMMERCE_SHA
    || ready.core?.database !== "ok" || ready.core?.paymentMode !== "disabled"
    || ready.capabilities?.refref !== "ready") throw new Error("CANARY_COMMERCE_UNAVAILABLE");
}
