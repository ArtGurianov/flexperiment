import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { id } from "./crypto";
import { recordPartnerIdentityEvent } from "./agent-referrals-onboarding";
import { generateOpaqueToken, hashOpaqueToken, PARTNER_SESSION_TTL_MS } from "./agent-referrals-partner-auth";

/**
 * OTP challenge with exact unknown-outcome semantics, mirroring the outbox
 * attempt model's sequencing (mint -> persist evidence -> attempt external
 * action -> record what is actually known) without reusing email_outbox
 * itself: that table's payload_snapshot is durable BEFORE send by design,
 * which is exactly the shape that would leak a plaintext OTP into a durable
 * row. partner_otp_challenges has no column that could ever hold one - only
 * secret_hash, a SHA-256 digest, is durable, and this module never writes
 * the plaintext code anywhere else (not the audit trail, not an error, not
 * a log line).
 *
 * There is no separate outbox_attempt-shaped table here because there is no
 * multi-attempt-per-message concept to model: each explicit resend mints an
 * entirely new challenge and a brand-new secret rather than retrying the
 * same one, so "the challenge" and "the attempt" are the same row by
 * construction - simpler than outbox's split, and correct for exactly the
 * reason outbox's split exists (never retry ambiguity with the same
 * secret).
 */

export const OTP_TTL_MS = 10 * 60_000;

export class OtpError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const generateOtpCode = () => randomInt(0, 1_000_000).toString().padStart(6, "0");
const hashOtpCode = (code: string) => createHash("sha256").update(code).digest("hex");
const hashesMatch = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * `send` throwing is treated identically to an explicit UNKNOWN return: the
 * request may or may not have reached the provider, and the caller must
 * never assume failure (which would license an unsafe auto-resend) or
 * assume success (which would license treating an unsent code as live).
 */
export interface OtpSender {
  send(input: { recipientEmail: string; code: string; challengeId: string }): Promise<"ACCEPTED" | "KNOWN_FAILED">;
}

export class UnconfiguredOtpSender implements OtpSender {
  async send(): Promise<"ACCEPTED" | "KNOWN_FAILED"> { throw new Error("AGENT_REFERRALS_OTP_SENDER_NOT_CONFIGURED"); }
}

export type OtpChallengeRow = {
  id: string;
  partner_identity_id: string;
  secret_hash: string;
  send_outcome: "ACCEPTED" | "UNKNOWN" | "KNOWN_FAILED" | null;
  consumed_at: string | null;
  superseded_by_id: string | null;
  expires_at: string;
};

export const getOtpChallenge = (db: Database.Database, challengeId: string): OtpChallengeRow | null =>
  (db.prepare(`SELECT id, partner_identity_id, secret_hash, send_outcome, consumed_at, superseded_by_id, expires_at
    FROM partner_otp_challenges WHERE id = ?`).get(challengeId) as OtpChallengeRow | undefined) ?? null;

/**
 * Step 1 only: mint the secret in memory, persist its hash, supersede any
 * prior live challenge - all inside one transaction, before any external
 * action is attempted. Exposed separately from dispatch so fault-injection
 * tests can prove "failure before hash persistence -> no live secret
 * authority" against this step in isolation.
 */
const mintOtpChallengeInTransaction = (db: Database.Database, partnerIdentityId: string): { challengeId: string; code: string; email: string } => {
  const identity = db.prepare("SELECT email FROM partner_identities WHERE id = ?").get(partnerIdentityId) as { email: string } | undefined;
  if (!identity) throw new OtpError("PARTNER_IDENTITY_NOT_FOUND", 404);

  const current = db.prepare(`SELECT id FROM partner_otp_challenges
    WHERE partner_identity_id = ? AND consumed_at IS NULL AND superseded_by_id IS NULL`).get(partnerIdentityId) as { id: string } | undefined;

  const code = generateOtpCode();
  const challengeId = id();

  // Same ordering constraint as reissuePartnerInvite: the old row must stop
  // matching the active partial-unique predicate before the new row is
  // inserted, which means writing a forward reference to a row that does
  // not exist yet - deferred via defer_foreign_keys, checked at commit.
  db.pragma("defer_foreign_keys = ON");
  if (current) db.prepare(`UPDATE partner_otp_challenges SET superseded_by_id = ? WHERE id = ?`).run(challengeId, current.id);

  db.prepare(`INSERT INTO partner_otp_challenges(id, partner_identity_id, purpose, secret_hash, expires_at)
    VALUES (?, ?, 'LOGIN', ?, ?)`)
    .run(challengeId, partnerIdentityId, hashOtpCode(code), new Date(Date.now() + OTP_TTL_MS).toISOString());

  recordPartnerIdentityEvent(db, partnerIdentityId, "OTP_CHALLENGE_ISSUED", "SYSTEM", { challenge_id: challengeId, superseded_challenge_id: current?.id ?? null });
  return { challengeId, code, email: identity.email };
};

/**
 * Full mint-and-dispatch: the hash is committed and durable before this
 * function ever calls `sender.send()`. Explicit resend is simply calling
 * this again - it supersedes whatever is currently live and mints a
 * genuinely new secret; there is no other path in this module that can
 * mint a second secret for an already-issued, still-live challenge.
 */
export const issueAndDispatchOtpChallenge = async (db: Database.Database, partnerIdentityId: string, sender: OtpSender): Promise<{ challenge_id: string }> => {
  const { challengeId, code, email } = db.transaction(() => mintOtpChallengeInTransaction(db, partnerIdentityId)).immediate();

  let outcome: "ACCEPTED" | "UNKNOWN" | "KNOWN_FAILED";
  try {
    outcome = await sender.send({ recipientEmail: email, code, challengeId });
  } catch {
    outcome = "UNKNOWN";
  }

  db.prepare(`UPDATE partner_otp_challenges SET send_outcome = ?, send_attempted_at = CURRENT_TIMESTAMP WHERE id = ?`).run(outcome, challengeId);
  recordPartnerIdentityEvent(db, partnerIdentityId, "OTP_CHALLENGE_SEND_OUTCOME", "SYSTEM", { challenge_id: challengeId, outcome });
  return { challenge_id: challengeId };
};

/**
 * Verification never consults send_outcome - it is delivery evidence, not
 * authentication gating. A challenge whose send was UNKNOWN (or even
 * KNOWN_FAILED - the provider can be wrong) is still exactly as
 * authoritative as one recorded ACCEPTED, until it is consumed, superseded
 * or expired. Consumption is a CAS re-checked inside the transaction, so a
 * replay racing a first successful verify fails closed rather than racing
 * a session into existence twice.
 */
export const verifyOtpChallenge = (db: Database.Database, challengeId: string, code: string): { partner_identity_id: string } => {
  const run = db.transaction(() => {
    const challenge = getOtpChallenge(db, challengeId);
    if (!challenge) throw new OtpError("AGENT_REFERRALS_OTP_NOT_FOUND", 404);
    if (challenge.superseded_by_id) throw new OtpError("AGENT_REFERRALS_OTP_SUPERSEDED", 409);
    if (challenge.consumed_at) throw new OtpError("AGENT_REFERRALS_OTP_ALREADY_CONSUMED", 409);
    if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new OtpError("AGENT_REFERRALS_OTP_EXPIRED", 409);
    if (!hashesMatch(hashOtpCode(code), challenge.secret_hash)) throw new OtpError("AGENT_REFERRALS_OTP_CODE_MISMATCH", 401);

    const changed = db.prepare(`UPDATE partner_otp_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ? AND consumed_at IS NULL`).run(challengeId);
    if (changed.changes !== 1) throw new OtpError("AGENT_REFERRALS_OTP_ALREADY_CONSUMED", 409);

    recordPartnerIdentityEvent(db, challenge.partner_identity_id, "OTP_CHALLENGE_CONSUMED", "PARTNER", { challenge_id: challengeId });
    return { partner_identity_id: challenge.partner_identity_id };
  });
  return run.immediate();
};

export type PartnerLoginResult = { partner_identity_id: string; partner_session_id: string; raw_session_token: string };

/**
 * Successful OTP exchange creates only fx_partner_session - never anything
 * admin-realm-shaped. Verification and session creation commit together:
 * a session is never created for a code that failed verification, and a
 * verified-but-then-failed session insert leaves the challenge consumed
 * (correct: the secret was genuinely used) with no live session, which the
 * partner recovers from via an ordinary new login, not a replay of the
 * spent code.
 */
export const loginWithOtp = (db: Database.Database, challengeId: string, code: string): PartnerLoginResult => {
  const run = db.transaction((): PartnerLoginResult => {
    const { partner_identity_id } = verifyOtpChallenge(db, challengeId, code);
    const rawToken = generateOpaqueToken();
    const sessionId = id();
    db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`)
      .run(sessionId, partner_identity_id, hashOpaqueToken(rawToken), new Date(Date.now() + PARTNER_SESSION_TTL_MS).toISOString());
    recordPartnerIdentityEvent(db, partner_identity_id, "PARTNER_SESSION_CREATED", "PARTNER", { partner_session_id: sessionId });
    return { partner_identity_id, partner_session_id: sessionId, raw_session_token: rawToken };
  });
  return run.immediate();
};
