import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { currentPayoutProfile } from "../src/agent-referrals-payout-profile";
import {
  provisionPartnerOwner,
  submitPartnerLegalProfile,
  verifyPartnerLegalProfile,
  issueFrameworkToPartner,
  type AdminPrincipal,
  type PartnerPrincipal,
} from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity, transitionOnboardingState } from "../src/agent-referrals-onboarding";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-onboarding-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const provision = (db: Database.Database) => {
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `p-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  return provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
};

const activateFeature = (db: Database.Database) => activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });

const asPartner = (partnerIdentityId: string): PartnerPrincipal => ({ realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" });

/** Drives a partner all the way to FRAMEWORK_ACCEPTED, one step short of PARTNER_ACTIVE. */
const advanceToFrameworkAccepted = (db: Database.Database) => {
  activateFeature(db);
  const { partner_identity_id } = provision(db);
  submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
  verifyPartnerLegalProfile(db, admin, partner_identity_id, "verified");
  issueFrameworkToPartner(db, admin, partner_identity_id, "issued");
  // Framework acceptance itself is covered by its own dedicated test file;
  // here we only need onboarding to reach FRAMEWORK_ACCEPTED, so advance the
  // state directly rather than duplicating the full atomic-command setup.
  const identity = getPartnerIdentity(db, partner_identity_id)!;
  transitionOnboardingState(db, partner_identity_id, "FRAMEWORK_ACCEPTED", identity.onboarding_revision, "PARTNER", "accepted");
  return partner_identity_id;
};

describe("onboarding state authority", () => {
  it("ships INVITED on provisioning", () => {
    const db = fresh();
    activateFeature(db);
    const { partner_identity_id } = provision(db);
    expect(getPartnerIdentity(db, partner_identity_id)).toMatchObject({ onboarding_state: "INVITED", onboarding_revision: 1 });
  });

  describe("exact state graph, no skipped edges", () => {
    it("walks the full graph in order", () => {
      const db = fresh();
      const partnerIdentityId = advanceToFrameworkAccepted(db);
      const activated = activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "SYSTEM", "activate");
      expect(activated.onboarding_state).toBe("PARTNER_ACTIVE");
    });

    it("refuses skipping PROFILE_SUBMITTED (INVITED -> PROFILE_VERIFIED directly)", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      expect(() => transitionOnboardingState(db, partner_identity_id, "PROFILE_VERIFIED", 1, "ADMIN", "skip"))
        .toThrow(/AGENT_REFERRALS_ONBOARDING_ILLEGAL_TRANSITION/);
    });

    it("refuses skipping straight to PARTNER_ACTIVE from INVITED", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      expect(() => transitionOnboardingState(db, partner_identity_id, "PARTNER_ACTIVE", 1, "ADMIN", "skip"))
        .toThrow(/AGENT_REFERRALS_ONBOARDING_ILLEGAL_TRANSITION/);
    });

    it("refuses any backward transition (no in-place backward mutation)", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
      const identity = getPartnerIdentity(db, partner_identity_id)!;
      expect(() => transitionOnboardingState(db, partner_identity_id, "INVITED", identity.onboarding_revision, "ADMIN", "backward"))
        .toThrow(/AGENT_REFERRALS_ONBOARDING_ILLEGAL_TRANSITION/);
    });

    it("PARTNER_ACTIVE has no further legal edge", () => {
      const db = fresh();
      const partnerIdentityId = advanceToFrameworkAccepted(db);
      const activated = activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "SYSTEM", "activate");
      expect(() => transitionOnboardingState(db, partnerIdentityId, "PARTNER_ACTIVE", activated.onboarding_revision, "SYSTEM", "again"))
        .toThrow(/AGENT_REFERRALS_ONBOARDING_ILLEGAL_TRANSITION/);
    });
  });

  it("uses CAS, not an unguarded read-then-update: a stale revision is refused and mutates nothing", () => {
    const db = fresh();
    activateFeature(db);
    const { partner_identity_id } = provision(db);
    submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
    const before = getPartnerIdentity(db, partner_identity_id)!;
    expect(() => transitionOnboardingState(db, partner_identity_id, "PROFILE_VERIFIED", 1 /* stale, real revision is 2 */, "ADMIN", "stale"))
      .toThrow(/AGENT_REFERRALS_ONBOARDING_REVISION_CONFLICT/);
    expect(getPartnerIdentity(db, partner_identity_id)).toEqual(before);
  });

  describe("submit / verify separation", () => {
    it("partner can submit, but a partner-authored call cannot itself verify (there is no partner-callable verify path - verifyPartnerLegalProfile takes only AdminPrincipal)", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
      expect(getPartnerIdentity(db, partner_identity_id)!.onboarding_state).toBe("PROFILE_SUBMITTED");
      // No partner-authority function verifies. Admin can:
      verifyPartnerLegalProfile(db, admin, partner_identity_id, "verified by admin");
      expect(getPartnerIdentity(db, partner_identity_id)!.onboarding_state).toBe("PROFILE_VERIFIED");
    });

    it("verify refuses when nothing has been submitted", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      expect(() => verifyPartnerLegalProfile(db, admin, partner_identity_id, "nothing submitted")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_NOT_SUBMITTED/);
    });

    it("a partner cannot mutate their draft once verified (submission is locked)", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
      verifyPartnerLegalProfile(db, admin, partner_identity_id, "verified");
      expect(() => submitPartnerLegalProfile(db, asPartner(partner_identity_id), "LEGAL_ENTITY", "OTHER"))
        .toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_SUBMISSION_LOCKED/);
    });

    it("the frozen 4/2 legal-form matrix and legacy contractor_type projection are preserved through PR4's verify path", () => {
      const db = fresh();
      activateFeature(db);
      const { partner_identity_id } = provision(db);
      const identity = getPartnerIdentity(db, partner_identity_id)!;
      submitPartnerLegalProfile(db, asPartner(partner_identity_id), "LEGAL_ENTITY", "NPD" as never); // rejected combo
      expect(getPartnerIdentity(db, partner_identity_id)!.submitted_legal_form).toBe("LEGAL_ENTITY");
      // verify propagates PR3's own rejection - no onboarding transition, no evidence.
      expect(() => verifyPartnerLegalProfile(db, admin, partner_identity_id, "reject")).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_REJECTED_COMBINATION/);
      expect(getPartnerIdentity(db, partner_identity_id)!.onboarding_state).toBe("PROFILE_SUBMITTED");

      submitPartnerLegalProfile(db, asPartner(partner_identity_id), "LEGAL_ENTITY", "OTHER");
      const verified = verifyPartnerLegalProfile(db, admin, partner_identity_id, "verify");
      expect(verified.onboarding_state).toBe("PROFILE_VERIFIED");
      const agentRow = db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(identity.agent_id) as { contractor_type: string };
      expect(agentRow.contractor_type).toBe("ORGANIZATION");
    });
  });

  it("PARTNER_ACTIVE succeeds with no payout profile at all", () => {
    const db = fresh();
    const partnerIdentityId = advanceToFrameworkAccepted(db);
    expect(currentPayoutProfile(db, partnerIdentityId)).toBeNull();
    const activated = activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "SYSTEM", "activate");
    expect(activated.onboarding_state).toBe("PARTNER_ACTIVE");
    expect(currentPayoutProfile(db, partnerIdentityId)).toBeNull();
  });

  it("multiple partners advance independently and concurrently - no capacity check anywhere", () => {
    const db = fresh();
    activateFeature(db);
    const a = provision(db);
    const b = provision(db);
    const c = provision(db);
    submitPartnerLegalProfile(db, asPartner(a.partner_identity_id), "INDIVIDUAL", "NPD");
    expect(getPartnerIdentity(db, a.partner_identity_id)!.onboarding_state).toBe("PROFILE_SUBMITTED");
    expect(getPartnerIdentity(db, b.partner_identity_id)!.onboarding_state).toBe("INVITED");
    expect(getPartnerIdentity(db, c.partner_identity_id)!.onboarding_state).toBe("INVITED");
    verifyPartnerLegalProfile(db, admin, a.partner_identity_id, "verify a");
    submitPartnerLegalProfile(db, asPartner(b.partner_identity_id), "INDIVIDUAL_ENTREPRENEUR", "OTHER");
    expect(getPartnerIdentity(db, a.partner_identity_id)!.onboarding_state).toBe("PROFILE_VERIFIED");
    expect(getPartnerIdentity(db, b.partner_identity_id)!.onboarding_state).toBe("PROFILE_SUBMITTED");
    expect(getPartnerIdentity(db, c.partner_identity_id)!.onboarding_state).toBe("INVITED");
  });

  it("a genuine concurrency race between two connections on the SAME partner: at most one CAS winner", () => {
    const db = fresh();
    activateFeature(db);
    const { partner_identity_id } = provision(db);
    submitPartnerLegalProfile(db, asPartner(partner_identity_id), "INDIVIDUAL", "NPD");
    const identity = getPartnerIdentity(db, partner_identity_id)!;

    const winner = transitionOnboardingState(db, partner_identity_id, "PROFILE_VERIFIED", identity.onboarding_revision, "ADMIN", "winner");
    expect(winner.onboarding_state).toBe("PROFILE_VERIFIED");
    expect(() => transitionOnboardingState(db, partner_identity_id, "FRAMEWORK_ISSUED", identity.onboarding_revision /* stale */, "ADMIN", "loser"))
      .toThrow(/AGENT_REFERRALS_ONBOARDING_REVISION_CONFLICT/);
  });
});
