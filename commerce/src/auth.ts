import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

const sessionSecret = process.env.COMMERCE_SESSION_SECRET ?? "development-only-session-secret-change-before-production";
const passwordHash = process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
const adminOrigin = process.env.COMMERCE_ADMIN_ORIGIN ?? "https://admin.flexperiment.ru";

type Session = { sub: string; exp: number };

const b64 = (value: string) => Buffer.from(value).toString("base64url");
const unb64 = (value: string) => Buffer.from(value, "base64url").toString("utf8");
const sign = (value: string) => createHmac("sha256", sessionSecret).update(value).digest("base64url");

export function verifyAdminPassword(password: string) {
  if (process.env.NODE_ENV === "production" && !process.env.COMMERCE_SESSION_SECRET) return false;
  if (!passwordHash) return false;
  const [salt, expected] = passwordHash.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64).toString("base64url");
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function makeSession(adminId = "singleton-admin") {
  const payload = b64(JSON.stringify({ sub: adminId, exp: Date.now() + 12 * 60 * 60_000 } satisfies Session));
  return `${payload}.${sign(payload)}`;
}

export function parseSession(cookie: string | undefined): Session | undefined {
  const token = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("fx_admin_session="))?.slice("fx_admin_session=".length);
  if (!token) return undefined;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || signature.length !== sign(payload).length || !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return undefined;
  try {
    const session = JSON.parse(unb64(payload)) as Session;
    return session.exp > Date.now() ? session : undefined;
  } catch { return undefined; }
}

export const assertAdminOrigin = (origin: string | undefined) => !origin || origin === adminOrigin;
