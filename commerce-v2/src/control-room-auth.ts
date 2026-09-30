import { createHash, createHmac, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

export const CONTROL_ROOM_SESSION_TTL_MS = 12 * 60 * 60_000;

export type ControlRoomAuthConfig = {
  origin: string;
  passwordScrypt: string;
  sessionSecret: string;
};

export type ControlRoomSession = { sub: string; sid: string; exp: number };

const matches = (actual: string, expected: string) => actual.length === expected.length
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));

export function verifyControlRoomPassword(password: string, encoded: string) {
  const [algorithm, version, rawN, rawR, rawP, encodedSalt, expected, ...rest] = encoded.split(":");
  if (rest.length || algorithm !== "scrypt" || version !== "v1" || rawN !== "16384" || rawR !== "8" || rawP !== "1"
    || !encodedSalt || !expected) return false;
  const salt = Buffer.from(encodedSalt, "base64url");
  if (salt.length !== 16 || salt.toString("base64url") !== encodedSalt) return false;
  try {
    return matches(scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url"), expected);
  } catch { return false; }
}

const validSession = (value: unknown): value is ControlRoomSession => {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ControlRoomSession>;
  return typeof session.sub === "string" && session.sub.length > 0
    && typeof session.sid === "string" && /^[0-9a-f-]{36}$/i.test(session.sid)
    && typeof session.exp === "number" && Number.isSafeInteger(session.exp);
};

const signature = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("base64url");

export function issueControlRoomSession(secret: string, adminId = "singleton-admin", now = Date.now()) {
  const session = { sub: adminId, sid: randomUUID(), exp: now + CONTROL_ROOM_SESSION_TTL_MS } satisfies ControlRoomSession;
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { session, token: `${payload}.${signature(secret, payload)}` };
}

export function parseControlRoomSession(cookie: string | undefined, secret: string, now = Date.now()) {
  const token = cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("fx_admin_session="))?.slice("fx_admin_session=".length);
  if (!token) return undefined;
  const [payload, presented, ...rest] = token.split(".");
  if (rest.length || !payload || !presented || !matches(presented, signature(secret, payload))) return undefined;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return validSession(session) && session.exp > now ? session : undefined;
  } catch { return undefined; }
}

export const controlRoomSessionCookie = (value: string, maxAgeSeconds: number) =>
  `fx_admin_session=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;

export function consumeControlRoomLoginLimit(
  db: Database.Database,
  input: { source: string; secret: string; now: Date; windowMs: number; limit: number; label: string },
) {
  const window = Math.floor(input.now.getTime() / input.windowMs) * input.windowMs;
  const windowStart = new Date(window).toISOString();
  const sourceHash = createHash("sha256").update(`${input.secret}:${input.source}`).digest("hex");
  const key = `${input.label}:${sourceHash}`;
  const row = db.prepare(`INSERT INTO control_room_login_rate_limits(rate_key,window_start,attempt_count) VALUES (?,?,1)
    ON CONFLICT(rate_key,window_start) DO UPDATE SET attempt_count=attempt_count+1 RETURNING attempt_count`)
    .get(key, windowStart) as { attempt_count: number };
  if (row.attempt_count > input.limit) throw new Error("RATE_LIMITED");
}

export function auditControlRoom(
  db: Database.Database,
  input: { adminId: string; action: string; entityType: string; entityId: string; details?: Record<string, unknown> },
  now = new Date().toISOString(),
) {
  db.prepare(`INSERT INTO control_room_audit_log(id,admin_id,action,entity_type,entity_id,details_json,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), input.adminId, input.action, input.entityType, input.entityId,
      JSON.stringify(input.details ?? {}, (key, value) => /email|authorization|cookie|password/i.test(key) ? "[REDACTED]" : value), now);
}
