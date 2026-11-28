import { canaryCommerceRequest } from "./canary-http";
import { validatePlatformCanary } from "./canary-config";
import { platformOrigin } from "./origins";

const responseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const txPattern = "[A-Za-z0-9_-]{22}";
const codePattern = /^[A-Za-z0-9_-]{43}$/;
const lmsPath = /^(?:\/(?:account)?|\/courses\/[a-z0-9-]{1,80}(?:\/lessons\/[a-z0-9-]{1,120})?)$/;

export function lmsExchangeEnabled() {
  return process.env.MY_IDENTITY_MODE === "on" && Boolean(process.env.MY_ORIGIN?.trim());
}

const notFound = () => new Response(null, { status: 404, headers: responseHeaders });
const failed = () => new Response(null, { status: 303, headers: { ...responseHeaders, Location: "/auth/lms/failed" } });

/** The browser supplies its cookie and MY origin. Commerce supplies the state and destination. */
async function exchange(request: Request, action: "start" | "redeem", input: unknown) {
  const upstream = process.env.COMMERCE_INTERNAL_ORIGIN;
  if (!upstream) return failed();
  try {
    const my = new URL(process.env.MY_ORIGIN!);
    const platform = new URL(platformOrigin());
    if (my.protocol !== "https:" || my.origin === platform.origin || my.href !== my.origin + "/"
      || request.headers.get("host") !== platform.host) return failed();
    const headers = new Headers({
      "Content-Type": "application/json", "X-Forwarded-Host": platform.host, "X-Forwarded-Proto": platform.protocol.slice(0, -1),
    });
    const cookie = request.headers.get("cookie");
    if (cookie) headers.set("Cookie", cookie);
    if (action === "redeem") {
      if (request.headers.get("origin") !== my.origin) return failed();
      headers.set("Origin", my.origin);
    }
    const payload = JSON.stringify(input);
    const canary = validatePlatformCanary();
    if (canary) headers.set("Host", platform.host);
    const target = new URL(`/v1/lms/exchange/${action}`, upstream);
    const options = { method: "POST", headers, signal: AbortSignal.timeout(5000), redirect: "manual" as const, cache: "no-store" as const };
    const response = canary
      ? await canaryCommerceRequest(target, { ...options, body: new Response(payload).body })
      : await fetch(target, { ...options, body: payload });
    if (!response.ok) { await response.body?.cancel(); return failed(); }
    const { location } = await response.json() as { location?: unknown };
    if (typeof location !== "string") return failed();
    if (action === "start") {
      const next = new URL(location);
      if (next.origin !== my.origin || next.username || next.password || next.hash
        || next.pathname !== "/continue" || !new RegExp(`^\\?tx=${txPattern}$`).test(next.search)) return failed();
    } else if (!lmsPath.test(location)) return failed();

    const result = new Headers({ ...responseHeaders, Location: location });
    const cookies = response.headers.getSetCookie();
    if (cookies.some(value => !/^__Host-flx-lms(?:=|-x-[A-Za-z0-9_-]{22}=)/.test(value)
      || /;\s*domain\s*=/i.test(value))) return failed();
    for (const value of cookies) result.append("Set-Cookie", value);
    return new Response(null, { status: 303, headers: result });
  } catch { return failed(); }
}

export function startExchange(request: Request) {
  if (!lmsExchangeEnabled()) return notFound();
  const next = new URL(request.url).searchParams.get("next");
  if (process.env.MY_SESSION_COOKIE_DOMAIN?.trim()) {
    const my = URL.parse(process.env.MY_ORIGIN!);
    const platform = URL.parse(platformOrigin());
    if (my?.protocol !== "https:" || my.href !== my.origin + "/" || !platform ||
      (request.headers.get("host") ?? new URL(request.url).host) !== platform.host) return failed();
    const destination = new URL("/sign-in", my);
    destination.searchParams.set("lmsNext", next && lmsPath.test(next) && next !== "/account" ? next : "/courses");
    return new Response(null, { status: 303, headers: { ...responseHeaders, Location: destination.href } });
  }
  return exchange(request, "start", { next });
}

export async function redeemExchange(request: Request) {
  if (!lmsExchangeEnabled() || process.env.MY_SESSION_COOKIE_DOMAIN?.trim()) return notFound();
  if (!request.body || request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") return failed();
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256) { await reader.cancel(); return failed(); }
      body += decoder.decode(value, { stream: true });
    }
  } catch { return failed(); }
  finally { reader.releaseLock(); }
  const form = new URLSearchParams(body + decoder.decode());
  const tx = form.get("tx"), code = form.get("code");
  if (!tx || !new RegExp(`^${txPattern}$`).test(tx) || !code || !codePattern.test(code)) return failed();
  return exchange(request, "redeem", { tx, code });
}

export function exchangeFailed() {
  if (!lmsExchangeEnabled()) return notFound();
  return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="robots" content="noindex"><title>Вход не завершён</title><main><h1>Вход не завершён</h1><p>Вернитесь к выбранному курсу и попробуйте ещё раз.</p><a href="/courses">Вернуться к курсам</a></main></html>',
    { headers: { ...responseHeaders, "Content-Type": "text/html; charset=utf-8" } });
}
