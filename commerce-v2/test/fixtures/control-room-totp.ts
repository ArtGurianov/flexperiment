import type Database from "better-sqlite3";
import { acceptControlRoomTotp, enrollControlRoomTotp, hotp, totpStep, TOTP_STEP_SECONDS } from "../../src/control-room-totp";

export const testTotpKey = Buffer.alloc(32, 9);

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(text: string) {
  let bits = 0, value = 0; const out: number[] = [];
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/**
 * A confirmed second factor for a fixed test clock: confirmation spends a step two before `at`, and
 * each next() is the code of the following step, so a test can log in up to three times at `at`.
 */
export function enrolledTotp(db: Database.Database, at: Date) {
  const seed = base32Decode(enrollControlRoomTotp(db, testTotpKey, at).secret);
  const confirmAt = new Date(at.getTime() - 2 * TOTP_STEP_SECONDS * 1000);
  if (!acceptControlRoomTotp(db, testTotpKey, hotp(seed, totpStep(confirmAt)), confirmAt, { confirming: true })) throw new Error("TEST_TOTP_CONFIRM");
  let step = totpStep(at) - 1;
  return { seed, next: () => hotp(seed, step++) };
}
