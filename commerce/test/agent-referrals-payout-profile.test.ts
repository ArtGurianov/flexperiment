import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { agentReferralsActivationEvidence } from "../src/agent-referrals-activation";
import { decryptPayoutDestination, encryptPayoutDestination } from "../src/agent-referrals-payout-encryption";
import { allPayoutProfileRevisions, currentPayoutProfile, revokePartnerPayoutDestination, setPartnerPayoutDestination } from "../src/agent-referrals-payout-profile";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import type { PartnerPrincipal } from "../src/agent-referrals-partner-identity";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-payout-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const seedPartnerWithSession = (db: Database.Database): PartnerPrincipal => {
  const agentId = randomUUID();
  const partnerIdentityId = randomUUID();
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  db.prepare(`INSERT INTO partner_identities(id, agent_id, email, email_hash, created_by_admin_id) VALUES (?, ?, 'p@example.test', 'h', 'admin')`).run(partnerIdentityId, agentId);
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  return { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
};

const SENSITIVE_CARD = "4111111111111111";

const grantFor = (db: Database.Database, partner: PartnerPrincipal, supersedesRevisionId: string | null) =>
  mintStepUpGrant(db, partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: supersedesRevisionId }).grant_id;

describe("payout-profile revisions", () => {
  describe("encryption", () => {
    it("uses AES-256-GCM and pins a versioned key id into the activation manifest", () => {
      const db = fresh();
      const encrypted = encryptPayoutDestination(db, SENSITIVE_CARD);
      expect(encrypted.key_id).toBeTruthy();
      expect(encrypted.ciphertext).not.toContain(SENSITIVE_CARD);
      expect(agentReferralsActivationEvidence(db, "payout_profile_encryption_key_id")).toBe(encrypted.key_id);
      expect(decryptPayoutDestination(encrypted.key_id, encrypted.ciphertext, encrypted.nonce)).toBe(SENSITIVE_CARD);
    });

    it("idempotently re-pins the same key id on a second encryption call", () => {
      const db = fresh();
      const first = encryptPayoutDestination(db, "card-a");
      const second = encryptPayoutDestination(db, "card-b");
      expect(second.key_id).toBe(first.key_id);
      expect(agentReferralsActivationEvidence(db, "payout_profile_encryption_key_id")).toBe(first.key_id);
    });

    it("fails closed if a different key id is already pinned in the manifest (PR3's insert-only semantics, not weakened)", () => {
      const db = fresh();
      encryptPayoutDestination(db, "card-a"); // pins the real configured key id
      // Simulate a manifest that already carries a DIFFERENT key id, as if
      // rotated out from under this deployment.
      db.prepare("UPDATE agent_referrals_activation_manifest SET value_json = ? WHERE key = 'payout_profile_encryption_key_id'").run(JSON.stringify("some-other-key-id"));
      expect(() => encryptPayoutDestination(db, "card-b")).toThrow(/AGENT_REFERRALS_ACTIVATION_EVIDENCE_CONFLICT/);
    });

    it("decrypt refuses a mismatched key id", () => {
      const db = fresh();
      const encrypted = encryptPayoutDestination(db, SENSITIVE_CARD);
      expect(() => decryptPayoutDestination("wrong-key-id", encrypted.ciphertext, encrypted.nonce)).toThrow(/AGENT_REFERRALS_PAYOUT_KEY_MISMATCH/);
    });
  });

  describe("create / supersede / revoke", () => {
    it("creates the first revision, requiring the exact financial step-up grant", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const grant = grantFor(db, partner, null);
      const profile = setPartnerPayoutDestination(db, partner, { step_up_grant_id: grant, destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" });
      expect(profile).toMatchObject({ revision: 1, kind: "ACTIVE_DESTINATION", destination_kind: "BANK_CARD", destination_last4: "1111" });
    });

    it("without a valid step-up grant, the write is refused entirely", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      expect(() => setPartnerPayoutDestination(db, partner, { step_up_grant_id: "nonexistent", destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" }))
        .toThrow(/AGENT_REFERRALS_STEP_UP_GRANT_INVALID/);
      expect(currentPayoutProfile(db, partner.partner_identity_id)).toBeNull();
    });

    it("supersedes to revision 2, old revision remains immutable and readable", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const first = setPartnerPayoutDestination(db, partner, { step_up_grant_id: grantFor(db, partner, null), destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" });
      const second = setPartnerPayoutDestination(db, partner, { step_up_grant_id: grantFor(db, partner, first.id), destination_kind: "BANK_ACCOUNT", destination_plaintext: "40817810000000000001", destination_last4: "0001" });
      expect(second).toMatchObject({ revision: 2, supersedes_revision_id: first.id, destination_kind: "BANK_ACCOUNT" });
      expect(currentPayoutProfile(db, partner.partner_identity_id)).toMatchObject({ id: second.id });
      const all = allPayoutProfileRevisions(db, partner.partner_identity_id);
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({ revision: 1, destination_kind: "BANK_CARD" }); // historical revision unchanged
    });

    it("revokes: closes the profile with no destination fields, no mutation of the prior row", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const first = setPartnerPayoutDestination(db, partner, { step_up_grant_id: grantFor(db, partner, null), destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" });
      const revoked = revokePartnerPayoutDestination(db, partner, grantFor(db, partner, first.id));
      expect(revoked).toMatchObject({ revision: 2, kind: "REVOKED", destination_kind: null, destination_last4: null, supersedes_revision_id: first.id });
      const historical = allPayoutProfileRevisions(db, partner.partner_identity_id)[0];
      expect(historical).toMatchObject({ revision: 1, kind: "ACTIVE_DESTINATION", destination_kind: "BANK_CARD" });
    });

    it("payout profile is optional - a fresh identity with no revision at all reads null, not an error", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      expect(currentPayoutProfile(db, partner.partner_identity_id)).toBeNull();
    });
  });

  describe("immutability and redaction", () => {
    it("direct UPDATE and DELETE on a filed revision are refused", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const revision = setPartnerPayoutDestination(db, partner, { step_up_grant_id: grantFor(db, partner, null), destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" });
      expect(() => db.exec(`UPDATE payout_profile_revisions SET destination_last4 = '9999' WHERE id = '${revision.id}'`)).toThrow(/PAYOUT_PROFILE_REVISION_IMMUTABLE/);
      expect(() => db.exec(`DELETE FROM payout_profile_revisions WHERE id = '${revision.id}'`)).toThrow(/PAYOUT_PROFILE_REVISION_IMMUTABLE/);
    });

    it("the redacted read model never carries key_id, ciphertext or nonce", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const profile = setPartnerPayoutDestination(db, partner, { step_up_grant_id: grantFor(db, partner, null), destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" });
      expect(profile).not.toHaveProperty("key_id");
      expect(profile).not.toHaveProperty("ciphertext");
      expect(profile).not.toHaveProperty("nonce");
    });

    it("the raw SQLite row never contains the plaintext sensitive fixture string, only ciphertext", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      setPartnerPayoutDestination(db, partner, { step_up_grant_id: grantFor(db, partner, null), destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" });
      const raw = db.prepare("SELECT * FROM payout_profile_revisions WHERE partner_identity_id = ?").get(partner.partner_identity_id) as Record<string, unknown>;
      for (const value of Object.values(raw)) if (typeof value === "string") expect(value).not.toContain(SENSITIVE_CARD);
      expect(raw.ciphertext).toBeTruthy();
    });
  });

  describe("fault injection", () => {
    it("failure persisting the revision leaves the grant unconsumed and reusable", () => {
      const db = fresh();
      const partner = seedPartnerWithSession(db);
      const grant = grantFor(db, partner, null);
      db.exec(`CREATE TRIGGER poison_payout_insert BEFORE INSERT ON payout_profile_revisions
        BEGIN SELECT RAISE(ABORT, 'INJECTED_PAYOUT_FAILURE'); END;`);

      expect(() => setPartnerPayoutDestination(db, partner, { step_up_grant_id: grant, destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" }))
        .toThrow(/INJECTED_PAYOUT_FAILURE/);
      db.exec("DROP TRIGGER poison_payout_insert");

      expect(currentPayoutProfile(db, partner.partner_identity_id)).toBeNull();
      expect(db.prepare("SELECT consumed_at FROM step_up_grants WHERE id = ?").get(grant)).toEqual({ consumed_at: null });
      expect(() => setPartnerPayoutDestination(db, partner, { step_up_grant_id: grant, destination_kind: "BANK_CARD", destination_plaintext: SENSITIVE_CARD, destination_last4: "1111" })).not.toThrow();
    });
  });
});
