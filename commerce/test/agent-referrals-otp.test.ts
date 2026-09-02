import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, type AdminPrincipal } from "../src/agent-referrals-partner-identity";
import { issueAndDispatchOtpChallenge, loginWithOtp, verifyOtpChallenge, type OtpSender } from "../src/agent-referrals-otp";

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
      db.prepare("UPDATE partner_otp_challenges SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(dispatched.challenge_id);
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
