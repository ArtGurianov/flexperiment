import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import {
  currentRetentionPolicy,
  destroyPartnerIdentity,
  isUnderLegalHold,
  placeLegalHold,
  releaseLegalHold,
} from "../src/agent-referrals-identity-retention";
import type { AdminPrincipal } from "../src/agent-referrals-partner-identity";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-retention-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const seedPartner = (db: Database.Database): string => {
  const agentId = randomUUID();
  const partnerIdentityId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'emailhash', 'admin')`).run(partnerIdentityId, agentId);
  return partnerIdentityId;
};

describe("identity retention / legal holds / destruction evidence", () => {
  it("a seeded retention policy is present at revision 1", () => {
    const db = fresh();
    expect(currentRetentionPolicy(db)).toMatchObject({ revision: 1 });
  });

  describe("legal hold blocks destruction", () => {
    it("an active hold refuses destruction outright, no evidence produced", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      placeLegalHold(db, admin, partnerIdentityId, "pending investigation");
      expect(isUnderLegalHold(db, partnerIdentityId)).toBe(true);
      expect(() => destroyPartnerIdentity(db, admin, partnerIdentityId, "attempt")).toThrow(/AGENT_REFERRALS_IDENTITY_UNDER_LEGAL_HOLD/);
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_destruction_events").get()).toEqual({ n: 0 });
      const identity = db.prepare("SELECT email FROM partner_identities WHERE id = ?").get(partnerIdentityId) as { email: string };
      expect(identity.email).toBe("p@example.test");
    });

    it("releasing the hold makes the identity eligible again", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const hold = placeLegalHold(db, admin, partnerIdentityId, "hold");
      expect(() => destroyPartnerIdentity(db, admin, partnerIdentityId, "attempt")).toThrow();
      releaseLegalHold(db, admin, hold.hold_id, "released");
      expect(isUnderLegalHold(db, partnerIdentityId)).toBe(false);
      expect(() => destroyPartnerIdentity(db, admin, partnerIdentityId, "attempt after release")).not.toThrow();
    });

    it("releasing an already-released hold is refused, not silently repeated", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const hold = placeLegalHold(db, admin, partnerIdentityId, "hold");
      releaseLegalHold(db, admin, hold.hold_id, "released");
      expect(() => releaseLegalHold(db, admin, hold.hold_id, "released again")).toThrow(/AGENT_REFERRALS_LEGAL_HOLD_ALREADY_RELEASED/);
    });

    it("only one active hold at a time is structurally enforceable, but a new hold can be placed after release", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const first = placeLegalHold(db, admin, partnerIdentityId, "first");
      expect(() => db.prepare(`INSERT INTO partner_identity_legal_holds(id, partner_identity_id, reason, placed_by_admin_id) VALUES (?, ?, 'second', 'admin-1')`).run(randomUUID(), partnerIdentityId))
        .toThrow(/UNIQUE constraint failed/);
      releaseLegalHold(db, admin, first.hold_id, "done");
      expect(() => placeLegalHold(db, admin, partnerIdentityId, "second, after release")).not.toThrow();
    });
  });

  describe("destruction evidence", () => {
    it("eligible destruction produces exact destruction/tombstone evidence and scrubs PII", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const policy = currentRetentionPolicy(db)!;
      const result = destroyPartnerIdentity(db, admin, partnerIdentityId, "eligible for destruction");
      expect(result.replayed).toBe(false);

      const event = db.prepare("SELECT * FROM partner_identity_destruction_events WHERE id = ?").get(result.destruction_event_id) as Record<string, unknown>;
      expect(event).toMatchObject({ partner_identity_id: partnerIdentityId, retention_policy_revision_id: policy.id, requested_by_admin_id: "admin-1" });
      expect(JSON.parse(event.destroyed_fields_json as string)).toEqual(["email", "email_hash"]);

      const identity = db.prepare("SELECT email, email_hash, destroyed_at FROM partner_identities WHERE id = ?").get(partnerIdentityId) as
        { email: string; email_hash: string; destroyed_at: string | null };
      expect(identity.email).not.toBe("p@example.test");
      expect(identity.email_hash).not.toBe("emailhash");
      expect(identity.destroyed_at).toBeTruthy();
    });

    it("destruction evidence is immutable - direct UPDATE/DELETE refused", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const result = destroyPartnerIdentity(db, admin, partnerIdentityId, "destroy");
      expect(() => db.exec(`UPDATE partner_identity_destruction_events SET requested_by_admin_id = 'other' WHERE id = '${result.destruction_event_id}'`))
        .toThrow(/PARTNER_IDENTITY_DESTRUCTION_EVENT_IMMUTABLE/);
      expect(() => db.exec(`DELETE FROM partner_identity_destruction_events WHERE id = '${result.destruction_event_id}'`))
        .toThrow(/PARTNER_IDENTITY_DESTRUCTION_EVENT_IMMUTABLE/);
    });

    it("replay of a completed destruction is idempotent - same event, no duplicate destructive effect", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const first = destroyPartnerIdentity(db, admin, partnerIdentityId, "destroy");
      const identityAfterFirst = db.prepare("SELECT email, email_hash, destroyed_at FROM partner_identities WHERE id = ?").get(partnerIdentityId);

      const second = destroyPartnerIdentity(db, admin, partnerIdentityId, "destroy again");
      expect(second).toEqual({ destruction_event_id: first.destruction_event_id, replayed: true });
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_destruction_events WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
      expect(db.prepare("SELECT email, email_hash, destroyed_at FROM partner_identities WHERE id = ?").get(partnerIdentityId)).toEqual(identityAfterFirst);
    });

    it("historical evidence the model requires (framework acceptances, payout revisions) survives destruction untouched", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      const sessionId = randomUUID();
      db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
      db.prepare(`INSERT INTO step_up_grants(id, partner_session_id, partner_identity_id, action, resource_json, resource_hash, expires_at)
        VALUES (?, ?, ?, 'PAYOUT_PROFILE_SUPERSESSION', '{}', 'h', datetime('now', '+5 minutes'))`).run("grant-1", sessionId, partnerIdentityId);
      db.prepare(`INSERT INTO payout_profile_revisions(id, partner_identity_id, revision, kind, key_id, ciphertext, nonce, destination_kind, destination_last4, step_up_grant_id)
        VALUES ('pp1', ?, 1, 'ACTIVE_DESTINATION', 'k1', 'ct1', 'n1', 'BANK_CARD', '1111', 'grant-1')`).run(partnerIdentityId);

      destroyPartnerIdentity(db, admin, partnerIdentityId, "destroy");

      expect(db.prepare("SELECT COUNT(*) AS n FROM payout_profile_revisions WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
      expect(db.prepare("SELECT id FROM partner_identities WHERE id = ?").get(partnerIdentityId)).toEqual({ id: partnerIdentityId });
    });

    it("no silent hard-delete path bypasses this authority: destroyPartnerIdentity is the only writer of email/email_hash outside creation", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      destroyPartnerIdentity(db, admin, partnerIdentityId, "destroy");
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identities WHERE id = ?").get(partnerIdentityId)).toEqual({ n: 1 });
    });

    it("fault injection: a poisoned destruction-event insert leaves the identity's PII unscrubbed (whole transaction rolls back)", () => {
      const db = fresh();
      const partnerIdentityId = seedPartner(db);
      db.exec(`CREATE TRIGGER poison_destruction_event BEFORE INSERT ON partner_identity_destruction_events
        BEGIN SELECT RAISE(ABORT, 'INJECTED_DESTRUCTION_FAILURE'); END;`);

      expect(() => destroyPartnerIdentity(db, admin, partnerIdentityId, "destroy")).toThrow(/INJECTED_DESTRUCTION_FAILURE/);
      db.exec("DROP TRIGGER poison_destruction_event");

      const identity = db.prepare("SELECT email FROM partner_identities WHERE id = ?").get(partnerIdentityId) as { email: string };
      expect(identity.email).toBe("p@example.test");
      expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_destruction_events").get()).toEqual({ n: 0 });
      expect(() => destroyPartnerIdentity(db, admin, partnerIdentityId, "retry")).not.toThrow();
    });
  });
});
