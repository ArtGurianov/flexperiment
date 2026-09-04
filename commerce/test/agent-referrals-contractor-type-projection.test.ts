import { describe, expect, it } from "vitest";
import {
  admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, closeAndComplete, finalizedSettlement,
} from "./support/agent-referrals-settlement-fixtures";
import { finalizeEngagementRewardRegistry } from "../src/agent-referrals-reward-registry";
import { applyAgentReferralsLegalProfile, currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";

/**
 * Integration-hardening #3: agents.contractor_type is the projection target
 * of the immutable agent_referrals_legal_profile_revisions chain, but the
 * pre-existing legacy PATCH path could rewrite the same column to a
 * different value with no awareness a governed legal profile exists, and
 * 0047's own settlement guard only ever compared contractor_type_snapshot
 * against that same mutable column - never against the legal profile's own
 * projected_contractor_type. Proven exploitable: verifying a LEGAL_ENTITY/
 * ORGANIZATION partner then legacy-PATCHing contractor_type to
 * SELF_EMPLOYED left agents.contractor_type contradicting the pinned legal
 * profile, and a settlement could still be minted from that contradiction.
 *
 * Closed at three points (0049): agents.contractor_type may only change to
 * the CURRENT legal profile's own projection once one exists
 * (agents_contractor_type_projection_guard, DB) / domain.patchAgent (app);
 * reward_settlements independently proves contractor_type_snapshot against
 * the pinned legal_profile_revision_id_snapshot's own projection
 * (reward_settlements_contractor_type_projection_guard, DB) - not merely
 * against agents.contractor_type.
 */

describe("agents.contractor_type projection lock (integration-hardening #3)", () => {
  it("app-level: legacy patchAgent refuses a value that contradicts the governed agent's current legal profile", () => {
    const { db, domain } = fresh();
    const agentId = String(domain.createAgent({
      slug: "org-partner", display_name: "Org Partner", legal_name: "Org LLC", email: "org@example.com",
      contractor_type: "ORGANIZATION", inn: "7700000001", contract_reference: "ref-1", default_reward_type: "FIXED", default_reward_value: 100,
    }).id);
    applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "verified" });

    expect(() => domain.patchAgent(agentId, { contractor_type: "SELF_EMPLOYED" })).toThrow("AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_LOCKED");
    expect((db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(agentId) as { contractor_type: string }).contractor_type).toBe("ORGANIZATION");
  });

  it("app-level: legacy patchAgent still allows an ungoverned agent's contractor_type to change freely", () => {
    const { db, domain } = fresh();
    const agentId = String(domain.createAgent({
      slug: "legacy-partner", display_name: "Legacy Partner", legal_name: "Legacy LLC", email: "legacy@example.com",
      contractor_type: "SELF_EMPLOYED", inn: "7700000002", contract_reference: "ref-2", default_reward_type: "FIXED", default_reward_value: 100,
    }).id);
    expect(() => domain.patchAgent(agentId, { contractor_type: "INDIVIDUAL_ENTREPRENEUR" })).not.toThrow();
    expect((db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(agentId) as { contractor_type: string }).contractor_type).toBe("INDIVIDUAL_ENTREPRENEUR");
  });

  it("app-level: patching a governed agent's contractor_type to its OWN current projection is a harmless no-op, never refused", () => {
    const { db, domain } = fresh();
    const agentId = String(domain.createAgent({
      slug: "org-partner-2", display_name: "Org Partner 2", legal_name: "Org LLC 2", email: "org2@example.com",
      contractor_type: "ORGANIZATION", inn: "7700000003", contract_reference: "ref-3", default_reward_type: "FIXED", default_reward_value: 100,
    }).id);
    applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "verified" });
    expect(() => domain.patchAgent(agentId, { contractor_type: "ORGANIZATION", display_name: "Renamed" })).not.toThrow();
    expect((db.prepare("SELECT display_name FROM agents WHERE id = ?").get(agentId) as { display_name: string }).display_name).toBe("Renamed");
  });

  it("DB-level: a raw UPDATE of agents.contractor_type is refused once a legal profile governs the agent, even bypassing patchAgent entirely", () => {
    const { db, domain } = fresh();
    const agentId = String(domain.createAgent({
      slug: "org-partner-3", display_name: "Org Partner 3", legal_name: "Org LLC 3", email: "org3@example.com",
      contractor_type: "ORGANIZATION", inn: "7700000004", contract_reference: "ref-4", default_reward_type: "FIXED", default_reward_value: 100,
    }).id);
    applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "verified" });
    expect(() => db.prepare("UPDATE agents SET contractor_type = 'SELF_EMPLOYED' WHERE id = ?").run(agentId)).toThrow(/AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_LOCKED/);
  });

  it("DB-level: the legitimate projection writer (applyAgentReferralsLegalProfile) is unaffected by the new guard", () => {
    const { db, domain } = fresh();
    const agentId = String(domain.createAgent({
      slug: "org-partner-4", display_name: "Org Partner 4", legal_name: "Org LLC 4", email: "org4@example.com",
      contractor_type: "SELF_EMPLOYED", inn: "7700000005", contract_reference: "ref-5", default_reward_type: "FIXED", default_reward_value: 100,
    }).id);
    // Individual/NPD -> SELF_EMPLOYED first (matches the legacy create value), then a genuine re-verification to LEGAL_ENTITY/ORGANIZATION - a real projection CHANGE, exactly what the guard must never block.
    applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "INDIVIDUAL", tax_mode: "NPD", reason: "initial verification" });
    expect(() => applyAgentReferralsLegalProfile(db, { agent_id: agentId, legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "re-verified as an organization" })).not.toThrow();
    expect(currentAgentReferralsLegalProfile(db, agentId)?.projected_contractor_type).toBe("ORGANIZATION");
    expect((db.prepare("SELECT contractor_type FROM agents WHERE id = ?").get(agentId) as { contractor_type: string }).contractor_type).toBe("ORGANIZATION");
  });

  it("DB-level: a real, legitimately-minted AGENT_REFERRALS settlement passes the new reward_settlements guard unchanged", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "projection-guard-1@example.test", "idem-projection-guard-1");
    expect(() => finalizedSettlement(db, domain, occ, engagementId)).not.toThrow();
  });

  it("DB-level: a fabricated AGENT_REFERRALS settlement whose contractor_type_snapshot contradicts the pinned legal profile's own projection is refused", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "projection-guard-2@example.test", "idem-projection-guard-2");
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed");

    const registry = db.prepare("SELECT id FROM engagement_reward_registry_snapshot WHERE engagement_id = ?").get(engagementId) as { id: string };
    const effective = { id: finalize.effective_snapshot_id };
    expect(registry).toBeTruthy();

    // Fabricate a PREPARED settlement directly (raw SQL, dropping the
    // pre-existing 0047 tuple-consistency guard so only the NEW guard under
    // test is exercised) whose contractor_type_snapshot is a real, valid
    // enum value that simply does NOT match the pinned legal profile's own
    // projected_contractor_type (readyPartner's default legal profile
    // projects INDIVIDUAL_ENTREPRENEUR for tax_mode OTHER).
    db.exec("DROP TRIGGER reward_settlements_authority_tuple_consistency_guard");
    expect(() => db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id, settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot)
      SELECT 'fabricated-settlement', a.id, e.occurrence_id, 1, 'PAYOUT_PROFILE', 'PREPARED', 'ORGANIZATION', datetime('now'), 'admin', 'AGENT_REFERRALS', e.id, er.id, ?, 'h', ?, pi.id, pp.id, lp.tax_mode, lp.id
      FROM engagements e JOIN partner_identities pi ON pi.id = e.partner_identity_id JOIN agents a ON a.id = pi.agent_id
      JOIN engagement_revisions er ON er.engagement_id = e.id
      JOIN payout_profile_revisions pp ON pp.partner_identity_id = pi.id JOIN agent_referrals_legal_profile_revisions lp ON lp.id = pi.legal_profile_revision_id
      WHERE e.id = ? LIMIT 1`).run(registry.id, effective.id, engagementId))
      .toThrow(/AGENT_REFERRALS_SETTLEMENT_CONTRACTOR_TYPE_PROJECTION_MISMATCH/);
  });
});
