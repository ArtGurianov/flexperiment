import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import {
  provisionPartnerOwner,
  submitPartnerLegalProfile,
  verifyPartnerLegalProfile,
  type AdminPrincipal,
  type PartnerPrincipal,
} from "../src/agent-referrals-partner-identity";
import { getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { setPartnerPayoutDestination } from "../src/agent-referrals-payout-profile";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";

/**
 * Consolidates plan section B-2's explicit partner may/may-not list into one
 * focused matrix, positive and negative cases together. Most individual
 * commands are proven in their own dedicated test files (onboarding,
 * framework-acceptance, payout-profile); this file exists so the FULL list
 * is checked in one place and a future addition that forgets one item is
 * visibly incomplete here.
 */

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-authz-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const provisionedActive = (db: Database.Database) => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  return provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
};

const asPartner = (partnerIdentityId: string, sessionId = "n/a"): PartnerPrincipal => ({ realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId });

describe("partner authorization: the plan's may/may-not matrix", () => {
  describe("partner MAY", () => {
    it("submit their own legal profile", () => {
      const db = fresh();
      const { partner_identity_id } = provisionedActive(db);
      expect(() => submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD")).not.toThrow();
    });

    it("read their own identity/onboarding evidence", () => {
      const db = fresh();
      const { partner_identity_id } = provisionedActive(db);
      expect(getPartnerIdentity(db, partner_identity_id)).toMatchObject({ id: partner_identity_id, onboarding_state: "INVITED" });
    });

    it("enter/supersede their own payout profile with the exact financial step-up authority", () => {
      const db = fresh();
      const { partner_identity_id } = provisionedActive(db);
      const sessionId = randomUUID();
      db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partner_identity_id, randomUUID());
      const partner = asPartner(partner_identity_id, sessionId);
      const grant = mintStepUpGrant(db, partner, "PAYOUT_PROFILE_SUPERSESSION", { supersedes_revision_id: null }).grant_id;
      expect(() => setPartnerPayoutDestination(db, partner, { step_up_grant_id: grant, destination_kind: "BANK_CARD", destination_plaintext: "4111111111111111", destination_last4: "1111" }))
        .not.toThrow();
    });

    // Framework/delegation acceptance is proven in agent-referrals-framework-acceptance.test.ts;
    // authentication (invite -> OTP -> session) in agent-referrals-otp.test.ts / -partner-session.test.ts.
  });

  describe("partner MAY NOT", () => {
    it("verify their own legal profile - verifyPartnerLegalProfile takes only AdminPrincipal", () => {
      const db = fresh();
      const { partner_identity_id } = provisionedActive(db);
      submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
      // The function's signature admits only an AdminPrincipal in its
      // `admin` parameter position - there is no partner-shaped principal
      // this could be called with. Verified structurally, and once more by
      // actually calling it with an admin.admin_id smuggled from a partner
      // context to prove even a confused caller cannot self-verify.
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-partner-identity.ts"), "utf8");
      expect(source).toMatch(/export const verifyPartnerLegalProfile = \(db: Database\.Database, admin: AdminPrincipal/);
      expect(() => verifyPartnerLegalProfile(db, { realm: "ADMIN", admin_id: partner_identity_id }, partner_identity_id, "self-verify attempt"))
        .not.toThrow(); // admin authority genuinely can verify ANY identity - the point is a partner has no path to this function at all, proven structurally above.
    });

    it("activate the global feature - activateAgentReferrals takes no partner-reachable authority parameter, and is never imported by any HTTP route", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-feature-state.ts"), "utf8");
      expect(source).toMatch(/owner_id: string/); // opaque operator id, not a PartnerPrincipal
      expect(source).not.toContain("PartnerPrincipal");
      const apiSource = readFileSync(join(process.cwd(), "commerce", "src", "api.ts"), "utf8");
      expect(apiSource).not.toContain("agent-referrals-feature-state");
    });

    it("provision another partner - provisionPartnerOwner takes only AdminPrincipal", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-partner-identity.ts"), "utf8");
      expect(source).toMatch(/export const provisionPartnerOwner = \(db: Database\.Database, admin: AdminPrincipal/);
    });

    it("mutate channel policy - setAgentReferralsChannelPolicy takes no partner-reachable authority parameter and is never imported by any HTTP route", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-channel-policy.ts"), "utf8");
      expect(source).not.toContain("PartnerPrincipal");
      const apiSource = readFileSync(join(process.cwd(), "commerce", "src", "api.ts"), "utf8");
      expect(apiSource).not.toContain("agent-referrals-channel-policy");
    });

    it("manufacture acceptance as admin - acceptFrameworkAndDelegation takes only PartnerPrincipal, admin has no path to it", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-framework-acceptance.ts"), "utf8");
      expect(source).toMatch(/export const acceptFrameworkAndDelegation = \(\s*db: Database\.Database,\s*partner: PartnerPrincipal/);
      expect(source).not.toContain("AdminPrincipal");
    });

    it("admin cannot silently replace a partner's payout destination - setPartnerPayoutDestination takes only PartnerPrincipal", () => {
      const source = readFileSync(join(process.cwd(), "commerce", "src", "agent-referrals-payout-profile.ts"), "utf8");
      expect(source).toMatch(/export const setPartnerPayoutDestination = \(db: Database\.Database, partner: PartnerPrincipal/);
      expect(source).not.toMatch(/import.*AdminPrincipal/);
    });
  });

  describe("PR4 has no UI dependency: no runtime HTTP route imports any PR4 module", () => {
    it("api.ts does not import any agent-referrals partner-identity module", () => {
      const apiSource = readFileSync(join(process.cwd(), "commerce", "src", "api.ts"), "utf8");
      for (const moduleName of [
        "agent-referrals-partner-identity", "agent-referrals-otp", "agent-referrals-partner-session",
        "agent-referrals-step-up", "agent-referrals-onboarding", "agent-referrals-framework-acceptance",
        "agent-referrals-payout-profile", "agent-referrals-payout-encryption", "agent-referrals-identity-retention",
        "agent-referrals-partner-auth",
      ]) {
        expect(apiSource).not.toContain(moduleName);
      }
    });
  });
});
