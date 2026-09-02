import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals, suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import {
  consumePartnerInvite,
  provisionPartnerOwner,
  reissuePartnerInvite,
  revokePartnerInvite,
  type AdminPrincipal,
} from "../src/agent-referrals-partner-identity";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-provisioning-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return { db, file };
};

const seedAgent = (db: Database.Database, agentId = randomUUID()) => {
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  return agentId;
};

const activated = (db: Database.Database) => activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });

describe("partner provisioning", () => {
  describe("gated on the global feature-state authority", () => {
    it("refuses NEW_PARTNER_PROVISIONING while DORMANT", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      expect(() => provisionPartnerOwner(db, admin, agentId, "partner@example.test", "test")).toThrow(/AGENT_REFERRALS_FEATURE_DORMANT/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identities").get()).toEqual({ n: 0 });
    });

    it("refuses NEW_PARTNER_PROVISIONING while SUSPENDED", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "test" });
      expect(() => provisionPartnerOwner(db, admin, agentId, "partner@example.test", "test")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
    });

    it("succeeds while ACTIVE", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const result = provisionPartnerOwner(db, admin, agentId, "partner@example.test", "test");
      expect(result.partner_identity_id).toBeTruthy();
      expect(result.raw_invite_token).toBeTruthy();
    });

    /**
     * The race this closes (an observed ACTIVE that a concurrent SUSPENDED
     * commits before the observer's write actually lands) cannot be built
     * as an executing test with better-sqlite3's synchronous API: there is
     * no yield point between "read state" and "acquire the write lock" for
     * another synchronous call on a different connection to land in -
     * whatever a second connection does, it either fully completes before
     * or fully completes after this function's one synchronous call, never
     * mid-call. That is exactly why the fix has to be structural (the read
     * happens after BEGIN IMMEDIATE, inside the same transaction as the
     * writes it gates) rather than behavioral, and why the proof here is a
     * source-position check, not a timing simulation - the same reasoning
     * PR1's db-migrate.test.ts documents for its own analogous re-check.
     */
    it("structurally: the feature-state check is positioned inside the transaction, not before it", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-partner-identity.ts"), "utf8");
      const fnStart = source.indexOf("export const provisionPartnerOwner");
      const transactionStart = source.indexOf("db.transaction(", fnStart);
      const assertCall = source.indexOf("assertAgentReferralsOperationPermitted(", fnStart);
      expect(transactionStart).toBeGreaterThan(-1);
      expect(assertCall).toBeGreaterThan(-1);
      // The assertion must appear strictly AFTER db.transaction( opens the
      // callback, i.e. it runs once the transaction is already active.
      expect(assertCall).toBeGreaterThan(transactionStart);
    });
  });

  describe("exactly one OWNER per partner", () => {
    it("provisioning the same agent twice refuses the second attempt, with no partial invite row from it", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      provisionPartnerOwner(db, admin, agentId, "first@example.test", "first");
      const invitesBefore = db.prepare("SELECT COUNT(*) AS n FROM partner_invite_capabilities").get();
      expect(() => provisionPartnerOwner(db, admin, agentId, "second@example.test", "second")).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identities WHERE agent_id = ?").get(agentId)).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_invite_capabilities").get()).toEqual(invitesBefore);
    });

    it("concurrent provisioning attempts for the same agent: at most one succeeds, no duplicate identity, no partial invite rows", () => {
      const { db: a, file } = fresh();
      const agentId = seedAgent(a);
      activated(a);
      const b = new Database(file); b.pragma("journal_mode = WAL"); b.pragma("foreign_keys = ON"); b.pragma("busy_timeout = 5000"); open.push(b);

      const first = provisionPartnerOwner(a, admin, agentId, "first@example.test", "racer A");
      expect(() => provisionPartnerOwner(b, admin, agentId, "second@example.test", "racer B")).toThrow();

      expect(a.prepare("SELECT COUNT(*) AS n FROM partner_identities WHERE agent_id = ?").get(agentId)).toEqual({ n: 1 });
      expect(a.prepare("SELECT id FROM partner_identities WHERE agent_id = ?").get(agentId)).toEqual({ id: first.partner_identity_id });
      expect(a.prepare("SELECT COUNT(*) AS n FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(first.partner_identity_id)).toEqual({ n: 1 });
      expect(a.prepare("SELECT COUNT(*) AS n FROM partner_sessions").get()).toEqual({ n: 0 });
    });
  });

  describe("invite capability", () => {
    it("a valid invite is usable exactly once", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { partner_identity_id, raw_invite_token } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      const consumed = consumePartnerInvite(db, raw_invite_token);
      expect(consumed.partner_identity_id).toBe(partner_identity_id);
      expect(() => consumePartnerInvite(db, raw_invite_token)).toThrow(/AGENT_REFERRALS_INVITE_ALREADY_CONSUMED/);
    });

    it("an expired invite is refused", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { raw_invite_token, partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      // The exact ISO 8601 format production actually writes, not SQLite's own datetime('now') shape.
      db.prepare("UPDATE partner_invite_capabilities SET expires_at = ? WHERE partner_identity_id = ?").run(new Date(Date.now() - 60_000).toISOString(), partner_identity_id);
      expect(() => consumePartnerInvite(db, raw_invite_token)).toThrow(/AGENT_REFERRALS_INVITE_EXPIRED/);
    });

    it("a revoked invite is refused", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { raw_invite_token, partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      const inviteId = (db.prepare("SELECT id FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(partner_identity_id) as { id: string }).id;
      revokePartnerInvite(db, admin, inviteId, "compromised");
      expect(() => consumePartnerInvite(db, raw_invite_token)).toThrow(/AGENT_REFERRALS_INVITE_REVOKED/);
    });

    it("a superseded invite is refused, only the reissued one works", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { raw_invite_token: oldToken, partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      const { raw_invite_token: newToken } = reissuePartnerInvite(db, admin, partner_identity_id, "reissue");
      expect(() => consumePartnerInvite(db, oldToken)).toThrow(/AGENT_REFERRALS_INVITE_SUPERSEDED/);
      expect(consumePartnerInvite(db, newToken).partner_identity_id).toBe(partner_identity_id);
    });

    it("a consumed invite cannot be revoked or superseded into working again", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { raw_invite_token, partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      consumePartnerInvite(db, raw_invite_token);
      const inviteId = (db.prepare("SELECT id FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(partner_identity_id) as { id: string }).id;
      expect(() => revokePartnerInvite(db, admin, inviteId, "too late")).toThrow(/AGENT_REFERRALS_INVITE_NOT_REVOCABLE/);
    });

    it("an unknown token is refused", () => {
      const { db } = fresh();
      expect(() => consumePartnerInvite(db, "totally-made-up-token")).toThrow(/AGENT_REFERRALS_INVITE_NOT_FOUND/);
    });

    it("the raw invite secret is never durable: no column, no table anywhere holds it in plaintext", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { raw_invite_token } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      const rows = db.prepare("SELECT * FROM partner_invite_capabilities").all() as Array<Record<string, unknown>>;
      for (const row of rows) for (const value of Object.values(row)) {
        if (typeof value === "string") expect(value).not.toContain(raw_invite_token);
      }
      const events = db.prepare("SELECT details_json FROM partner_identity_events").all() as Array<{ details_json: string }>;
      for (const event of events) expect(event.details_json).not.toContain(raw_invite_token);
    });

    it("consumption is atomic: a fault after the CAS-consume-check but simulated via a poisoned audit insert rolls back the whole consumption", () => {
      const { db } = fresh();
      const agentId = seedAgent(db);
      activated(db);
      const { raw_invite_token, partner_identity_id } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
      db.exec(`CREATE TRIGGER poison_invite_consume_audit BEFORE INSERT ON partner_identity_events
        WHEN NEW.event_kind = 'INVITE_CONSUMED' BEGIN SELECT RAISE(ABORT, 'INJECTED_AUDIT_FAILURE'); END;`);

      expect(() => consumePartnerInvite(db, raw_invite_token)).toThrow(/INJECTED_AUDIT_FAILURE/);
      db.exec("DROP TRIGGER poison_invite_consume_audit");

      const invite = db.prepare("SELECT consumed_at FROM partner_invite_capabilities WHERE partner_identity_id = ?").get(partner_identity_id) as { consumed_at: string | null };
      expect(invite.consumed_at).toBeNull();
      // The invite is still fully usable after the injected fault clears.
      expect(consumePartnerInvite(db, raw_invite_token).partner_identity_id).toBe(partner_identity_id);
    });
  });
});
