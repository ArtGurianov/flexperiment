import { readBuildIdentity } from "@/lib/build-identity";
import { assertCommerceReady, CommerceReadinessError } from "@/lib/canary-readiness";

export async function GET() {
  const started = performance.now();
  try {
    await assertCommerceReady();
    const identity = readBuildIdentity("platform");
    return Response.json({ ok: true, ...identity, commerce: "ok" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Fixed reason, elapsed time and integer status only: the cause must survive
    // in logs without reflecting upstream text, URLs or exception messages.
    const diagnostic = {
      reason: error instanceof CommerceReadinessError ? error.reason : "INTERNAL",
      elapsedMs: Math.round(performance.now() - started),
      ...(error instanceof CommerceReadinessError && error.upstreamStatus !== undefined
        ? { upstreamStatus: error.upstreamStatus } : {}),
    };
    console.error(JSON.stringify({ event: "PLATFORM_READINESS_FAILED", ...diagnostic }));
    return Response.json({ ok: false, service: "platform", error: "PLATFORM_NOT_READY", ...diagnostic }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
