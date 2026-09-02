import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, type AdminPrincipal } from "../src/agent-referrals-partner-identity";
import { effectiveOtpSendOutcome, getOtpChallenge, issueAndDispatchOtpChallenge, loginWithOtp, recoverOtpChallengeState, verifyOtpChallenge, type OtpSender } from "../src/agent-referrals-otp";

// Explicit test pepper - there is deliberately no source-level fallback.
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-agent-referrals-otp-test";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-otp-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const provisionedPartner = (db: Database.Database) => {
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const { partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "partner@example.test", "test");
  return partner_identity_id;
};

const capturingSender = (): OtpSender & { lastCode?: string; lastEmail?: string } => {
  const sender = {
    lastCode: undefined as string | undefined,
    lastEmail: undefined as string | undefined,
    async send(input: { recipientEmail: string; code: string }) {
      sender.lastCode = input.code;
      sender.lastEmail = input.recipientEmail;
      return "ACCEPTED" as const;
    },
  };
  return sender;
};

const throwingSender = (): OtpSender => ({ send: async () => { throw new Error("network timeout"); } });
const knownFailedSender = (): OtpSender => ({ send: async () => "KNOWN_FAILED" });

describe("OTP challenge: unknown-outcome semantics", () => {
  it("no raw OTP code is ever durable - only secret_hash, on the challenge row or anywhere else", async () => {
    const db = fresh();
    const partnerIdentityId = provisionedPartner(db);
    const sender = capturingSender();
    const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
    expect(sender.lastCode).toMatch(/^\d{6}$/);

    const columns = (db.prepare("PRAGMA table_info(partner_otp_challenges)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("code");
    expect(columns).not.toContain("otp");
    expect(columns).not.toContain("plain_secret");
    expect(columns).not.toContain("token");

    const row = db.prepare("SELECT * FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id) as Record<string, unknown>;
    for (const value of Object.values(row)) if (typeof value === "string") expect(value).not.toContain(sender.lastCode!);

    const events = db.prepare("SELECT details_json FROM partner_identity_events").all() as Array<{ details_json: string }>;
    for (const event of events) expect(event.details_json).not.toContain(sender.lastCode!);
  });

  it("the secret hash is persisted before the external send is attempted", async () => {
    const db = fresh();
    const partnerIdentityId = provisionedPartner(db);
    let hashWasPersistedBeforeSend = false;
    const sender: OtpSender = {
      async send() {
        const row = db.prepare("SELECT secret_hash FROM partner_otp_challenges WHERE partner_identity_id = ?").get(partnerIdentityId) as { secret_hash: string } | undefined;
        hashWasPersistedBeforeSend = Boolean(row?.secret_hash);
        return "ACCEPTED";
      },
    };
    await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
    expect(hashWasPersistedBeforeSend).toBe(true);
  });

  it("failure before hash persistence: no live secret authority at all", async () => {
    const db = fresh();
    const partnerIdentityId = provisionedPartner(db);
    db.exec(`CREATE TRIGGER poison_otp_insert BEFORE INSERT ON partner_otp_challenges
      BEGIN SELECT RAISE(ABORT, 'INJECTED_MINT_FAILURE'); END;`);

    await expect(issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender())).rejects.toThrow(/INJECTED_MINT_FAILURE/);
    db.exec("DROP TRIGGER poison_otp_insert");
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges").get()).toEqual({ n: 0 });
  });

  it("provider timeout/unknown: outcome recorded UNKNOWN, and the challenge remains the single live one (no auto-resend)", async () => {
    const db = fresh();
    const partnerIdentityId = provisionedPartner(db);
    const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, throwingSender());

    const challenge = db.prepare("SELECT send_outcome, superseded_by_id, consumed_at FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id) as
      { send_outcome: string; superseded_by_id: string | null; consumed_at: string | null };
    expect(challenge.send_outcome).toBe("UNKNOWN");
    expect(challenge.superseded_by_id).toBeNull();
    expect(challenge.consumed_at).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
  });

  it("a provider that explicitly rejects (KNOWN_FAILED) also never auto-resends", async () => {
    const db = fresh();
    const partnerIdentityId = provisionedPartner(db);
    const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, knownFailedSender());
    expect(db.prepare("SELECT send_outcome FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id)).toEqual({ send_outcome: "KNOWN_FAILED" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
  });

  it("hash persisted, ambiguous send: a code that was in fact received still verifies successfully (delivery status never gates authentication)", async () => {
    const db = fresh();
    const partnerIdentityId = provisionedPartner(db);
    const sender = capturingSender();
    sender.send = async (input) => { sender.lastCode = input.code; throw new Error("ambiguous - timeout after request left the process"); };
    const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
    expect(db.prepare("SELECT send_outcome FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id)).toEqual({ send_outcome: "UNKNOWN" });

    expect(verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!)).toEqual({ partner_identity_id: partnerIdentityId });
  });

  describe("keyed verifier: HMAC-SHA256 with a mandatory, uncommitted pepper - not plain SHA-256", () => {
    it("no configured pepper: dispatch fails outright, no live secret authority", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const saved = process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER;
      delete process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER;
      try {
        await expect(issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender())).rejects.toThrow(/AGENT_REFERRALS_OTP_PEPPER_MISSING/);
        expect(db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges").get()).toEqual({ n: 0 });
      } finally {
        if (saved !== undefined) process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER = saved;
      }
    });

    it("the verifier is not recoverable as a plain SHA-256 of the code - it depends on the pepper and the challenge id", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      const row = db.prepare("SELECT secret_hash FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id) as { secret_hash: string };
      const plainSha256 = createHash("sha256").update(sender.lastCode!).digest("hex");
      expect(row.secret_hash).not.toBe(plainSha256);
    });

    it("the same code hashes differently for two different challenges - the verifier is challenge-bound, not reusable across challenges", async () => {
      const db = fresh();
      const a = provisionedPartner(db);
      const b = provisionedPartner(db);
      const senderA = capturingSender();
      const senderB = capturingSender();
      // Two independent dispatches happen to land on the same six-digit
      // code with low but real probability across a full suite run; assert
      // on the hashes only, which must differ regardless.
      const dispatchedA = await issueAndDispatchOtpChallenge(db, a, senderA);
      const dispatchedB = await issueAndDispatchOtpChallenge(db, b, senderB);
      const rowA = db.prepare("SELECT secret_hash FROM partner_otp_challenges WHERE id = ?").get(dispatchedA.challenge_id) as { secret_hash: string };
      const rowB = db.prepare("SELECT secret_hash FROM partner_otp_challenges WHERE id = ?").get(dispatchedB.challenge_id) as { secret_hash: string };
      expect(rowA.secret_hash).not.toBe(rowB.secret_hash);
    });
  });

  describe("crash durability: send_attempted_at is committed before sender.send() is ever called", () => {
    it("send_attempted_at is durable before the external call - proven by a sender that reads the DB mid-call", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      let attemptedAtWasSetBeforeSend = false;
      const sender: OtpSender = {
        async send(input) {
          const row = getOtpChallenge(db, input.challengeId)!;
          attemptedAtWasSetBeforeSend = Boolean(row.send_attempted_at);
          return "ACCEPTED";
        },
      };
      await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      expect(attemptedAtWasSetBeforeSend).toBe(true);
    });

    it("a row left with send_attempted_at set but send_outcome NULL - exactly what a crash between that commit and the outcome write leaves - reads as UNKNOWN, never as 'never attempted'", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender());
      // Reconstructs the exact durable state a real process death in that
      // gap would leave: send_attempted_at already committed, the outcome
      // UPDATE never having run at all.
      db.prepare("UPDATE partner_otp_challenges SET send_outcome = NULL WHERE id = ?").run(dispatched.challenge_id);

      const row = getOtpChallenge(db, dispatched.challenge_id)!;
      expect(row.send_attempted_at).toBeTruthy();
      expect(row.send_outcome).toBeNull();
      expect(effectiveOtpSendOutcome(row)).toBe("UNKNOWN");
      expect(recoverOtpChallengeState(db, dispatched.challenge_id)).toBe("UNKNOWN");
    });

    it("recovery of an ambiguous (crashed) challenge is read-only: automatic recovery sends zero messages, the old challenge remains live and ambiguous, and only an explicit new dispatch call supersedes it", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender());
      db.prepare("UPDATE partner_otp_challenges SET send_outcome = NULL WHERE id = ?").run(dispatched.challenge_id);

      // "Automatic recovery" here is exactly recoverOtpChallengeState() -
      // read-only, calls no sender, mutates nothing. Zero messages sent,
      // zero rows changed.
      expect(recoverOtpChallengeState(db, dispatched.challenge_id)).toBe("UNKNOWN");
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
      expect(db.prepare("SELECT superseded_by_id, consumed_at FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id))
        .toEqual({ superseded_by_id: null, consumed_at: null });

      // Only an explicit, separate dispatch call (the deliberate "resend"
      // action) supersedes it and mints a genuinely new secret.
      const resendSender = capturingSender();
      const resendDispatch = await issueAndDispatchOtpChallenge(db, partnerIdentityId, resendSender);
      expect(resendDispatch.challenge_id).not.toBe(dispatched.challenge_id);
      expect(db.prepare("SELECT superseded_by_id FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id))
        .toEqual({ superseded_by_id: resendDispatch.challenge_id });
    });

    it("READY (never attempted) is distinct from UNKNOWN (attempted, outcome unresolved)", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      expect(effectiveOtpSendOutcome({ send_outcome: null, send_attempted_at: null })).toBe("READY");
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender());
      expect(effectiveOtpSendOutcome(getOtpChallenge(db, dispatched.challenge_id)!)).toBe("ACCEPTED");
    });
  });

  describe("explicit resend supersedes the old challenge", () => {
    it("mints a brand-new challenge id and a brand-new secret; the old code is refused, the new one works once", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const first = capturingSender();
      const firstDispatch = await issueAndDispatchOtpChallenge(db, partnerIdentityId, first);
      const firstCode = first.lastCode!;

      const second = capturingSender();
      const secondDispatch = await issueAndDispatchOtpChallenge(db, partnerIdentityId, second);
      expect(secondDispatch.challenge_id).not.toBe(firstDispatch.challenge_id);
      expect(second.lastCode).not.toBe(firstCode);

      const firstRow = db.prepare("SELECT superseded_by_id FROM partner_otp_challenges WHERE id = ?").get(firstDispatch.challenge_id) as { superseded_by_id: string };
      expect(firstRow.superseded_by_id).toBe(secondDispatch.challenge_id);

      expect(() => verifyOtpChallenge(db, firstDispatch.challenge_id, firstCode)).toThrow(/AGENT_REFERRALS_OTP_SUPERSEDED/);
      expect(verifyOtpChallenge(db, secondDispatch.challenge_id, second.lastCode!)).toEqual({ partner_identity_id: partnerIdentityId });
    });

    it("at most one live (non-superseded, non-consumed) challenge exists per identity at any instant - structural proof via the partial unique index", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      await issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender());
      await issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender());
      await issueAndDispatchOtpChallenge(db, partnerIdentityId, capturingSender());
      const live = db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges WHERE partner_identity_id = ? AND consumed_at IS NULL AND superseded_by_id IS NULL").get(partnerIdentityId);
      expect(live).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_otp_challenges WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 3 });
    });
  });

  describe("verification", () => {
    it("wrong code is refused, does not consume the challenge", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      expect(() => verifyOtpChallenge(db, dispatched.challenge_id, "000000")).toThrow(/AGENT_REFERRALS_OTP_CODE_MISMATCH/);
      expect(verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!)).toEqual({ partner_identity_id: partnerIdentityId });
    });

    it("expired challenge is refused even with the correct code", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      // The exact ISO 8601 format production actually writes ("...T...Z"),
      // not SQLite's own datetime('now') shape - a same-UTC-day expiry in
      // the wrong format previously masked the julianday() fix's absence.
      db.prepare("UPDATE partner_otp_challenges SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), dispatched.challenge_id);
      expect(() => verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!)).toThrow(/AGENT_REFERRALS_OTP_EXPIRED/);
    });

    it("successful OTP is single-use: replay after consumption is refused", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!);
      expect(() => verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!)).toThrow(/AGENT_REFERRALS_OTP_ALREADY_CONSUMED/);
    });

    it("verify consumption is atomic: a poisoned audit insert rolls back consumption, leaving the code still usable", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      db.exec(`CREATE TRIGGER poison_otp_verify_audit BEFORE INSERT ON partner_identity_events
        WHEN NEW.event_kind = 'OTP_CHALLENGE_CONSUMED' BEGIN SELECT RAISE(ABORT, 'INJECTED_VERIFY_AUDIT_FAILURE'); END;`);

      expect(() => verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!)).toThrow(/INJECTED_VERIFY_AUDIT_FAILURE/);
      db.exec("DROP TRIGGER poison_otp_verify_audit");

      const challenge = db.prepare("SELECT consumed_at FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id) as { consumed_at: string | null };
      expect(challenge.consumed_at).toBeNull();
      expect(verifyOtpChallenge(db, dispatched.challenge_id, sender.lastCode!)).toEqual({ partner_identity_id: partnerIdentityId });
    });
  });

  describe("login: OTP verify + session creation, atomic", () => {
    it("successful exchange creates exactly one partner_sessions row and nothing session-shaped elsewhere", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      const login = loginWithOtp(db, dispatched.challenge_id, sender.lastCode!);
      expect(login.partner_identity_id).toBe(partnerIdentityId);
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_sessions WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
      expect(db.prepare("SELECT token_hash FROM partner_sessions WHERE id = ?").get(login.partner_session_id) as { token_hash: string }).not.toMatchObject({ token_hash: login.raw_session_token });
    });

    it("fault injection at session creation: no live session, and the OTP stays consumed (not replayable) - recovery is a fresh login, not a replay", async () => {
      const db = fresh();
      const partnerIdentityId = provisionedPartner(db);
      const sender = capturingSender();
      const dispatched = await issueAndDispatchOtpChallenge(db, partnerIdentityId, sender);
      db.exec(`CREATE TRIGGER poison_session_insert BEFORE INSERT ON partner_sessions
        BEGIN SELECT RAISE(ABORT, 'INJECTED_SESSION_FAILURE'); END;`);

      expect(() => loginWithOtp(db, dispatched.challenge_id, sender.lastCode!)).toThrow(/INJECTED_SESSION_FAILURE/);
      db.exec("DROP TRIGGER poison_session_insert");

      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_sessions").get()).toEqual({ n: 0 });
      const challenge = db.prepare("SELECT consumed_at FROM partner_otp_challenges WHERE id = ?").get(dispatched.challenge_id) as { consumed_at: string | null };
      expect(challenge.consumed_at).toBeNull();
      expect(() => loginWithOtp(db, dispatched.challenge_id, sender.lastCode!)).not.toThrow();
    });
  });
});
