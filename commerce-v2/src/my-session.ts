import { createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { Context, Next } from "hono";
import type { CommerceOrigins } from "./origins";

/** FLEX-120/121 session audiences. Contract: docs/plans/2026-11-20-my-identity-session-exchange-design.md §1, §3. */
export type Surface = "MY" | "LMS" | "LAB";
export type SessionKind = "MY" | "LMS" | "LEGACY";
export type MyIdentityMode = "off" | "on";
export type MyIdentityConfig = { readonly mode: MyIdentityMode; readonly origins: CommerceOrigins };
type Environment = Readonly<Record<string, string | undefined>>;

export const LMS_SESSION_COOKIE = "__Host-flx-lms";

/** Which credential kind each surface admits. Mode `off` is today's Stage A behaviour. */
export const ADMITTED_SESSION_KINDS: Readonly<Record<MyIdentityMode, Readonly<Record<Surface, readonly SessionKind[]>>>> = {
  off: { MY: [], LMS: ["LEGACY"], LAB: ["LEGACY"] },
  on: { MY: ["MY"], LMS: ["LMS"], LAB: ["LEGACY"] },
};

/** Same scheme and same last two DNS labels (or both localhost). Correct for single-label public
 * suffixes such as `.ru`; Commerce ships no Public Suffix List (contract §1 item 5). */
export function sameSite(first: string, second: string) {
  const a = new URL(first); const b = new URL(second);
  if (a.protocol !== b.protocol) return false;
  if (a.hostname === "localhost" || b.hostname === "localhost") return a.hostname === b.hostname;
  const site = (host: string) => host.split(".").slice(-2).join(".");
  return host2(a.hostname) && host2(b.hostname) && site(a.hostname) === site(b.hostname);
}
const host2 = (host: string) => host.split(".").length >= 2 && !/^\d+(?:\.\d+){3}$/.test(host);

export function loadMyIdentityConfig(environment: Environment, origins: CommerceOrigins): MyIdentityConfig {
  const mode = (environment.MY_IDENTITY_MODE?.trim() || "off") as MyIdentityMode;
  if (mode !== "off" && mode !== "on") throw new Error("MY_IDENTITY_MODE_INVALID");
  if (mode === "on") {
    if (!origins.my) throw new Error("MY_ORIGIN_REQUIRED");
    if (!sameSite(origins.my, origins.platform)) throw new Error("MY_ORIGIN_NOT_SAME_SITE");
  }
  return { mode, origins };
}

/** Surface from the host the trusted proxy set; never from a body, query, cookie or Origin. */
export function surfaceForRequest(origins: CommerceOrigins, headers: Headers): Surface | undefined {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]?.trim().toLowerCase();
  if (!host) return undefined;
  const candidates: Array<[Surface, string | undefined]> = [["MY", origins.my], ["LMS", origins.platform], ["LAB", origins.lab]];
  return candidates.find(([, origin]) => origin && new URL(origin).host === host)?.[0];
}

export function presentedCookie(headers: Headers, name: string) {
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
export const equalHex = (first: string, second: string) =>
  first.length === second.length && timingSafeEqual(Buffer.from(first, "hex"), Buffer.from(second, "hex"));

/** §2 confirmed customer: live binding, verified e-mail equal to the customer's normalized e-mail. */
export function confirmedCustomerForUser(db: Database.Database, authUserId: string): string | null {
  const row = db.prepare(`SELECT c.id FROM customers c JOIN "user" u ON u.id=c.auth_user_id
    WHERE u.id=? AND u.email_verified=1 AND lower(trim(u.email))=c.email_normalized`).get(authUserId) as { id: string } | undefined;
  return row?.id ?? null;
}

/** §3 rule 5: one join evaluated on every LMS request; a stale binding never extends access. */
export function resolveLmsSession(db: Database.Database, token: string, now: Date) {
  const at = now.toISOString();
  const row = db.prepare(`SELECT l.id AS lmsSessionId, l.customer_id AS customerId, s.id AS parentSessionId, s.user_id AS userId
    FROM lms_sessions l JOIN "session" s ON s.id=l.parent_session_id
    WHERE l.token_sha256=? AND l.expires_at>? AND s.audience='MY' AND s.expires_at>?`).get(sha256Hex(token), at, at) as
    { lmsSessionId: string; customerId: string; parentSessionId: string; userId: string } | undefined;
  if (!row || confirmedCustomerForUser(db, row.userId) !== row.customerId) return null;
  return row;
}

export type BetterAuthSession = { session: { id: string; audience?: string | null }; user: { id: string; email: string } };
export type ResolvedSession = { surface: Surface; kind: SessionKind; customerId: string; sessionId: string };

export function createSessionResolver(dependencies: {
  readonly db: Database.Database;
  readonly config: MyIdentityConfig;
  readonly getSession: (headers: Headers) => Promise<BetterAuthSession | null>;
  /** Exactly today's resolution (Better Auth session → bound customer). Used verbatim in mode `off`. */
  readonly legacyAuthenticate: (headers: Headers) => Promise<string | null>;
  readonly assertIdentity?: (identity: { email?: string; userId?: string }) => void;
  readonly now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());
  const { db, config } = dependencies;

  async function resolve(headers: Headers): Promise<ResolvedSession | null> {
    const surface = surfaceForRequest(config.origins, headers);
    if (!surface) return null;
    const admitted = ADMITTED_SESSION_KINDS[config.mode][surface];
    if (admitted.includes("LMS")) {
      const token = presentedCookie(headers, LMS_SESSION_COOKIE);
      const row = token ? resolveLmsSession(db, token, now()) : null;
      if (!row) return null;
      dependencies.assertIdentity?.({ userId: row.userId });
      return { surface, kind: "LMS", customerId: row.customerId, sessionId: row.lmsSessionId };
    }
    if (!admitted.length) return null;
    const session = await dependencies.getSession(headers);
    if (!session?.user.id) return null;
    const kind: SessionKind = session.session.audience === "MY" ? "MY" : "LEGACY";
    if (!admitted.includes(kind)) return null;
    dependencies.assertIdentity?.({ email: session.user.email, userId: session.user.id });
    const customerId = kind === "MY" ? confirmedCustomerForUser(db, session.user.id)
      : db.prepare("SELECT id FROM customers WHERE auth_user_id=?").pluck().get(session.user.id) as string | undefined ?? null;
    return customerId ? { surface, kind, customerId, sessionId: session.session.id } : null;
  }

  return {
    resolve,
    /** Signature of today's `authenticateCustomer`; mode `off` delegates to it unchanged. */
    async authenticateCustomer(headers: Headers): Promise<string | null> {
      if (config.mode === "off") return dependencies.legacyAuthenticate(headers);
      return (await resolve(headers))?.customerId ?? null;
    },
  };
}

/** §3 rule 2 (mode `on`): route groups of one surface refuse the other even with a valid credential. */
const MY_ONLY = [/^\/v1\/my(?:\/|$)/, /^\/v1\/checkout(?:\/|$)/, /^\/v1\/refunds$/, /^\/v1\/me\/orders$/];
const LMS_ONLY = [/^\/v1\/me\/course-library$/, /^\/v1\/me\/courses(?:\/|$)/, /^\/v1\/library$/, /^\/v1\/lessons\//, /^\/v1\/lms(?:\/|$)/];
const MY_ONLY_METHOD: Array<[string, RegExp]> = [["POST", /^\/v1\/me\/consents$/]];
const noStore = { "Cache-Control": "no-store" };

/** Better Auth plugin paths that are only ever called server-side (never through `/v1/auth/*`). */
const SERVER_ONLY_AUTH = /^\/v1\/auth\/(?:email-otp\/|sign-in\/email-otp(?:\/|$)|one-time-token\/)/;

export function sessionAudienceGuard(config: MyIdentityConfig) {
  return async (context: Context, next: Next) => {
    const path = context.req.path;
    // Both modes: the OTP plugin never answers on the public auth router.
    if (SERVER_ONLY_AUTH.test(path)) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    if (config.mode === "off") {
      if (/^\/v1\/(?:my|lms)(?:\/|$)/.test(path)) return context.json({ code: "NOT_FOUND" }, 404, noStore);
      await next(); return;
    }
    const surface = surfaceForRequest(config.origins, context.req.raw.headers);
    // A surface's own namespace does not exist anywhere else.
    if (surface !== "MY" && /^\/v1\/my(?:\/|$)/.test(path)) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    if (surface !== "LMS" && /^\/v1\/lms(?:\/|$)/.test(path)) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    const forbidden = surface === "LMS" ? MY_ONLY.some(rule => rule.test(path))
      || MY_ONLY_METHOD.some(([method, rule]) => method === context.req.method && rule.test(path))
      : surface === "MY" ? LMS_ONLY.some(rule => rule.test(path)) : false;
    if (forbidden) return context.json({ code: "SESSION_AUDIENCE_FORBIDDEN" }, 403, noStore);
    if (/^\/v1\/auth(?:\/|$)/.test(path)) {
      // MY signs in only through /v1/my/*; the LMS retires Stage A magic links (contract §1, §9).
      if (surface === "LMS" && /^\/v1\/auth\/(?:sign-in\/magic-link|magic-link\/)/.test(path)) {
        return context.json({ code: "MAGIC_LINK_RETIRED" }, 410, noStore);
      }
      if (surface === "MY" || surface === "LMS") return context.json({ code: "NOT_FOUND" }, 404, noStore);
    }
    await next();
  };
}

/** §7 exact return-target allowlists (fixture return-targets.json is normative). Invalid ⇒ default. */
const RETURN_TARGETS: Readonly<Record<"MY" | "LMS", readonly RegExp[]>> = {
  LMS: [/^\/courses\/[a-z0-9-]{1,80}(?:\/lessons\/[a-z0-9-]{1,120})?$/, /^\/account$/],
  MY: [/^\/$/, /^\/continue\?tx=[A-Za-z0-9_-]{22}$/, /^\/orders$/, /^\/profile$/, /^\/checkout\/[A-Za-z0-9_-]{16,64}$/],
};
export function validReturnTarget(surface: "MY" | "LMS", value: unknown): string {
  return typeof value === "string" && value.length <= 256 && RETURN_TARGETS[surface].some(rule => rule.test(value)) ? value : "/";
}

/** `a***@e***.test`: enough for a Navbar, never the full address on LMS/LAB (contract §10). */
export function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  const dot = domain.lastIndexOf(".");
  const head = dot > 0 ? domain.slice(0, dot) : domain;
  return `${local.slice(0, 1)}***@${head.slice(0, 1)}***${dot > 0 ? domain.slice(dot) : ""}`;
}

/** The client address the surface proxy set (first `x-forwarded-for` hop); used only for rate limits. */
export const clientIpOf = (headers: Headers) => headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
