import { getPayload } from "payload";
import config from "@payload-config";
import { assertPayloadTransactions } from "@/lib/payload-transaction-assertion";
import { readBuildIdentity } from "@/lib/build-identity";
import { assertCanaryCommerceReady } from "@/lib/canary-readiness";

export async function GET() {
  try {
    const payload = await getPayload({ config });
    await assertPayloadTransactions(payload);
    await assertCanaryCommerceReady();
    const identity = readBuildIdentity("platform");
    return Response.json({ ok: true, ...identity, database: "ok" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ ok: false, service: "platform", error: "PLATFORM_NOT_READY" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
