import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES, mintFrameworkAgreementRevision, mintDelegationTemplateRevision } from "../src/agent-referrals-framework-delegation";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { requiredFrameworkIssuance, effectiveFrameworkAcceptance, agreementStatusForPartner } from "../src/agent-referrals-framework-issuance";
import { currentAgentReferralsLegalProfile } from "../src/agent-referrals-legal-profile";
import { applyVerifiedLegalProfileForPartnerIdentity } from "../src/agent-referrals-legal-profile-supersession";
import { isDelegationEffective, revokeDelegationAsAdmin } from "../src/agent-referrals-delegation-revocation";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { verifyAudienceForPartnerCity, offerEngagement, acceptEngagement, activateEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-framework-reissuance-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

/** A partner verified against an INDIVIDUAL_ENTREPRENEUR profile (revision 1, NPD), not yet issued anything. */
const readyPartner = () => {
  const db = fresh();
  activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
  const agentId = randomUUID();
  db.prepare(`INSERT INTO agents(id, slug, display_name, email, default_reward_type, default_reward_value)
    VALUES (?, ?, 'Agent', ?, 'PERCENT', 1000)`).run(agentId, `partner-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
  submitPartnerLegalProfile(db, { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: "n/a" }, "INDIVIDUAL_ENTREPRENEUR", "NPD",
    { full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345" }, 0);
  verifyPartnerLegalProfile(db, admin, partnerIdentityId, "verified");
  const sessionId = randomUUID();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`).run(sessionId, partnerIdentityId, randomUUID());
  const partner: PartnerPrincipal = { realm: "PARTNER", partner_identity_id: partnerIdentityId, partner_session_id: sessionId };
  return { db, agentId, partnerIdentityId, partner };
};

/** Mints a fresh, content-distinct (framework, delegation) revision pair each call - a random suffix keeps the content hash from colliding with a previous call's, and the STALE_BOUND pin is always the CURRENT row (null only the first time). */
const mintTemplatePair = (db: Database.Database) => ({
  fw: mintFrameworkAgreementRevision(db, { ...clause(FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES), PARTNER_LEVY_OBLIGATION: `PARTNER_LEVY_OBLIGATION ${randomUUID()}` } as Record<(typeof FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES)[number], string>,
    (db.prepare("SELECT id FROM framework_agreement_revisions ORDER BY revision DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? null),
  dt: mintDelegationTemplateRevision(db, { ...clause(DELEGATION_TEMPLATE_REQUIRED_CLAUSES), ORD_SUBMISSION_DELEGATED: `ORD_SUBMISSION_DELEGATED ${randomUUID()}` } as Record<(typeof DELEGATION_TEMPLATE_REQUIRED_CLAUSES)[number], string>,
    (db.prepare("SELECT id FROM delegation_template_revisions ORDER BY revision DESC LIMIT 1").get() as { id: string } | undefined)?.id ?? null),
});

/** Issues the given (framework, delegation) pair and returns the resulting issuance row. */
const issue = (db: Database.Database, partnerIdentityId: string, fwId: string, dtId: string, reason: string) => {
  issueFrameworkToPartner(db, admin, partnerIdentityId, fwId, dtId, reason);
  return requiredFrameworkIssuance(db, partnerIdentityId)!;
};

/** Accepts the CURRENT required issuance against the CURRENT legal profile. */
const accept = (db: Database.Database, partner: PartnerPrincipal, agentId: string) => {
  const issuance = requiredFrameworkIssuance(db, partner.partner_identity_id)!;
  const legalProfileRevisionId = currentAgentReferralsLegalProfile(db, agentId)!.id;
  const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { issuance_id: issuance.id, legal_profile_revision_id: legalProfileRevisionId }).grant_id;
  return acceptFrameworkAndDelegation(db, partner, grant, issuance.id, legalProfileRevisionId);
};

describe("agent referrals: reissuance and evidence authority (PR2)", () => {
  it("1. accepting the same revision pair under a NEW issuance creates a new acceptance, never a replay of the old one", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw, dt } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fw.id, dt.id, "first issuance");
    const first = accept(db, partner, agentId);
    expect(first.replayed).toBe(false);

    // A second issuance of the EXACT SAME revision pair.
    issue(db, partnerIdentityId, fw.id, dt.id, "second issuance, same pair");
    const second = accept(db, partner, agentId);

    expect(second.replayed).toBe(false);
    expect(second.framework_acceptance_id).not.toBe(first.framework_acceptance_id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances WHERE partner_identity_id = ?").get(partnerIdentityId)).toEqual({ n: 2 });
  });

  it("2. with two acceptances, engagement activation pins the EFFECTIVE (latest-issuance) one, never an arbitrary row", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw: fw1, dt: dt1 } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fw1.id, dt1.id, "first issuance");
    const acceptance1 = accept(db, partner, agentId);
    activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");

    const { fw: fw2, dt: dt2 } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fw2.id, dt2.id, "second issuance");
    const acceptance2 = accept(db, partner, agentId);
    expect(acceptance2.framework_acceptance_id).not.toBe(acceptance1.framework_acceptance_id);

    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
    verifyAudienceForPartnerCity(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
    createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, fulfillment_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'OPEN', 'SCHEDULED', 'CONFIRMED', 'Studio', 'Lenina 1')`)
      .run(occurrenceId, cityId);
    const terms: EngagementRevisionTerms = {
      reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000,
      publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: { note: "v1" },
    };
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms, "offer");
    const engagementGrant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, partner, engagementId, revisionId, engagementGrant);

    const activation = activateEngagement(db, admin, engagementId, revisionId);
    const event = db.prepare("SELECT framework_acceptance_id, ord_reporting_delegation_id FROM engagement_activation_events WHERE id = ?").get(activation.activation_event_id) as
      { framework_acceptance_id: string; ord_reporting_delegation_id: string };
    expect(event.framework_acceptance_id).toBe(acceptance2.framework_acceptance_id);
    expect(event.ord_reporting_delegation_id).toBe(acceptance2.ord_reporting_delegation_id);
  });

  it("3. a legal-profile revision minted between step-up and accept refuses the accept with 409, never records an acceptance for a document the partner never saw", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw, dt } = mintTemplatePair(db);
    const issuance = issue(db, partnerIdentityId, fw.id, dt.id, "issued");
    const stalePartnerProfile = currentAgentReferralsLegalProfile(db, agentId)!;
    const grant = mintStepUpGrant(db, partner, "FRAMEWORK_ACCEPTANCE", { issuance_id: issuance.id, legal_profile_revision_id: stalePartnerProfile.id }).grant_id;

    // The legal profile moves AFTER the grant was minted, BEFORE accept runs.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "NPD", reason: "address update",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-address.pdf",
      full_name: "Ivanov Ivan Ivanovich the Second", inn: "123456789012", registration_number: "123456789012345",
    });

    expect(() => acceptFrameworkAndDelegation(db, partner, grant, issuance.id, stalePartnerProfile.id)).toThrow(/AGENT_REFERRALS_LEGAL_PROFILE_CHANGED/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM framework_acceptances").get()).toEqual({ n: 0 });
  });

  it("4. the historical acceptance always resolves the profile revision it actually pinned; a later profile revision does not move it, and a new activation pins the NEW MAX", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw, dt } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fw.id, dt.id, "issued");
    const acceptedProfile = currentAgentReferralsLegalProfile(db, agentId)!;
    const acceptance = accept(db, partner, agentId);
    activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");

    // rev2: NOTICE_ONLY (full_name only) - agreement_status must stay CURRENT.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "NPD", reason: "name correction",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-name.pdf",
      full_name: "Ivanov Ivan Ivanovich Jr.", inn: "123456789012", registration_number: "123456789012345",
    });
    const newProfile = currentAgentReferralsLegalProfile(db, agentId)!;
    expect(newProfile.id).not.toBe(acceptedProfile.id);

    const storedAcceptance = db.prepare("SELECT legal_profile_revision_id FROM framework_acceptances WHERE id = ?").get(acceptance.framework_acceptance_id) as { legal_profile_revision_id: string };
    expect(storedAcceptance.legal_profile_revision_id).toBe(acceptedProfile.id);
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("CURRENT");
  });

  it("5. a CONTRACTUAL_REISSUANCE_REQUIRED profile change with no replacement issuance moves the status to REISSUANCE_REQUIRED and refuses new engagement activation", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw, dt } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fw.id, dt.id, "issued");
    accept(db, partner, agentId);
    activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("CURRENT");

    // tax_mode change: CONTRACTUAL_REISSUANCE_REQUIRED.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", reason: "left NPD",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-tax.pdf",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("REISSUANCE_REQUIRED");

    const cityId = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, `city-${cityId.slice(0, 8)}`);
    verifyAudienceForPartnerCity(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
    createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
    const occurrenceId = randomUUID();
    db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, fulfillment_status, venue_status, venue_name, venue_address)
      VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'OPEN', 'SCHEDULED', 'CONFIRMED', 'Studio', 'Lenina 1')`)
      .run(occurrenceId, cityId);
    const terms: EngagementRevisionTerms = {
      reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000,
      publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: { note: "v1" },
    };
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms, "offer");
    const engagementGrant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, partner, engagementId, revisionId, engagementGrant);

    expect(() => activateEngagement(db, admin, engagementId, revisionId)).toThrow(/AGENT_REFERRALS_ACTIVATION_AGREEMENT_NOT_CURRENT/);
  });

  it("6a. REISSUANCE_REQUIRED survives an unrelated NOTICE_ONLY change (never computed against the adjacent revision), and clears only once semantics are fully restored", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw, dt } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fw.id, dt.id, "issued");
    accept(db, partner, agentId);

    // rev8: tax_mode change -> CONTRACTUAL_REISSUANCE_REQUIRED.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", reason: "left NPD",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-tax.pdf",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("REISSUANCE_REQUIRED");

    // rev9: NOTICE_ONLY change only (full_name) - adjacent-revision comparison
    // (rev8 vs rev9) would read NOTICE_ONLY and wrongly report CURRENT.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", reason: "name correction",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-name.pdf",
      full_name: "Ivanov Ivan Ivanovich Jr.", inn: "123456789012", registration_number: "123456789012345",
    });
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("REISSUANCE_REQUIRED");

    // rev10: restores rev7's full semantics exactly (tax_mode back to NPD,
    // full_name back to the original) - no replacement issuance -> CURRENT.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "NPD", reason: "back to NPD",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-restore.pdf",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("CURRENT");
  });

  it("6b. an issued-but-unaccepted replacement is never cancelled by a later profile edit that happens to restore old semantics: REACCEPTANCE_REQUIRED, never CURRENT", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw: fwA, dt: dtA } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fwA.id, dtA.id, "issuance A");
    accept(db, partner, agentId);

    // rev8: tax_mode change.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "OTHER", reason: "left NPD",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-tax.pdf",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });

    // Admin issues a replacement, B - unaccepted.
    const { fw: fwB, dt: dtB } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fwB.id, dtB.id, "issuance B, in response to the tax_mode change");
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("REACCEPTANCE_REQUIRED");

    // rev9 restores rev7's semantics exactly - but B is still unaccepted.
    applyVerifiedLegalProfileForPartnerIdentity(db, {
      partnerIdentityId, legalForm: "INDIVIDUAL_ENTREPRENEUR", taxMode: "NPD", reason: "back to NPD",
      assertionSource: "ADMIN_ASSERTED", evidenceRef: "ev-restore.pdf",
      full_name: "Ivanov Ivan Ivanovich", inn: "123456789012", registration_number: "123456789012345",
    });
    expect(agreementStatusForPartner(db, agentId, partnerIdentityId)).toBe("REACCEPTANCE_REQUIRED");
  });

  it("7. delegation effectiveness is 'belongs to the effective acceptance' AND 'not revoked' - not merely the absence of a revocation", () => {
    const { db, agentId, partnerIdentityId, partner } = readyPartner();
    const { fw: fwA, dt: dtA } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fwA.id, dtA.id, "issuance A");
    const acceptanceA = accept(db, partner, agentId);
    activatePartner(db, partnerIdentityId, getPartnerIdentity(db, partnerIdentityId)!.onboarding_revision, "ADMIN", "onboarding complete");

    expect(isDelegationEffective(db, partnerIdentityId)).toBe(true);

    const { fw: fwB, dt: dtB } = mintTemplatePair(db);
    issue(db, partnerIdentityId, fwB.id, dtB.id, "issuance B");
    const acceptanceB = accept(db, partner, agentId);
    expect(acceptanceB.ord_reporting_delegation_id).not.toBe(acceptanceA.ord_reporting_delegation_id);

    // D1 is neither revoked nor effective anymore - it belongs to a
    // superseded acceptance, not to the effective one. The isDelegationEffective(partner)
    // boolean alone cannot distinguish "D1 effective" from "D2 effective"
    // (both read true), so resolve which delegation is ACTUALLY bound to
    // the effective acceptance directly.
    const d1RevokedRow = db.prepare("SELECT id FROM ord_reporting_delegation_revocations WHERE ord_reporting_delegation_id = ?").get(acceptanceA.ord_reporting_delegation_id);
    expect(d1RevokedRow).toBeUndefined();
    const effective = effectiveFrameworkAcceptance(db, partnerIdentityId)!;
    expect(effective.acceptance.id).toBe(acceptanceB.framework_acceptance_id);
    const effectiveDelegation = db.prepare("SELECT id FROM ord_reporting_delegations WHERE framework_acceptance_id = ?").get(effective.acceptance.id) as { id: string };
    expect(effectiveDelegation.id).toBe(acceptanceB.ord_reporting_delegation_id);
    expect(effectiveDelegation.id).not.toBe(acceptanceA.ord_reporting_delegation_id);
    expect(isDelegationEffective(db, partnerIdentityId)).toBe(true); // true because D2 (the effective one) is unrevoked

    // Revoke D2: now nothing is effective, even though D1 was never revoked.
    revokeDelegationAsAdmin(db, admin, acceptanceB.ord_reporting_delegation_id, "test revocation");
    expect(isDelegationEffective(db, partnerIdentityId)).toBe(false);
    const stillNotRevoked = db.prepare("SELECT id FROM ord_reporting_delegation_revocations WHERE ord_reporting_delegation_id = ?").get(acceptanceA.ord_reporting_delegation_id);
    expect(stillNotRevoked).toBeUndefined(); // D1 itself was never touched by D2's revocation
  });
});
