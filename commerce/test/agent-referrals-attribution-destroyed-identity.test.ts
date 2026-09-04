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
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, verifyAudienceForPartnerCity, acceptEngagement, activateEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { mintRetentionPolicyRevision, destroyPartnerIdentity } from "../src/agent-referrals-identity-retention";
import { resolveOrderAttribution, AgentReferralsAttributionError } from "../src/agent-referrals-attribution";

/**
 * Integration-hardening round-2 #5b: resolveOrderAttribution's AGENT_
 * REFERRALS branch checks the suspension gate, a live promo authorization,
 * and an ACTIVE engagement - but destroyPartnerIdentity() never revokes an
 * already-live engagement or promo authorization, and never transitions
 * onboarding_state away from PARTNER_ACTIVE. Without an independent
 * destroyed_at check here, a destroyed partner's already-ACTIVE engagement
 * could still receive brand-new checkout attribution and its economic
 * consequences after destruction.
 */

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-attribution-destroyed-")), "commerce.sqlite");
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
  verifyAudienceForPartnerCity(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  return { partner, agentId, partnerIdentityId, cityId, promo };
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
  activateEngagement(db, admin, engagementId, revisionId);
  return engagementId;
};

describe("resolveOrderAttribution: destroyed identity refusal (integration-hardening round-2 #5b)", () => {
  it("a live, ACTIVE, promo-authorized engagement resolves attribution normally before destruction", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const attribution = resolveOrderAttribution(db, { id: p1.promo.promo_code_id, agent_id: p1.agentId }, occ, null);
    expect(attribution.reward_authority_kind).toBe("ENGAGEMENT_SCOPED");
  });

  it("refuses once the owning partner identity is destroyed, even though the engagement remains ACTIVE with a live promo authorization", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);

    mintRetentionPolicyRevision(db, admin, "test policy");
    destroyPartnerIdentity(db, admin, p1.partnerIdentityId, "erasure request");
    expect(getPartnerIdentity(db, p1.partnerIdentityId)!.onboarding_state).toBe("PARTNER_ACTIVE");

    expect(() => resolveOrderAttribution(db, { id: p1.promo.promo_code_id, agent_id: p1.agentId }, occ, null))
      .toThrow(AgentReferralsAttributionError);
    try {
      resolveOrderAttribution(db, { id: p1.promo.promo_code_id, agent_id: p1.agentId }, occ, null);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AgentReferralsAttributionError).code).toBe("AGENT_REFERRALS_ATTRIBUTION_PARTNER_IDENTITY_DESTROYED");
    }
  });
});
