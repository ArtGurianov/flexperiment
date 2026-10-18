import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Control Room TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), the second factor of the
 * single owner account (ART-31). The seed is stored only encrypted (AES-256-GCM under
 * CONTROL_ROOM_TOTP_KEY, bound to the admin id). A code is accepted for one step at most once and
 * never for a step at or before the last accepted one. There are no recovery codes: recovery is
 * `owner-cli totp reset` over SSH, which revokes every session.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Clock drift tolerated on either side of the current step. */
export const TOTP_DRIFT_STEPS = 1;
/** Code checks per 30-second step for the account, so a known password cannot brute-force codes. */
export const TOTP_CHECKS_PER_STEP = 3;
export const CONTROL_ROOM_ADMIN_ID = "singleton-admin";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer) {
  let bits = 0, value = 0, out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function hotp(seed: Buffer, counter: number, digits = TOTP_DIGITS) {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("TOTP_COUNTER_INVALID");
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", seed).update(message).digest();
  const offset = mac[mac.length - 1] & 15;
  const binary = ((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
export const totp = (seed: Buffer, at: Date, digits = TOTP_DIGITS) => hotp(seed, totpStep(at), digits);

/** A 32-byte AES key, base64url, from the environment; anything else is a configuration error. */
export function controlRoomTotpKey(value: string | undefined) {
  if (!value) return undefined;
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) throw new Error("CONTROL_ROOM_TOTP_KEY_INVALID");
  return key;
}

function encryptSeed(key: Buffer, adminId: string, seed: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`flexperiment.control-room-totp/1:${adminId}`));
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((part) => typeof part === "string" ? part : part.toString("base64url")).join(".");
}

function decryptSeed(key: Buffer, adminId: string, encoded: string) {
  const [version, iv, tag, ciphertext, ...rest] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext || rest.length) throw new Error("CONTROL_ROOM_TOTP_SEED_INVALID");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`flexperiment.control-room-totp/1:${adminId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
  } catch { throw new Error("CONTROL_ROOM_TOTP_SEED_INVALID"); }
}

type Row = { seed_ciphertext: string; last_accepted_step: number | null; confirmed_at: string | null };
const row = (db: Database.Database, adminId: string) => db.prepare(
  "SELECT seed_ciphertext,last_accepted_step,confirmed_at FROM control_room_totp WHERE admin_id=?").get(adminId) as Row | undefined;

/** The step a code matches within the drift window, or undefined. Constant work per candidate. */
function matchingStep(seed: Buffer, code: unknown, at: Date) {
  if (typeof code !== "string" || !/^[0-9]{6}$/.test(code)) return undefined;
  const now = totpStep(at);
  let found: number | undefined;
  for (let step = now - TOTP_DRIFT_STEPS; step <= now + TOTP_DRIFT_STEPS; step += 1) {
    if (timingSafeEqual(Buffer.from(hotp(seed, step)), Buffer.from(code)) && found === undefined) found = step;
  }
  return found;
}

/** A new, unconfirmed seed; refused while a confirmed one exists (reset first). */
export function enrollControlRoomTotp(db: Database.Database, key: Buffer, now: Date, adminId = CONTROL_ROOM_ADMIN_ID) {
  if (row(db, adminId)?.confirmed_at) throw new Error("CONTROL_ROOM_TOTP_ALREADY_ENROLLED");
  const seed = randomBytes(20);
  db.prepare(`INSERT INTO control_room_totp(admin_id,seed_ciphertext,last_accepted_step,enrolled_at,confirmed_at)
    VALUES (?,?,NULL,?,NULL) ON CONFLICT(admin_id) DO UPDATE SET seed_ciphertext=excluded.seed_ciphertext,
    last_accepted_step=NULL,enrolled_at=excluded.enrolled_at,confirmed_at=NULL`).run(adminId, encryptSeed(key, adminId, seed), now.toISOString());
  const secret = base32Encode(seed);
  return { secret, otpauthUri: `otpauth://totp/Flexperiment:Control%20Room?secret=${secret}&issuer=Flexperiment&algorithm=SHA1&digits=6&period=30` };
}

/**
 * Accepts a code once: the step must match and be later than the last accepted step, and the
 * update is conditional, so two concurrent requests with the same code cannot both pass.
 */
export function acceptControlRoomTotp(db: Database.Database, key: Buffer, code: unknown, now: Date,
  options: { confirming?: boolean } = {}, adminId = CONTROL_ROOM_ADMIN_ID) {
  const current = row(db, adminId);
  if (!current) throw new Error("CONTROL_ROOM_TOTP_NOT_ENROLLED");
  if (Boolean(current.confirmed_at) === Boolean(options.confirming)) {
    throw new Error(options.confirming ? "CONTROL_ROOM_TOTP_ALREADY_ENROLLED" : "CONTROL_ROOM_TOTP_NOT_ENROLLED");
  }
  const step = matchingStep(decryptSeed(key, adminId, current.seed_ciphertext), code, now);
  if (step === undefined) return false;
  const accepted = db.prepare(`UPDATE control_room_totp SET last_accepted_step=?,confirmed_at=COALESCE(confirmed_at,?)
    WHERE admin_id=? AND (last_accepted_step IS NULL OR last_accepted_step<?)`).run(step, now.toISOString(), adminId, step);
  return accepted.changes === 1;
}

/** Recovery over SSH: no seed, no sessions. The owner enrolls again. */
export function resetControlRoomTotp(db: Database.Database, now: Date, adminId = CONTROL_ROOM_ADMIN_ID) {
  const removed = db.prepare("DELETE FROM control_room_totp WHERE admin_id=?").run(adminId).changes;
  const revoked = db.prepare("UPDATE control_room_admin_sessions SET revoked_at=? WHERE admin_id=? AND revoked_at IS NULL")
    .run(now.toISOString(), adminId).changes;
  return { totpRemoved: removed === 1, sessionsRevoked: revoked };
}
