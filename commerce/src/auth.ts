import { createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

const sessionSecret = process.env.COMMERCE_SESSION_SECRET ?? "development-only-session-secret-change-before-production";
const passwordHash = process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
const adminOrigin = process.env.COMMERCE_ADMIN_ORIGIN ?? "https://admin.flexperiment.ru";

export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60_000;

export type Session = { sub: string; sid: string; exp: number };

const b64 = (value: string) => Buffer.from(value).toString("base64url");
const unb64 = (value: string) => Buffer.from(value, "base64url").toString("utf8");
const sign = (value: string) => createHmac("sha256", sessionSecret).update(value).digest("base64url");
const matches = (actual: string, expected: string) => actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

const versionedScrypt = (password: string, encoded: string) => {
  const [algorithm, version, rawN, rawR, rawP, encodedSalt, expected, ...rest] = encoded.split(":");
  if (rest.length || algorithm !== "scrypt" || version !== "v1" || rawN !== "16384" || rawR !== "8" || rawP !== "1" || !encodedSalt || !expected) return false;
  const salt = Buffer.from(encodedSalt, "base64url");
  if (salt.length !== 16 || salt.toString("base64url") !== encodedSalt) return false;
  try {
    return matches(scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url"), expected);
  } catch { return false; }
};

export function verifyAdminPassword(password: string) {
  if (process.env.NODE_ENV === "production" && !process.env.COMMERCE_SESSION_SECRET) return false;
  if (!passwordHash) return false;
  if (passwordHash.startsWith("scrypt:v1:")) return versionedScrypt(password, passwordHash);
  const [salt, expected] = passwordHash.split(":");
  if (!salt || !expected) return false;
  const legacy = scryptSync(password, salt, 64).toString("base64url");
  if (matches(legacy, expected)) return true;
  // Compatibility for the briefly documented `base64url-salt:hash` form.
  // New deployments must use the versioned form emitted by the generator.
  const decodedSalt = Buffer.from(salt, "base64url");
  if (!decodedSalt.length || decodedSalt.toString("base64url") !== salt) return false;
  try {
    return matches(scryptSync(password, decodedSalt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url"), expected);
  } catch { return false; }
}

const sessionPayloadIsValid = (value: unknown): value is Session => {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<Session>;
  return typeof session.sub === "string" && session.sub.length > 0
    && typeof session.sid === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session.sid)
    && typeof session.exp === "number" && Number.isSafeInteger(session.exp);
};

export function issueAdminSession(adminId = "singleton-admin", now = Date.now()) {
  const session = { sub: adminId, sid: randomUUID(), exp: now + ADMIN_SESSION_TTL_MS } satisfies Session;
  const payload = b64(JSON.stringify(session));
  return `${payload}.${sign(payload)}`;
}

export function parseSession(cookie: string | undefined): Session | undefined {
  const token = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("fx_admin_session="))?.slice("fx_admin_session=".length);
  if (!token) return undefined;
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payload, signature] = parts;
  if (!payload || !signature || signature.length !== sign(payload).length || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return undefined;
  try {
    const session = JSON.parse(unb64(payload)) as unknown;
    return sessionPayloadIsValid(session) && session.exp > Date.now() ? session : undefined;
  } catch { return undefined; }
}

export const assertAdminOrigin = (origin: string | undefined) => !origin || origin === adminOrigin;

/** Dedicated machine credential for release-control only; never a browser/Admin session. */
export const verifyReleaseControlToken = (authorization: string | undefined) => {
  const expected = process.env.COMMERCE_RELEASE_CONTROL_TOKEN;
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
  if (!expected || !presented || expected.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
};
