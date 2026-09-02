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
import { offerEngagement, acceptEngagement, activateEngagement, mintEngagementRevision, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { CreativeError, authorizeCreative, creativeHashOf, currentCreativeAuthorization, currentCreativeRevision, mintCreativeRevision, revokeCreativeAuthorization, type CreativeMaterialFields } from "../src/agent-referrals-creative";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-creative-")), "commerce.sqlite");
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
  verifyAudience(db, admin, partnerIdentityId, cityId, "verified", "ev-1");
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

const fields = (overrides: Partial<CreativeMaterialFields> = {}): CreativeMaterialFields => ({
  format_kind: "post", media_ref: null, copy_text: "Buy now", cta_text: "Click",
  mandatory_labeling_text: "Реклама. Промо-код ART", creative_target_url: "https://flexperiment.ru/novosibirsk?promo=ART", ...overrides,
});

describe("creative: content revision vs authorization are two different things (§B-5)", () => {
  it("mints revision 1 with no engagement_revision_id/promo_authorization_id of its own", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const revision = mintCreativeRevision(db, admin, engagementId, fields());
    expect(revision.revision).toBe(1);
    expect(revision.supersedes_creative_revision_id).toBeNull();
    expect(revision.creative_hash).toBe(creativeHashOf(p1.promo.promo_code_id, fields()));
  });

  it("a reward-formula-only engagement change leaves the creative_hash and current creative revision COMPLETELY unchanged - no new revision, no new registration path implied", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const creative = mintCreativeRevision(db, admin, engagementId, fields());
    authorizeCreative(db, admin, engagementId, creative.id);

    const newRevision = mintEngagementRevision(db, admin, engagementId, { ...terms1, reward_type: "FIXED", reward_value: 5000 }, "reward formula change");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: newRevision.id }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, newRevision.id, grant);
    activateEngagement(db, admin, engagementId, newRevision.id);

    const stillCurrent = currentCreativeRevision(db, engagementId)!;
    expect(stillCurrent.id).toBe(creative.id);
    expect(stillCurrent.creative_hash).toBe(creative.creative_hash);
  });

  it("copy/media/CTA/labeling changes mint a NEW creative revision with a NEW creative_hash", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const creative1 = mintCreativeRevision(db, admin, engagementId, fields());
    const creative2 = mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "New copy entirely" }));
    expect(creative2.revision).toBe(2);
    expect(creative2.supersedes_creative_revision_id).toBe(creative1.id);
    expect(creative2.creative_hash).not.toBe(creative1.creative_hash);
  });

  it("if the discount is printed in the creative text, changing it changes the hash by construction - no special-case rule needed", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const c1 = mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "скидка 10%" }));
    const c2 = mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "скидка 15%" }));
    expect(c2.creative_hash).not.toBe(c1.creative_hash);
  });

  it("if the creative shows only the promo code (discount not printed), the discount moving in engagement terms leaves the SAME creative revision valid", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const creative = mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "Промокод ART" }));
    authorizeCreative(db, admin, engagementId, creative.id);
    const newRevision = mintEngagementRevision(db, admin, engagementId, { ...terms1, customer_discount_value: 1500 }, "discount change, not printed in creative");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: newRevision.id }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, newRevision.id, grant);
    activateEngagement(db, admin, engagementId, newRevision.id);
    expect(currentCreativeRevision(db, engagementId)!.id).toBe(creative.id); // C1 stays valid
  });
});

describe("creative authorization: canonical, at most one current, requires an ACTIVE engagement", () => {
  it("refuses to authorize before the engagement ever activates", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, terms1, "offer");
    const creative = mintCreativeRevision(db, admin, engagementId, fields());
    expect(() => authorizeCreative(db, admin, engagementId, creative.id)).toThrow(/AGENT_REFERRALS_CREATIVE_AUTHORIZATION_REQUIRES_ACTIVE_ENGAGEMENT/);
  });

  it("a superseded creative revision may not back new authorized publication", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const c1 = mintCreativeRevision(db, admin, engagementId, fields());
    mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "v2" })); // supersedes c1
    expect(() => authorizeCreative(db, admin, engagementId, c1.id)).toThrow(/AGENT_REFERRALS_CREATIVE_REVISION_SUPERSEDED/);
  });

  it("authorizing a new revision supersedes the current authorization - at most one current, ever", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const c1 = mintCreativeRevision(db, admin, engagementId, fields());
    const auth1 = authorizeCreative(db, admin, engagementId, c1.id);
    const c2 = mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "v2" }));
    const auth2 = authorizeCreative(db, admin, engagementId, c2.id);
    expect(auth2.supersedes_authorization_id).toBe(auth1.id);
    const oldRow = db.prepare("SELECT revoked_at FROM engagement_creative_authorizations WHERE id = ?").get(auth1.id) as { revoked_at: string | null };
    expect(oldRow.revoked_at).not.toBeNull();
    expect(currentCreativeAuthorization(db, engagementId)!.id).toBe(auth2.id);
  });

  it("global SUSPENDED blocks new creative authorization (NEW_PUBLICATION_AUTHORITY)", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const creative = mintCreativeRevision(db, admin, engagementId, fields());
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" });
    expect(() => authorizeCreative(db, admin, engagementId, creative.id)).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
  });

  it("explicit revocation works and refuses a second revocation of the same authorization", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const creative = mintCreativeRevision(db, admin, engagementId, fields());
    const auth = authorizeCreative(db, admin, engagementId, creative.id);
    revokeCreativeAuthorization(db, admin, auth.id, "manual revoke");
    expect(currentCreativeAuthorization(db, engagementId)).toBeNull();
    expect(() => revokeCreativeAuthorization(db, admin, auth.id, "again")).toThrow(CreativeError);
  });
});

describe("fault injection: authorization supersession is atomic", () => {
  it("a fault at the new authorization insert leaves the OLD authorization current, not revoked with nothing to replace it", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = activatedEngagement(db, p1.partner, p1.partnerIdentityId, occ);
    const c1 = mintCreativeRevision(db, admin, engagementId, fields());
    const auth1 = authorizeCreative(db, admin, engagementId, c1.id);
    const c2 = mintCreativeRevision(db, admin, engagementId, fields({ copy_text: "v2" }));

    db.exec(`CREATE TRIGGER poison_creative_authorization BEFORE INSERT ON engagement_creative_authorizations
      WHEN NEW.supersedes_authorization_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'INJECTED_AUTHORIZATION_FAILURE'); END;`);
    expect(() => authorizeCreative(db, admin, engagementId, c2.id)).toThrow(/INJECTED_AUTHORIZATION_FAILURE/);
    db.exec("DROP TRIGGER poison_creative_authorization");

    expect(currentCreativeAuthorization(db, engagementId)!.id).toBe(auth1.id); // still current, not left revoked-with-nothing
  });
});
