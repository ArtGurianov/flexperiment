import { getPayload } from "payload";
import config from "@payload-config";
import { assertPayloadTransactions } from "@/lib/payload-transaction-assertion";
import { readBuildIdentity } from "@/lib/build-identity";

export async function GET() {
  try {
    const payload = await getPayload({ config });
    await assertPayloadTransactions(payload);
    const identity = readBuildIdentity("platform");
    return Response.json({ ok: true, ...identity, database: "ok" }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ ok: false, service: "platform", error: error instanceof Error ? error.message : "UNKNOWN" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
