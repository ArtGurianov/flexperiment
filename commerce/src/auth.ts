import { createHmac, scryptSync, timingSafeEqual } from "node:crypto";

const sessionSecret = process.env.COMMERCE_SESSION_SECRET ?? "development-only-session-secret-change-before-production";
const passwordHash = process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
const adminOrigin = process.env.COMMERCE_ADMIN_ORIGIN ?? "https://admin.flexperiment.ru";

type Session = { sub: string; exp: number };

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
