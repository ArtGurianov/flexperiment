import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { BROWSER_CONTEXT_COOKIE, touchBrowserContext } from "@/lib/browser-context";
import { CommerceLegalForbidden, legalPageHeader, readLegalPage } from "@/lib/legal-release-server";

// ART-378: every page view of a browser carrying the LMS context retries a still-unconfirmed arrival
// claim within its 30 minutes. The page is never delayed; `waitUntil` keeps the call alive after it.
export async function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.method === "GET" && request.cookies.has(BROWSER_CONTEXT_COOKIE)) event.waitUntil(touchBrowserContext(request));
  const [root, kind, ...rest] = request.nextUrl.pathname.split("/").filter(Boolean);
  if (root !== "legal" || !kind || rest.length) return NextResponse.next();

  try {
    const legalPage = await readLegalPage(kind, request.headers);
    if (!legalPage) {
      return NextResponse.rewrite(new URL("/404", request.url), {
        status: 404, headers: { "cache-control": "no-store" },
      });
    }
    const headers = new Headers(request.headers);
    headers.set(legalPageHeader, encodeURIComponent(JSON.stringify(legalPage)));
    return NextResponse.next({ request: { headers } });
  } catch (error) {
    const forbidden = error instanceof CommerceLegalForbidden;
    return new NextResponse(forbidden ? "Доступ к документу закрыт." : "Действующая редакция документа временно недоступна.", {
      status: forbidden ? 403 : 503,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
}

export const config = {
  matcher: [{
    source: "/((?!_next/|v1/|arrive|identity|readyz|robots\\.txt|sitemap\\.xml|search-index\\.json|indexnow-key\\.txt|account-courses\\.json|favicon\\.ico).*)",
    has: [{ type: "cookie", key: "__Host-flx-ctx-lms" }],
    missing: [{ type: "header", key: "next-router-prefetch" }, { type: "header", key: "purpose", value: "prefetch" }],
  }, { source: "/legal/:kind" }],
};
