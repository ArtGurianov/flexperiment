import { privacyLinkEffectiveAt } from "@/lib/legal-link-date-server";

export async function GET(request: Request) {
  return Response.json({ effectiveAt: await privacyLinkEffectiveAt(request.headers) }, {
    headers: { "cache-control": "no-store" },
  });
}
