import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, type AdminPrincipal } from "../src/agent-referrals-partner-identity";
import { issueAndDispatchOtpChallenge, loginWithOtp, type OtpSender } from "../src/agent-referrals-otp";
import { resolvePartnerSession, revokePartnerSession } from "../src/agent-referrals-partner-session";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-session-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const capturingSender = (): OtpSender & { lastCode?: string } => {
  const sender = { lastCode: undefined as string | undefined, async send(input: { code: string }) { sender.lastCode = input.code; return "ACCEPTED" as const; } };
  return sender;
};

const loggedInPartner = async (db: Database.Database, email = `${randomUUID().slice(0, 8)}@example.test`) => {
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, email);
  const { partner_identity_id } = provisionPartnerOwner(db, admin, agentId, email, "test");
  const sender = capturingSender();
  const dispatched = await issueAndDispatchOtpChallenge(db, partner_identity_id, sender);
  return loginWithOtp(db, dispatched.challenge_id, sender.lastCode!);
};

describe("partner session", () => {
  it("resolves a valid raw token to the correct partner principal", async () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const login = await loggedInPartner(db);
    const principal = resolvePartnerSession(db, login.raw_session_token);
    expect(principal).toEqual({ realm: "PARTNER", partner_identity_id: login.partner_identity_id, partner_session_id: login.partner_session_id });
  });

  it("refuses an unknown token", () => {
    const db = fresh();
    expect(resolvePartnerSession(db, "totally-unknown-token")).toBeUndefined();
  });

  it("refuses an expired session", async () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const login = await loggedInPartner(db);
    db.prepare("UPDATE partner_sessions SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(login.partner_session_id);
    expect(resolvePartnerSession(db, login.raw_session_token)).toBeUndefined();
  });

  it("logout/revocation invalidates server authority - the raw token becomes useless even though the caller still holds it", async () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const login = await loggedInPartner(db);
    expect(resolvePartnerSession(db, login.raw_session_token)).toBeDefined();
    revokePartnerSession(db, { realm: "PARTNER", partner_identity_id: login.partner_identity_id, partner_session_id: login.partner_session_id });
    expect(resolvePartnerSession(db, login.raw_session_token)).toBeUndefined();
  });

  it("revoking session A does not affect a different, still-valid session B for the same identity", async () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const email = `${randomUUID().slice(0, 8)}@example.test`;
    const first = await loggedInPartner(db, email);

    const senderB = capturingSender();
    const dispatchedB = await issueAndDispatchOtpChallenge(db, first.partner_identity_id, senderB);
    const second = loginWithOtp(db, dispatchedB.challenge_id, senderB.lastCode!);

    revokePartnerSession(db, { realm: "PARTNER", partner_identity_id: first.partner_identity_id, partner_session_id: first.partner_session_id });
    expect(resolvePartnerSession(db, first.raw_session_token)).toBeUndefined();
    expect(resolvePartnerSession(db, second.raw_session_token)).toBeDefined();
  });

  it("a session for identity A never resolves to identity B's session id, even by coincidence of timing", async () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const a = await loggedInPartner(db);
    const b = await loggedInPartner(db);
    expect(a.partner_identity_id).not.toBe(b.partner_identity_id);
    expect(resolvePartnerSession(db, a.raw_session_token)?.partner_identity_id).toBe(a.partner_identity_id);
    expect(resolvePartnerSession(db, b.raw_session_token)?.partner_identity_id).toBe(b.partner_identity_id);
  });

  it("no partner credential is ever placed anywhere resembling browser storage guidance - the raw token exists only in the cookie value and this return value, never a second durable column", async () => {
    const db = fresh();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const login = await loggedInPartner(db);
    const columns = (db.prepare("PRAGMA table_info(partner_sessions)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("raw_token");
    expect(columns).not.toContain("token");
    const row = db.prepare("SELECT * FROM partner_sessions WHERE id = ?").get(login.partner_session_id) as Record<string, unknown>;
    for (const value of Object.values(row)) if (typeof value === "string") expect(value).not.toBe(login.raw_session_token);
  });
});
