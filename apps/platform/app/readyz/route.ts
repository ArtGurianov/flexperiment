import { readBuildIdentity } from "@/lib/build-identity";
import { assertCommerceReady } from "@/lib/canary-readiness";

export async function GET() {
  try {
    await assertCommerceReady();
    const identity = readBuildIdentity("platform");
    return Response.json({ ok: true, ...identity, commerce: "ok" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ ok: false, service: "platform", error: "PLATFORM_NOT_READY" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
