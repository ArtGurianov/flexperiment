import { proxyCommerce } from "./commerce-proxy";

/**
 * ART-378 (refref docs/29 §2, §6). The platform origin's LMS browser context lives in Commerce, which
 * sets and reads this host-scoped, server-only cookie (`BROWSER_CONTEXT_COOKIES.COURSES` there).
 */
export const BROWSER_CONTEXT_COOKIE = "__Host-flx-ctx-lms";
// Not reachable through the public `/v1/*` route: only the arrival endpoint and the page-view hook forward here.
const browserContextRoots: ReadonlySet<string> = new Set(["browser-context"]);

/** `/arrive?arrival=…&to=…`: Commerce captures the proof, sets the cookie and redirects to a clean URL. */
export const forwardArrival = (request: Request) => proxyCommerce(request, ["browser-context", "arrive"], browserContextRoots);

/** A page view of a browser with a context: Commerce retries an unconfirmed claim after answering. */
export async function touchBrowserContext(request: Request) {
  const touch = new Request(new URL("/v1/browser-context/touch", request.url), { method: "POST", headers: request.headers });
  try {
    const response = await proxyCommerce(touch, ["browser-context", "touch"], browserContextRoots);
    await response.body?.cancel();
  } catch { /* a missed retry is retried on the next request; never surface it to the page */ }
}
