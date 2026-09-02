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
import { verifyAudience } from "../src/agent-referrals-audience-verification";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, acceptEngagement, activateEngagement, suspendEngagement, mintEngagementRevision, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { mintCreativeRevision, authorizeCreative } from "../src/agent-referrals-creative";
import { revokeDelegationAsAdmin } from "../src/agent-referrals-delegation-revocation";
import { assessCreativeReadyToPublish, CreativeReadinessError } from "../src/agent-referrals-creative-readiness";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-readiness-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

const readyPartner = (db: Database.Database, citySlug = `novosibirsk-${randomUUID().slice(0, 8)}`) => {
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
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'City')").run(cityId, citySlug);
  verifyAudience(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  return { partner, agentId, partnerIdentityId, cityId, citySlug, promo, delegationId: (db.prepare("SELECT id FROM ord_reporting_delegations WHERE partner_identity_id = ?").get(partnerIdentityId) as { id: string }).id };
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

const activateAndAuthorizeCreative = (db: Database.Database, p1: ReturnType<typeof readyPartner>, occurrenceId: string, targetUrl: string) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occurrenceId, terms1, "offer");
  const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  const creative = mintCreativeRevision(db, admin, engagementId, {
    format_kind: "post", media_ref: null, copy_text: "Buy now", cta_text: "Click", mandatory_labeling_text: "Реклама", creative_target_url: targetUrl,
  });
  authorizeCreative(db, admin, engagementId, creative.id);
  return engagementId;
};

describe("CREATIVE_READY_TO_PUBLISH, local half (§B-5e)", () => {
  it("takes only an engagement id - there is structurally no options object to smuggle channel_id or distribution_resource_url into", () => {
    expect(assessCreativeReadyToPublish.length).toBe(2); // (db, engagementId) - no third parameter of any kind
  });

  it("fails closed with PUBLICATION_PROVIDER_PREFLIGHT_UNAVAILABLE once every local prerequisite holds - it never reports success", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const canonicalUrl = `https://flexperiment.ru/${p1.citySlug}?promo=${(db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string }).code}`;
    const engagementId = activateAndAuthorizeCreative(db, p1, occ, canonicalUrl);
    expect(() => assessCreativeReadyToPublish(db, engagementId)).toThrow(CreativeReadinessError);
    try {
      assessCreativeReadyToPublish(db, engagementId);
    } catch (error) {
      expect((error as CreativeReadinessError).code).toBe("PUBLICATION_PROVIDER_PREFLIGHT_UNAVAILABLE");
      expect((error as CreativeReadinessError).status).toBe(503);
    }
  });

  it("refuses first on a real local defect: engagement not ACTIVE (e.g. SUSPENDED)", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const canonicalUrl = `https://flexperiment.ru/${p1.citySlug}?promo=${(db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string }).code}`;
    const engagementId = activateAndAuthorizeCreative(db, p1, occ, canonicalUrl);
    suspendEngagement(db, admin, engagementId, "pause");
    expect(() => assessCreativeReadyToPublish(db, engagementId)).toThrow(/AGENT_REFERRALS_READINESS_ENGAGEMENT_NOT_ACTIVE/);
  });

  it("refuses when the delegation is no longer effective", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const canonicalUrl = `https://flexperiment.ru/${p1.citySlug}?promo=${(db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string }).code}`;
    const engagementId = activateAndAuthorizeCreative(db, p1, occ, canonicalUrl);
    revokeDelegationAsAdmin(db, admin, p1.delegationId, "compliance"); // this also suspends the engagement
    expect(() => assessCreativeReadyToPublish(db, engagementId)).toThrow(/AGENT_REFERRALS_READINESS_ENGAGEMENT_NOT_ACTIVE|AGENT_REFERRALS_READINESS_DELEGATION_NOT_EFFECTIVE/);
  });

  it("refuses when creative_target_url does not exactly match the canonical Flexperiment target URL", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activateAndAuthorizeCreative(db, p1, occ, "https://flexperiment.ru/wrong-city?promo=WRONG");
    expect(() => assessCreativeReadyToPublish(db, engagementId)).toThrow(/AGENT_REFERRALS_READINESS_CREATIVE_TARGET_URL_MISMATCH/);
  });

  it("refuses when there is no current creative authorization at all", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, terms1, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
    activateEngagement(db, admin, engagementId, revisionId);
    expect(() => assessCreativeReadyToPublish(db, engagementId)).toThrow(/AGENT_REFERRALS_READINESS_CREATIVE_AUTHORIZATION_MISSING/);
  });

  it("refuses for an unknown engagement id", () => {
    const db = fresh();
    expect(() => assessCreativeReadyToPublish(db, "nonexistent")).toThrow(/AGENT_REFERRALS_ENGAGEMENT_NOT_FOUND/);
  });

  it("a simple admin DRAFT (minted, never accepted or activated) does not break publication readiness for the still-live activated revision (Phase 5 review note 7)", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const canonicalUrl = `https://flexperiment.ru/${p1.citySlug}?promo=${(db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string }).code}`;
    const engagementId = activateAndAuthorizeCreative(db, p1, occ, canonicalUrl);

    // Admin mints a draft R2 with a totally different (not-yet-open) publication window - never accepted, never activated.
    mintEngagementRevision(db, admin, engagementId, { ...terms1, publication_start_at: "2040-01-01T00:00:00.000Z", publication_end_at: "2041-01-01T00:00:00.000Z" }, "draft for a future campaign");

    // Readiness still resolves against the ACTIVATED revision (R1), not the draft - still fails closed on the provider half only, exactly as before the draft existed.
    try {
      assessCreativeReadyToPublish(db, engagementId);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as CreativeReadinessError).code).toBe("PUBLICATION_PROVIDER_PREFLIGHT_UNAVAILABLE");
    }
  });
});
