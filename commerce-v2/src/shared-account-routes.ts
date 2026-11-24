import type { Context } from "hono";
import { routePath } from "hono/route";
import type { CommerceOrigins } from "./origins";
import type { Surface } from "./my-session";

export type AccountSessionScope = { readonly method: string; readonly route: string };

/** Use the registered route, so adding a static route beside a parameterized route grants it nothing. */
export function accountSessionScope(context: Context): AccountSessionScope {
  return { method: context.req.method, route: routePath(context) };
}

export const SHARED_ACCOUNT_ROUTES: Readonly<Record<Surface, ReadonlySet<string>>> = {
  MY: new Set([
    "GET /v1/my/session",
    "GET /v1/my/profile",
    "GET /v1/my/consents",
    "POST /v1/my/consents",
    "POST /v1/my/sign-out",
    "GET /v1/my/storefront-session",
    "POST /v1/my/storefront-sign-out",
    "GET /v1/my/courses",
    "GET /v1/my/tickets",
    "GET /v1/my/tickets/:orderPublicId",
    "POST /v1/my/tickets/:orderPublicId/qr/reissue",
    "GET /v1/me/orders",
    "POST /v1/checkout/preview",
    "POST /v1/checkout",
    "GET /v1/checkout/:orderPublicId",
    "GET /v1/refunds",
    "POST /v1/refunds",
  ]),
  LMS: new Set([
    "GET /v1/lms/session",
    "GET /v1/me",
    "GET /v1/me/consents",
    "POST /v1/me/consents/marketing",
    "GET /v1/me/course-library",
    "GET /v1/me/courses/:slug",
    "GET /v1/me/courses/:slug/lessons/:lessonSlug",
    "GET /v1/library",
    "GET /v1/me/free-enrollments/:courseSlug",
    "POST /v1/me/free-enrollments",
    "PUT /v1/lessons/:lessonRef/resume",
    "POST /v1/lessons/:lessonRef/resume",
    "POST /v1/lessons/:lessonRef/playback",
    "GET /v1/lessons/:lessonRef/completion",
    "POST /v1/lessons/:lessonRef/completion",
    "GET /v1/browser-context/arrive",
    "POST /v1/browser-context/touch",
  ]),
  // Historical guest-ticket reissue still verifies the signed-in owner and the original capability.
  LAB: new Set(["POST /v1/lab/guest/reissue"]),
};

export function admitsSharedAccountSession(surface: Surface, scope: AccountSessionScope | undefined, headers: Headers,
  origins: CommerceOrigins) {
  if (!scope || !SHARED_ACCOUNT_ROUTES[surface].has(`${scope.method} ${scope.route}`)) return false;
  const origin = headers.get("origin");
  if (scope.route === "/v1/my/storefront-session" || scope.route === "/v1/my/storefront-sign-out") {
    return origin === origins.platform || origin === origins.lab;
  }
  // The touch route only rechecks an existing browser-context link, including internal page views.
  const ownOrigin = surface === "MY" ? origins.my : surface === "LMS" ? origins.platform : origins.lab;
  if (origin === null && (scope.method === "GET" || scope.route === "/v1/browser-context/touch")) return true;
  return origin === ownOrigin;
}
