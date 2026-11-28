import { sharedAccountCookie, validSharedAccountSetCookie } from "../../../lib/shared-account-session";

/** Same-origin `/v1/*` proxy for my.flexperiment.ru (FLEX-120 contract §1, §7, §12).
 * Commerce derives the surface only from the host this proxy sets, so every client-supplied
 * forwarding header is dropped and replaced. Only the configured account cookie and the two
 * explicit storefront Navbar routes can cross the MY host boundary. */
type Environment = Readonly<Record<string, string | undefined>>;

/** First path segments my may reach. `lms` and `auth` are deliberately absent. */
export const MY_PROXY_ROOTS: ReadonlySet<string> = new Set(["my", "checkout", "refunds", "me", "legal", "email"]);

const DROPPED_REQUEST_HEADERS = ["host", "content-length", "connection", "forwarded", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip"];

const refuse = (code: string, status: number) => Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });

export function myOrigin(environment: Environment = process.env) {
  const value = environment.MY_ORIGIN?.trim();
  if (!value) return null;
  const parsed = new URL(value);
  return parsed.origin === value.replace(/\/$/, "") ? parsed : null;
}

/** The trusted ingress appends the peer address last; the left-most hops are client-controlled. */
export function ingressClientIp(headers: Headers) {
  const hops = headers.get("x-forwarded-for")?.split(",").map((hop) => hop.trim()).filter(Boolean) ?? [];
  const last = hops.at(-1);
  return last && /^[0-9a-fA-F:.]{2,45}$/.test(last) ? last : undefined;
}

export async function proxyCommerce(request: Request, path: string[], environment: Environment = process.env,
  send: typeof fetch = fetch) {
  if (!path[0] || !MY_PROXY_ROOTS.has(path[0])
    || path.some((part) => !part || /[\\/\x00-\x1f\x7f]/.test(part) || part === "." || part === "..")) return refuse("NOT_FOUND", 404);
  const origin = myOrigin(environment);
  const upstream = environment.COMMERCE_INTERNAL_ORIGIN?.trim();
  if (!origin || !upstream) return refuse("COMMERCE_NOT_CONFIGURED", 503);
  const source = new URL(request.url);
  const presentedHost = request.headers.get("host") ?? source.host;
  if (presentedHost !== origin.host) return refuse("FORBIDDEN", 403);
  let sessionCookie: ReturnType<typeof sharedAccountCookie>;
  try { sessionCookie = sharedAccountCookie(environment, [environment.PLATFORM_ORIGIN, environment.LAB_ORIGIN]); }
  catch { return refuse("COMMERCE_NOT_CONFIGURED", 503); }
  const requestOrigin = request.headers.get("origin");
  const storefrontRead = path.length === 2 && path[0] === "my" && path[1] === "storefront-session";
  const storefrontLogout = path.length === 2 && path[0] === "my" && path[1] === "storefront-sign-out";
  const storefrontRoute = storefrontRead || storefrontLogout;
  const cors = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  if (storefrontRoute) {
    const storefrontOrigins = [environment.PLATFORM_ORIGIN, environment.LAB_ORIGIN].map(value => value && URL.parse(value)?.origin);
    if (!sessionCookie || !requestOrigin || !storefrontOrigins.includes(requestOrigin)) return refuse("FORBIDDEN", 403);
    cors.set("Access-Control-Allow-Origin", requestOrigin);
    cors.set("Access-Control-Allow-Credentials", "true");
    if (storefrontLogout && request.method === "OPTIONS") {
      if (request.headers.get("access-control-request-method") !== "POST" ||
        request.headers.get("access-control-request-headers")?.trim().toLowerCase() !== "x-flex-navbar") return refuse("FORBIDDEN", 403);
      cors.set("Access-Control-Allow-Methods", "POST");
      cors.set("Access-Control-Allow-Headers", "X-Flex-Navbar");
      return new Response(null, { status: 204, headers: cors });
    }
    if (storefrontRead ? request.method !== "GET" : request.method !== "POST" || request.headers.get("x-flex-navbar") !== "1") {
      return refuse("FORBIDDEN", 403);
    }
  } else if (request.headers.has("origin") && requestOrigin !== origin.origin) return refuse("FORBIDDEN", 403);

  const target = new URL(`/v1/${path.map(encodeURIComponent).join("/")}${source.search}`, upstream);
  const clientIp = ingressClientIp(request.headers);
  const headers = new Headers(request.headers);
  for (const key of DROPPED_REQUEST_HEADERS) headers.delete(key);
  headers.set("x-forwarded-host", origin.host);
  headers.set("x-forwarded-proto", origin.protocol.replace(":", ""));
  if (clientIp) headers.set("x-forwarded-for", clientIp);
  try {
    const response = await send(target, {
      method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000), duplex: "half",
    } as RequestInit & { duplex: "half" });
    const output = new Headers(response.headers);
    const maySetAccountCookie = request.method === "POST" && path[0] === "my"
      && (storefrontLogout || path.length === 2 && path[1] === "sign-out" || path.length === 3 && path[1] === "otp" && path[2] === "verify");
    if (output.getSetCookie().some(cookie => /;\s*domain\s*=/i.test(cookie)
      && (!maySetAccountCookie || !sessionCookie || !validSharedAccountSetCookie(cookie, sessionCookie)))) {
      await response.body?.cancel();
      return refuse("COMMERCE_COOKIE_REFUSED", 502);
    }
    const location = output.get("location");
    if (location && new URL(location, origin).origin !== origin.origin) {
      await response.body?.cancel();
      return refuse("COMMERCE_REDIRECT_REFUSED", 502);
    }
    for (const key of [...output.keys()]) if (key.startsWith("access-control-")) output.delete(key);
    if (storefrontRoute) {
      output.append("Vary", "Origin");
      output.set("Access-Control-Allow-Origin", cors.get("Access-Control-Allow-Origin")!);
      output.set("Access-Control-Allow-Credentials", "true");
    }
    output.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: output });
  } catch { return refuse("COMMERCE_UNAVAILABLE", 503); } // no URL, token or exception body in logs
}
