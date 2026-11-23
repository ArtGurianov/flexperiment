import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { labEmail } from "./lab-tickets";
import type { LabInterestManifest } from "./lab-interest-legal";

/**
 * FLEX-8 (owner decision 2026-11-22): interest in LAB sales while they are closed.
 *
 * A signup is a request to receive ONE kind of message: "LAB sales are open" (purpose
 * LAB_SALES_NOTICE). It is not a reservation, ticket, order, quote, hold or customer account, and
 * it never touches payment state. It is double opt-in: only a CONFIRMED signup may receive a notice,
 * so nobody can enrol another person's address. A withdrawal deletes the row; the global
 * email_suppressions list (campaign one-click unsubscribe, erasure) is honoured at every send.
 */

const interestSuppressed = (db: Database.Database, email: string) => db.prepare(`
  SELECT 1 FROM lab_interest_suppressions WHERE email_normalized=?
  UNION ALL SELECT 1 FROM email_suppressions WHERE email_normalized=? AND removed_at IS NULL
  LIMIT 1`).get(email, email);
export const LAB_INTEREST_PURPOSE = "LAB_SALES_NOTICE" as const;
const CONFIRM_TTL_MS = 48 * 3600 * 1000;
type Consent = LabInterestManifest["consent"];
// SQLite's floor modifier clamps February 29 to February 28 in the following year.
const CONFIRMED_EXPIRY = "julianday(confirmed_at, '+12 months', 'floor')";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class LabInterestError extends Error {
  constructor(code: string) { super(code); this.name = "LabInterestError"; }
}
const fail = (code: string): never => { throw new LabInterestError(code); };

export type LabInterestEmail =
  | { kind: "CONFIRM"; email: string; confirmUrl: string; withdrawUrl: string; cityTitle: string | null }
  | { kind: "NOTICE"; email: string; noticeKey: string; subject: string; message: string; storefrontUrl: string; withdrawUrl: string;
    headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };

type SignupRow = {
  id: string; email_normalized: string; city_id: string | null; state: "PENDING" | "CONFIRMED";
  confirm_expires_at: string | null; consent_text_version: string; consent_text_sha256: string;
};

/** The withdrawal capability is derived, never stored: HMAC(secret, signup id). */
export function labInterestWithdrawToken(signupId: string, secret: string) {
  if (!secret) fail("LAB_INTEREST_SECRET_REQUIRED");
  const mac = createHmac("sha256", secret).update(`flexperiment.lab-interest.withdraw/1:${signupId}`).digest("base64url");
  return `${Buffer.from(signupId).toString("base64url")}.${mac}`;
}

const withdrawUrl = (origin: string, signupId: string, secret: string) =>
  `${origin}/interest#withdraw=${labInterestWithdrawToken(signupId, secret)}`;

export type LabInterestRequest = { email: unknown; cityId?: unknown; consent?: { version?: unknown; textSha256?: unknown } };

/**
 * Records (or refreshes) a PENDING signup and returns the confirmation message to send, or null when
 * nothing is to be sent (already confirmed, globally suppressed). The caller answers the same way in
 * every case, so the endpoint never reveals whether an address is known.
 */
export function requestLabInterest(db: Database.Database, input: LabInterestRequest, deps: { origin: string; secret: string; consent: Consent },
  now: string): { signupId: string; confirmationDigest: string; message: Extract<LabInterestEmail, { kind: "CONFIRM" }> } | null {
  const email = labEmail(input.email);
  if (input.consent?.version !== deps.consent.version || input.consent?.textSha256 !== deps.consent.textSha256) {
    fail("LAB_INTEREST_CONSENT_REQUIRED");
  }
  if (typeof input.cityId !== "string" || input.cityId.length > 128) fail("LAB_INTEREST_CITY_INVALID");
  const city = db.prepare("SELECT id,title FROM cities WHERE id=?").get(input.cityId) as { id: string; title: string } | undefined;
  if (!city) return fail("LAB_INTEREST_CITY_INVALID");
  const { id: cityId, title: cityTitle } = city;
  return db.transaction(() => {
    if (interestSuppressed(db, email)) return null;
    db.prepare(`DELETE FROM lab_interest_signups WHERE email_normalized=? AND city_id=? AND state='CONFIRMED'
      AND ${CONFIRMED_EXPIRY}<=julianday(?)`).run(email, cityId, now);
    const existing = db.prepare("SELECT * FROM lab_interest_signups WHERE email_normalized=? AND city_id=?")
      .get(email, cityId) as SignupRow | undefined;
    const sameConsent = existing?.consent_text_version === deps.consent.version
      && existing?.consent_text_sha256 === deps.consent.textSha256;
    if (existing?.state === "CONFIRMED"
      || (sameConsent && existing?.confirm_expires_at && Date.parse(existing.confirm_expires_at) > Date.parse(now))) return null;
    const token = randomBytes(32).toString("base64url");
    const confirmationDigest = sha256(token);
    const expires = new Date(Date.parse(now) + CONFIRM_TTL_MS).toISOString();
    const id = existing?.id ?? randomUUID().replace(/-/g, "");
    if (existing) {
      db.prepare(`UPDATE lab_interest_signups SET confirm_token_sha256=?,confirm_expires_at=?,consent_text_version=?,consent_text_sha256=?
        WHERE id=? AND state='PENDING'`).run(confirmationDigest, expires, deps.consent.version, deps.consent.textSha256, id);
    } else {
      db.prepare(`INSERT INTO lab_interest_signups(id,email_normalized,city_id,state,purpose,consent_text_version,consent_text_sha256,
        confirm_token_sha256,confirm_expires_at,created_at,confirmed_at) VALUES (?,?,?,'PENDING',?,?,?,?,?,?,NULL)`)
        .run(id, email, cityId, LAB_INTEREST_PURPOSE, deps.consent.version, deps.consent.textSha256, confirmationDigest, expires, now);
    }
    return { signupId: id, confirmationDigest, message: { kind: "CONFIRM" as const, email, cityTitle, confirmUrl: `${deps.origin}/interest#confirm=${token}`,
      withdrawUrl: withdrawUrl(deps.origin, id, deps.secret) } };
  }).immediate();
}

/** A proven rejection can discard only the exact confirmation that failed. */
export function discardUndeliveredLabInterest(db: Database.Database, signupId: string, confirmationDigest: string) {
  db.prepare("DELETE FROM lab_interest_signups WHERE id=? AND state='PENDING' AND confirm_token_sha256=?").run(signupId, confirmationDigest);
}

export function confirmLabInterest(db: Database.Database, token: unknown, now: string, consent: Consent) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail("LAB_INTEREST_TOKEN_INVALID");
  return db.transaction(() => {
    const row = db.prepare("SELECT * FROM lab_interest_signups WHERE confirm_token_sha256=?").get(sha256(token as string)) as SignupRow | undefined;
    if (!row?.city_id || Date.parse(row.confirm_expires_at!) <= Date.parse(now)
      || row.consent_text_version !== consent.version || row.consent_text_sha256 !== consent.textSha256) fail("LAB_INTEREST_TOKEN_INVALID");
    if (interestSuppressed(db, row!.email_normalized)) {
      db.prepare("DELETE FROM lab_interest_signups WHERE id=?").run(row!.id);
      fail("LAB_INTEREST_TOKEN_INVALID");
    }
    db.prepare(`UPDATE lab_interest_signups SET state='CONFIRMED',confirmed_at=?,confirm_token_sha256=NULL,confirm_expires_at=NULL
      WHERE id=?`).run(now, row!.id);
    return { confirmed: true as const };
  }).immediate();
}

/** Withdrawal is idempotent and deletes the signup with its notice history. */
export function withdrawLabInterest(db: Database.Database, token: unknown, secret: string, now: string) {
  if (typeof token !== "string" || token.length > 256) fail("LAB_INTEREST_TOKEN_INVALID");
  const [encoded = "", presented = ""] = (token as string).split(".");
  const signupId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!/^[0-9a-f]{32}$/.test(signupId)) fail("LAB_INTEREST_TOKEN_INVALID");
  const expected = Buffer.from(labInterestWithdrawToken(signupId, secret).split(".")[1]);
  const actual = Buffer.from(presented);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail("LAB_INTEREST_TOKEN_INVALID");
  // E (§2): stop at once, delete the signup, keep only the refusal mark for this email.
  db.transaction(() => {
    const row = db.prepare("SELECT email_normalized FROM lab_interest_signups WHERE id=?").get(signupId) as { email_normalized: string } | undefined;
    if (!row) return;
    db.prepare("INSERT INTO lab_interest_suppressions(email_normalized,created_at) VALUES (?,?) ON CONFLICT DO NOTHING")
      .run(row.email_normalized, now);
    db.prepare("DELETE FROM lab_interest_signups WHERE email_normalized=?").run(row.email_normalized);
  }).immediate();
  return { withdrawn: true as const };
}

/**
 * The only notice this store may carry: LAB sales have opened. The caller proves the LAB storefront
 * switch is OPEN; nothing here can send while sales are closed, and nothing else (marketing,
 * courses, partner offers) may use these addresses.
 */
export type LabSalesOpenedNotice = {
  noticeKey: string; labSwitch: "OPEN" | "CLOSED"; subject: string; message: string; cityId: string;
};

export function prepareLabSalesOpenedNotices(db: Database.Database, notice: LabSalesOpenedNotice,
  deps: { origin: string; secret: string; commerceOrigin: string }, now: Date, limit = 500): Array<Extract<LabInterestEmail, { kind: "NOTICE" }> & { signupId: string; cityId: string }> {
  if (notice.labSwitch !== "OPEN") fail("LAB_INTEREST_SALES_NOT_OPEN");
  if (!notice.cityId) fail("LAB_INTEREST_CITY_INVALID");
  if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/.test(notice.noticeKey)) fail("LAB_INTEREST_NOTICE_KEY_INVALID");
  const subject = typeof notice.subject === "string" ? notice.subject.trim() : "";
  const message = typeof notice.message === "string" ? notice.message.trim() : "";
  if (!subject || subject.length > 200 || !message || message.length > 4000) fail("LAB_INTEREST_NOTICE_INVALID");
  const rows = db.prepare(`SELECT signup.id,signup.email_normalized FROM lab_interest_signups signup
    WHERE signup.state='CONFIRMED' AND signup.city_id=? AND ${CONFIRMED_EXPIRY}>julianday(?)
      AND NOT EXISTS (SELECT 1 FROM email_suppressions s WHERE s.email_normalized=signup.email_normalized AND s.removed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM lab_interest_suppressions s WHERE s.email_normalized=signup.email_normalized)
      -- The consent covers ONE notice: any earlier attempt, of any notice key, ends the purpose.
      AND NOT EXISTS (SELECT 1 FROM lab_interest_notices n WHERE n.signup_id=signup.id)
    ORDER BY signup.confirmed_at,signup.id LIMIT ?`).all(notice.cityId, now.toISOString(), limit) as Array<{ id: string; email_normalized: string }>;
  return rows.map((row) => {
    const token = labInterestWithdrawToken(row.id, deps.secret);
    return { kind: "NOTICE" as const, signupId: row.id, cityId: notice.cityId, email: row.email_normalized, noticeKey: notice.noticeKey, subject, message,
      storefrontUrl: deps.origin, withdrawUrl: withdrawUrl(deps.origin, row.id, deps.secret),
      headers: { "List-Unsubscribe": `<${deps.commerceOrigin}/v1/lab/interest/withdraw?token=${encodeURIComponent(token)}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" as const } };
  });
}

/**
 * Sends prepared notices at most once each. The attempt is recorded before the provider call; an
 * unknown outcome stays ATTEMPTED and is never retried. A signup withdrawn or suppressed between
 * preparation and send is skipped.
 */
export async function dispatchLabSalesOpenedNotices(db: Database.Database,
  notices: ReturnType<typeof prepareLabSalesOpenedNotices>, send: (message: LabInterestEmail) => Promise<void>, now: () => Date) {
  const result = { sent: 0, skipped: 0, unknown: 0 };
  for (const notice of notices) {
    const claimed = db.transaction(() => {
      const live = db.prepare(`SELECT 1 FROM lab_interest_signups s WHERE s.id=? AND s.state='CONFIRMED'
        AND s.city_id=? AND s.email_normalized=? AND ${CONFIRMED_EXPIRY}>julianday(?)
        AND NOT EXISTS (SELECT 1 FROM email_suppressions x WHERE x.email_normalized=s.email_normalized AND x.removed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM lab_interest_suppressions x WHERE x.email_normalized=s.email_normalized)`).get(notice.signupId, notice.cityId, notice.email, now().toISOString());
      if (!live) return false;
      if (db.prepare("SELECT 1 FROM lab_interest_notices WHERE signup_id=?").get(notice.signupId)) return false;
      return db.prepare(`INSERT INTO lab_interest_notices(signup_id,notice_key,state,attempted_at,sent_at) VALUES (?,?,'ATTEMPTED',?,NULL)
        ON CONFLICT DO NOTHING`).run(notice.signupId, notice.noticeKey, now().toISOString()).changes === 1;
    }).immediate();
    if (!claimed) { result.skipped++; continue; }
    const message: LabInterestEmail = { kind: notice.kind, email: notice.email, noticeKey: notice.noticeKey, subject: notice.subject,
      message: notice.message, storefrontUrl: notice.storefrontUrl, withdrawUrl: notice.withdrawUrl, headers: notice.headers };
    try {
      await send(message);
      db.prepare("UPDATE lab_interest_notices SET state='SENT',sent_at=? WHERE signup_id=? AND notice_key=?")
        .run(now().toISOString(), notice.signupId, notice.noticeKey);
      result.sent++;
    } catch { result.unknown++; }
  }
  return result;
}

/**
 * Reviewed retention policy; there are deliberately no default durations. E's proposal (pending owner
 * decision D-I2): PENDING at most 7 days (the link itself lives 48 h); CONFIRMED deleted within 30 days
 * of the delivered notice and never kept beyond 12 months from confirmation. An undelivered (ATTEMPTED)
 * notice is not the purpose achieved; such a row waits for the 12-month bound.
 */
export type LabInterestRetentionPolicy = { pendingMaxAgeSeconds: number; deliveredMaxAgeSeconds: number; confirmedMaxAgeSeconds: number };

export function purgeLabInterest(db: Database.Database, policy: LabInterestRetentionPolicy, now: Date) {
  const valid = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 600 && (value as number) <= 366 * 24 * 3600;
  if (!valid(policy?.pendingMaxAgeSeconds) || !valid(policy?.deliveredMaxAgeSeconds) || !valid(policy?.confirmedMaxAgeSeconds)) {
    fail("LAB_INTEREST_RETENTION_POLICY_INVALID");
  }
  const time = now.getTime();
  if (!Number.isFinite(time)) fail("LAB_INTEREST_RETENTION_CLOCK_INVALID");
  const before = (seconds: number) => new Date(time - seconds * 1000).toISOString();
  return db.transaction(() => ({
    pending: db.prepare("DELETE FROM lab_interest_signups WHERE state='PENDING' AND (created_at<? OR confirm_expires_at<=?)")
      .run(before(policy.pendingMaxAgeSeconds), new Date(time).toISOString()).changes,
    delivered: db.prepare(`DELETE FROM lab_interest_signups WHERE state='CONFIRMED'
      AND id IN (SELECT signup_id FROM lab_interest_notices WHERE state='SENT' AND sent_at<?)`).run(before(policy.deliveredMaxAgeSeconds)).changes,
    expired: db.prepare(`DELETE FROM lab_interest_signups WHERE state='CONFIRMED'
      AND (confirmed_at<? OR ${CONFIRMED_EXPIRY}<=julianday(?))`)
      .run(before(policy.confirmedMaxAgeSeconds), now.toISOString()).changes,
  })).immediate();
}
