import type Database from "better-sqlite3";

/** FLEX-120: the only non-JSON `verification` shape admitted by retention and erasure.
 * Better Auth 1.7.6 `emailOTP` (storeOTP "hashed", plain identifier storage) writes
 * identifier `sign-in-otp-<normalized email>` and value `<sha256 base64url>:<attempts>`. */
const OTP_IDENTIFIER = /^sign-in-otp-(.+)$/;
const OTP_VALUE = /^[A-Za-z0-9_-]{43}:\d{1,2}$/;

/** The subject e-mail of a verification row, or `null` when the row is unclassified.
 * Magic-link rows are JSON `{email}`; OTP rows carry the e-mail in the identifier. */
export function verificationSubjectEmail(row: { readonly identifier?: unknown; readonly value?: unknown }): string | null {
  const identifier = String(row.identifier);
  const value = String(row.value);
  const otp = OTP_IDENTIFIER.exec(identifier);
  if (otp && OTP_VALUE.test(value)) return otp[1].trim().toLocaleLowerCase("en-US");
  let body: unknown;
  try { body = JSON.parse(value); } catch { return null; }
  if (!body || typeof body !== "object" || typeof (body as { email?: unknown }).email !== "string") return null;
  return (body as { email: string }).email.trim().toLocaleLowerCase("en-US");
}

export const hasTable = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
