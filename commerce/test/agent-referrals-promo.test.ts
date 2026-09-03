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
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, verifyAudienceForPartnerCity, acceptEngagement, activateEngagement, mintEngagementRevision, suspendEngagement, reactivateEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import * as promoModule from "../src/agent-referrals-promo";
import {
  AgentReferralsPromoError,
  createPartnerPromo,
  currentEngagementPromoAuthorization,
  currentEngagementPromoAuthorizationForEngagement,
  isPromoPartnerOwned,
} from "../src/agent-referrals-promo";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-promo-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const seedAgent = (db: Database.Database, agentId = randomUUID()) => {
  db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
    VALUES (?, ?, 'A', 'A Legal', ?, 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId, `s-${agentId.slice(0, 8)}`, `${agentId.slice(0, 8)}@example.test`);
  return agentId;
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

/**
 * A partner at PARTNER_ACTIVE with its permanent promo and a verified
 * city, through the real production onboarding path - the per-occurrence
 * authorization tests below exercise mint/supersede/revoke ONLY through
 * activateEngagement/suspendEngagement/reactivateEngagement, never a raw
 * "mint" primitive (Phase 5 holistic review, P0 finding 3): promo.ts
 * exports no function capable of minting a new authorization at any
 * visibility level, since a bare mint primitive is itself unearned
 * publication authority - see that module's own header.
 */
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

const seedOccurrenceInCity = (db: Database.Database, cityId: string) => {
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'X', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', 'CONFIRMED', 'S', 'A')`).run(occurrenceId, cityId);
  return occurrenceId;
};

const terms1: EngagementRevisionTerms = {
  reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: {},
};

const offerAcceptActivate = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  const activation = activateEngagement(db, admin, engagementId, revisionId);
  return { engagementId, revisionId, activation };
};

describe("one permanent promo per partner (§B-9)", () => {
  it("mints the underlying promo_codes row with frozen NONE/0 placeholders", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    const row = db.prepare("SELECT discount_type, discount_value, status FROM promo_codes WHERE id = ?").get(promo.promo_code_id);
    expect(row).toEqual({ discount_type: "NONE", discount_value: 0, status: "ACTIVE" });
    expect(isPromoPartnerOwned(db, promo.promo_code_id)).toBe(true);
  });

  it("reuses the legacy admin promo-code grammar - lowercase is normalized, and an invalid code is refused before any row is written", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: "art-lower", reason: "mint" });
    const row = db.prepare("SELECT code, normalized_code FROM promo_codes WHERE id = ?").get(promo.promo_code_id);
    expect(row).toEqual({ code: "ART-LOWER", normalized_code: "ART-LOWER" });

    const agentId2 = seedAgent(db, randomUUID());
    const before = db.prepare("SELECT COUNT(*) AS n FROM promo_codes").get() as { n: number };
    expect(() => createPartnerPromo(db, admin, { partner_id: agentId2, code: "a", reason: "too short" })).toThrow(); // fails promoCodeSchema's ^[A-Z0-9_-]{2,64}$
    expect(() => createPartnerPromo(db, admin, { partner_id: agentId2, code: "has a space", reason: "invalid chars" })).toThrow();
    const after = db.prepare("SELECT COUNT(*) AS n FROM promo_codes").get() as { n: number };
    expect(after.n).toBe(before.n); // no partial row from a rejected code
  });

  it("one partner cannot mint a second promo (UNIQUE(partner_id))", () => {
    const db = fresh();
    const agentId = seedAgent(db);
    createPartnerPromo(db, admin, { partner_id: agentId, code: "ART", reason: "mint" });
    expect(() => createPartnerPromo(db, admin, { partner_id: agentId, code: "ART2", reason: "mint 2" })).toThrow();
  });

  it("a promo code, once bound, cannot be reassigned to a second partner (UNIQUE(promo_code_id) via the underlying normalized_code UNIQUE too)", () => {
    const db = fresh();
    const agentA = seedAgent(db, randomUUID());
    const agentB = seedAgent(db, randomUUID());
    createPartnerPromo(db, admin, { partner_id: agentA, code: "ART", reason: "mint" });
    expect(() => createPartnerPromo(db, admin, { partner_id: agentB, code: "ART", reason: "mint dup" })).toThrow();
  });
});

describe("per-occurrence promo authorization: no bare UNIQUE(promo_code_id), at most one CURRENT per (promo, occurrence) - minted only via the real activateEngagement path, never a standalone mint primitive", () => {
  it("the SAME promo authorizes THREE different occurrences simultaneously - one partner advertising three cities holds one code", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ1 = seedOccurrenceInCity(db, p1.cityId);
    const occ2 = seedOccurrenceInCity(db, p1.cityId);
    const occ3 = seedOccurrenceInCity(db, p1.cityId);
    const e1 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ1);
    const e2 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ2);
    const e3 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ3);

    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ1)!.id).toBe(e1.activation.promo_authorization_id);
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ2)!.id).toBe(e2.activation.promo_authorization_id);
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ3)!.id).toBe(e3.activation.promo_authorization_id);

    // Suspending one occurrence's engagement must not touch the other two.
    suspendEngagement(db, admin, e2.engagementId, "manual pause");
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ1)).not.toBeNull();
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ2)).toBeNull();
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ3)).not.toBeNull();
  });

  it("activating a new material revision for the SAME engagement supersedes its own current authorization - history is never rewritten", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrenceInCity(db, p1.cityId);
    const e = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    const a1Id = e.activation.promo_authorization_id;

    const revision2 = mintEngagementRevision(db, admin, e.engagementId, { ...terms1, customer_discount_value: 1500 }, "material change");
    const grant2 = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: e.engagementId, engagement_revision_id: revision2.id }).grant_id;
    acceptEngagement(db, p1.partner, e.engagementId, revision2.id, grant2);
    const activation2 = activateEngagement(db, admin, e.engagementId, revision2.id);

    expect(activation2.promo_authorization_id).not.toBe(a1Id);
    const a1Row = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(a1Id) as { revoked_at: string | null };
    expect(a1Row.revoked_at).not.toBeNull();
    const a2Row = db.prepare("SELECT supersedes_authorization_id FROM engagement_promo_authorizations WHERE id = ?").get(activation2.promo_authorization_id) as { supersedes_authorization_id: string | null };
    expect(a2Row.supersedes_authorization_id).toBe(a1Id);
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ)!.id).toBe(activation2.promo_authorization_id);
    expect(currentEngagementPromoAuthorizationForEngagement(db, e.engagementId)!.id).toBe(activation2.promo_authorization_id);
  });

  it("reactivating after a suspension (whose own revoke already cleared the current row) mints a fresh authorization, never a broken supersession of an already-dead row", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrenceInCity(db, p1.cityId);
    const e = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    const a1Id = e.activation.promo_authorization_id;

    suspendEngagement(db, admin, e.engagementId, "pause");
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ)).toBeNull(); // nothing live between suspend and reactivate

    const reactivation = reactivateEngagement(db, admin, e.engagementId, e.revisionId);
    expect(reactivation.promo_authorization_id).not.toBe(a1Id);
    const freshRow = db.prepare("SELECT supersedes_authorization_id FROM engagement_promo_authorizations WHERE id = ?").get(reactivation.promo_authorization_id) as { supersedes_authorization_id: string | null };
    expect(freshRow.supersedes_authorization_id).toBeNull(); // a1 was already revoked by suspend, not "superseded" by this fresh mint
    expect(currentEngagementPromoAuthorization(db, p1.promo.promo_code_id, occ)!.id).toBe(reactivation.promo_authorization_id);
  });
});

describe("AgentReferralsPromoError export", () => {
  it("is thrown as the module's own error class", () => {
    expect(new AgentReferralsPromoError("X").code).toBe("X");
  });
});

describe("structural authority bypass surface (Phase 5 holistic review, P0 finding 3): this module exports no function capable of MINTING a promo authorization", () => {
  it("has no mint primitive at any visibility level - only read accessors and the revoke primitive", () => {
    expect(promoModule).not.toHaveProperty("mintEngagementPromoAuthorization");
    expect(promoModule).not.toHaveProperty("mintEngagementPromoAuthorizationInTransaction");
    expect(promoModule).toHaveProperty("revokeEngagementPromoAuthorizationInTransaction"); // revoking never grants unearned authority - safe to keep shared
  });
});
