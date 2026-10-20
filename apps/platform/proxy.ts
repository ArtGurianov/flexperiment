import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { BROWSER_CONTEXT_COOKIE, touchBrowserContext } from "@/lib/browser-context";

// ART-378: every page view of a browser carrying the LMS context retries a still-unconfirmed arrival
// claim within its 30 minutes. The page is never delayed; `waitUntil` keeps the call alive after it.
export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.method === "GET" && request.cookies.has(BROWSER_CONTEXT_COOKIE)) event.waitUntil(touchBrowserContext(request));
  return NextResponse.next();
}

export const config = {
  matcher: [{
    source: "/((?!_next/|v1/|arrive|identity|readyz|robots\\.txt|sitemap\\.xml|search-index\\.json|indexnow-key\\.txt|account-courses\\.json|favicon\\.ico).*)",
    has: [{ type: "cookie", key: "__Host-flx-ctx-lms" }],
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }],
};
