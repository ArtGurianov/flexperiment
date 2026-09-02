import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { mintAudienceVerificationEvent } from "../src/agent-referrals-audience-verification";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, acceptEngagement, activateEngagement, getEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { revokeDelegationAsAdmin, revokeDelegationAsPartner, isDelegationEffective, DelegationRevocationError } from "../src/agent-referrals-delegation-revocation";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-delegation-revocation-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

const readyPartner = (db: Database.Database) => {
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', 'Agent Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL", "NPD");
  verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");
  const fw = mintFrameworkAgreementRevision(db, clause(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES));
  const dt = mintDelegationTemplateRevision(db, clause(DELEGATION_TEMPLATE_REQUIRED_CLAUSES));
  issueFrameworkToPartner(db, admin, partnerIdentityId, fw.id, dt.id, "issued");
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
  const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { framework_agreement_revision_id: fw.id, delegation_template_revision_id: dt.id }).grant_id;
  acceptFrameworkAndDelegation(db, partner, grant, fw.id, dt.id);
  activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");
  const cityId = randomUUID();
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
  mintAudienceVerificationEvent(db, admin, partnerIdentityId, cityId, "VERIFIED", "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  const delegationId = (db.prepare("SELECT id FROM ord_reporting_delegations WHERE partner_identity_id = ?").get(partnerIdentityId) as { id: string }).id;
  return { partner, agentId, partnerIdentityId, cityId, promo, delegationId };
};

const terms1: EngagementRevisionTerms = {
  reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: {},
};

const seedOccurrence = (db: Database.Database, cityId: string) => {
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId);
  return occurrenceId;
};

const activatedEngagement = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  const activation = activateEngagement(db, admin, engagementId, revisionId);
  return { engagementId, activation };
};

describe("delegation revocation: one transaction, forward-only, preserves the reporting tail", () => {
  it("effective by default; not effective once revoked", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    expect(isDelegationEffective(db, p1.partnerIdentityId)).toBe(true);
    revokeDelegationAsAdmin(db, admin, p1.delegationId, "compliance");
    expect(isDelegationEffective(db, p1.partnerIdentityId)).toBe(false);
  });

  it("admin revocation, in the same transaction, suspends every currently-ACTIVE engagement for that partner and revokes its promo authorization", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagementId, activation } = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);

    const result = revokeDelegationAsAdmin(db, admin, p1.delegationId, "compliance action");
    expect(result.suspended_engagement_ids).toEqual([engagementId]);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    const authorization = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(activation.promo_authorization_id) as { revoked_at: string | null };
    expect(authorization.revoked_at).not.toBeNull();
  });

  it("the partner's permanent promo is not disabled globally by delegation revocation", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    revokeDelegationAsAdmin(db, admin, p1.delegationId, "compliance");
    const promoRow = db.prepare("SELECT status FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { status: string };
    expect(promoRow.status).toBe("ACTIVE");
  });

  it("a partner may self-revoke their own delegation with a fresh step-up grant, and cannot revoke another partner's delegation", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const p2 = readyPartner(db);
    const wrongGrant = mintEngagementStepUpGrant(db, p1.partner, "DELEGATION_REVOCATION", { delegation_id: p2.delegationId }).grant_id;
    expect(() => revokeDelegationAsPartner(db, p1.partner, p2.delegationId, wrongGrant, "x")).toThrow(DelegationRevocationError);

    const grant = mintEngagementStepUpGrant(db, p1.partner, "DELEGATION_REVOCATION", { delegation_id: p1.delegationId }).grant_id;
    const result = revokeDelegationAsPartner(db, p1.partner, p1.delegationId, grant, "self-revoke");
    expect(result.revocation_id).toBeTruthy();
    expect(isDelegationEffective(db, p1.partnerIdentityId)).toBe(false);
    const revocation = db.prepare("SELECT revoked_by_realm, revoked_by_admin_id FROM ord_reporting_delegation_revocations WHERE id = ?").get(result.revocation_id);
    expect(revocation).toEqual({ revoked_by_realm: "PARTNER", revoked_by_admin_id: null });
  });

  it("a delegation can be revoked at most once, ever - a second attempt is refused", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    revokeDelegationAsAdmin(db, admin, p1.delegationId, "first");
    expect(() => revokeDelegationAsAdmin(db, admin, p1.delegationId, "second")).toThrow(/AGENT_REFERRALS_DELEGATION_ALREADY_REVOKED/);
  });

  it("remains permitted under global SUSPENDED (MATURATION_RECOVERY_REPORTING_TAIL), blocked only under DORMANT", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" });
    expect(() => revokeDelegationAsAdmin(db, admin, p1.delegationId, "still allowed under suspension")).not.toThrow();
  });

  it("blocked under DORMANT (the feature never activated, so there is no prior obligation to continue)", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    // There is no legal runtime path back to DORMANT (agent-referrals-feature-state.ts's
    // LEGAL_EDGES has no such edge) - direct row manipulation is the only way to reach
    // it in a test, exactly like agent-referrals-suspension-policy.test.ts's own proof
    // that DORMANT blocks every operation class, including MATURATION_RECOVERY_REPORTING_TAIL.
    db.prepare("UPDATE agent_referrals_feature_state SET state = 'DORMANT', owner_id = NULL WHERE singleton = 1").run();
    expect(() => revokeDelegationAsAdmin(db, admin, p1.delegationId, "x")).toThrow(/AGENT_REFERRALS_FEATURE_DORMANT/);
  });

  describe("fault injection", () => {
    it("a fault at the revocation-cascade suspension rolls back the revocation row too - no partial state", () => {
      const db = fresh();
      const p1 = readyPartner(db);
      const occ = seedOccurrence(db, p1.cityId);
      activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);

      db.exec(`CREATE TRIGGER poison_delegation_revocation BEFORE INSERT ON partner_identity_events
        WHEN NEW.event_kind = 'DELEGATION_REVOKED' BEGIN SELECT RAISE(ABORT, 'INJECTED_DELEGATION_REVOCATION_FAILURE'); END;`);
      expect(() => revokeDelegationAsAdmin(db, admin, p1.delegationId, "x")).toThrow(/INJECTED_DELEGATION_REVOCATION_FAILURE/);
      db.exec("DROP TRIGGER poison_delegation_revocation");

      expect(isDelegationEffective(db, p1.partnerIdentityId)).toBe(true); // rolled back
      const retry = revokeDelegationAsAdmin(db, admin, p1.delegationId, "retry");
      expect(retry.revocation_id).toBeTruthy();
    });
  });
});
