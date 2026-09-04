import { createHash, randomBytes } from "node:crypto";

/**
 * Partner-realm authentication primitives. A SEPARATE realm from
 * commerce/src/auth.ts's admin session - never a union `Session { role }`
 * that could let one realm's credential parse as another's. Where auth.ts's
 * admin session is a signed, self-contained token (HMAC over sub/sid/exp),
 * the partner session is deliberately the opposite shape: an opaque,
 * high-entropy random token whose hash alone is durable, so revocation
 * deletes server authority rather than trusting the client to discard a
 * cookie, per plan section B-2.
 */

export const PARTNER_SESSION_TTL_MS = 12 * 60 * 60_000;
const PARTNER_SESSION_COOKIE_NAME = "fx_partner_session";
const partnerOrigin = process.env.COMMERCE_PARTNER_ORIGIN ?? "https://partner.flexperiment.ru";

/**
 * Mirrors auth.ts's assertAdminOrigin exactly, for the SEPARATE partner
 * realm/hostname (Phase 9 shared-frontend topology). admin.flexperiment.ru
 * and partner.flexperiment.ru are different browser origins even though
 * both are served by the same frontend container, so an admin-origin
 * browser request can never satisfy this check and vice versa - the origin
 * check is independent of, and in addition to, the session cookie's own
 * host-only scope.
 */
export const assertPartnerOrigin = (origin: string | undefined) => !origin || origin === partnerOrigin;

export const generateOpaqueToken = () => randomBytes(32).toString("base64url");
export const hashOpaqueToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Exact configured contract: HttpOnly, Secure, explicit SameSite, explicit Path, explicit Max-Age. */
export const partnerSessionCookie = (token: string, maxAgeSeconds: number) =>
  `${PARTNER_SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;

/** Logout must invalidate server authority (see revokePartnerSession); this only ever accompanies that, never replaces it. */
export const partnerSessionCookieCleared = () =>
  `${PARTNER_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

/**
 * Reads ONLY the fx_partner_session cookie - an fx_admin_session cookie in
 * the same header is invisible to this parser by construction, since it
 * looks for a differently-named key. This is what "partner cookie accepted
 * only by partner parser, admin cookie refused by partner parser" reduces
 * to: two parsers reading two different cookie names out of the same header
 * can never cross-accept each other's credential.
 */
export const parsePartnerSessionToken = (cookieHeader: string | undefined): string | undefined =>
  cookieHeader?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${PARTNER_SESSION_COOKIE_NAME}=`))?.slice(`${PARTNER_SESSION_COOKIE_NAME}=`.length) || undefined;
