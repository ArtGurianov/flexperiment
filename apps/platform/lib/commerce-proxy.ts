import { canaryOrigins, validatePlatformCanary } from "./canary-config";

const allowedRoots = new Set(["auth", "me", "lessons", "checkout", "email", "legal"]);
const refuse = (code: string, status: number) => Response.json({ code }, {
  status, headers: { "Cache-Control": "no-store" },
});

export async function proxyCommerce(request: Request, path: string[]) {
  let canary: boolean;
  try { canary = validatePlatformCanary(); }
  catch { return refuse("COMMERCE_NOT_CONFIGURED", 503); }
  const origin = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!origin) return refuse("COMMERCE_NOT_CONFIGURED", 503);
  if (!path[0] || !allowedRoots.has(path[0])
    || path.some((part) => !part || /[\\/\x00-\x1f\x7f]/.test(part) || part === "." || part === "..")) return refuse("NOT_FOUND", 404);
  const source = new URL(request.url);
  const host = canary ? new URL(canaryOrigins.PLATFORM_ORIGIN).host : source.host;
  if (canary && (request.headers.get("host") !== host
    || (request.headers.has("origin") && request.headers.get("origin") !== canaryOrigins.PLATFORM_ORIGIN))) return refuse("FORBIDDEN", 403);
  const target = new URL(`/v1/${path.map(encodeURIComponent).join("/")}${source.search}`, origin);
  const headers = new Headers(request.headers);
  for (const key of ["host", "content-length", "connection", "forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-port"]) headers.delete(key);
  if (canary) headers.set("host", host);
  headers.set("x-forwarded-host", host);
  headers.set("x-forwarded-proto", canary ? "https" : source.protocol.replace(":", ""));
  try {
    const response = await fetch(target, {
      method: request.method, headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(5000), duplex: "half",
    } as RequestInit & { duplex: "half" });
    const output = new Headers(response.headers);
    if (canary) {
      if (output.getSetCookie().some((cookie) => /;\s*domain\s*=/i.test(cookie))) {
        await response.body?.cancel();
        return refuse("COMMERCE_COOKIE_REFUSED", 502);
      }
      const location = output.get("location");
      if (location && new URL(location, canaryOrigins.PLATFORM_ORIGIN).origin !== canaryOrigins.PLATFORM_ORIGIN) {
        await response.body?.cancel();
        return refuse("COMMERCE_REDIRECT_REFUSED", 502);
      }
      for (const key of [...output.keys()]) if (key.startsWith("access-control-")) output.delete(key);
    }
    output.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: output });
  } catch { return refuse("COMMERCE_UNAVAILABLE", 503); } // no URL, token or exception body in logs
}
