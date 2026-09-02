import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { CommerceDomain, DomainError } from "../src/domain";
import { MockProvider } from "../src/provider";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { verifyAudience } from "../src/agent-referrals-audience-verification";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, acceptEngagement, activateEngagement, mintEngagementRevision, getEngagement, EngagementError, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const legalManifest = { documents: Object.fromEntries(["PUBLIC_OFFER", "PRIVACY_POLICY", "PD_CONSENT", "CHECKOUT_DISCLOSURE"].map((d) => [d, { document_id: d, version: "test-1", sha256: "0".repeat(64), current_url: `https://example.test/legal/${d}`, archive_url: `https://example.test/archive/${d}`, checkout_relevant: true }])) };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-checkout-promo-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  const releaseId = randomUUID();
  db.prepare("INSERT INTO legal_releases(id, version, effective_at, manifest_json, active) VALUES (?, '2026-08-20.1', datetime('now'), ?, 1)").run(releaseId, JSON.stringify(legalManifest));
  const domain = new CommerceDomain(db, new MockProvider());
  return { db, domain };
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
  verifyAudience(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });
  return { partner, agentId, partnerIdentityId, cityId, promo };
};

const seedOccurrence = (db: Database.Database, cityId: string, priceKopecks = 100_000) => {
  const occurrenceId = randomUUID();
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', ?, 5, 'PUBLISHED', 'CONFIRMED', 'Studio', 'Lenina 1')`).run(occurrenceId, cityId, priceKopecks);
  return occurrenceId;
};

const baseTerms = (discountValue: number): EngagementRevisionTerms => ({
  reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: discountValue,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: {},
});

const offerAcceptActivate = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string, discountValue: number) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, baseTerms(discountValue), "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  return engagementId;
};

const reviseAcceptActivate = (db: Database.Database, partner: PartnerPrincipal, engagementId: string, terms: EngagementRevisionTerms, reason: string) => {
  const revision = mintEngagementRevision(db, admin, engagementId, terms, reason);
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revision.id }).grant_id;
  acceptEngagement(db, partner, engagementId, revision.id, grant);
  activateEngagement(db, admin, engagementId, revision.id);
  return revision;
};

const checkoutInput = (quoteId: string, email: string) =>
  ({ quote_id: quoteId, customer_email: email, customer_adult_confirmed: true as const, participant_age_band: "ADULT", offer_accepted: true as const, pd_consent_accepted: true as const });

describe("checkout with a partner-owned promo: pricing and QUOTE_STALE resolve against the engagement revision, never the frozen promo row", () => {
  it("QUOTE_STALE regression matrix: reward-only change is NOT stale (fails closed on attribution instead), discount change IS stale", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, 1000); // R1: 10%

    // A PARTNER promo cannot yet commit an order at all (Phase 6's
    // attribution/reward authority does not exist in PR5) - but pricing and
    // staleness detection must both still be correct, proven by the DISTINCT
    // refusal codes below.
    const quote1 = domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
    expect(quote1.discount_kopecks).toBe(10_000);
    try {
      domain.checkout(checkoutInput(quote1.quote_id, "c1@example.test"), "idem-0000000000000001");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DomainError).code).toBe("AGENT_REFERRALS_ATTRIBUTION_AUTHORITY_UNAVAILABLE");
    }

    // R1 -> R2: reward formula changes, discount stays 10% - a purely internal
    // authorization supersession must NOT read as a stale quote. It still
    // fails closed on attribution (not staleness) - proving the STALE check
    // ran first and passed.
    const quote2 = domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
    reviseAcceptActivate(db, p1.partner, engagementId, { ...baseTerms(1000), reward_type: "FIXED", reward_value: 5_000 }, "reward formula change");
    try {
      domain.checkout(checkoutInput(quote2.quote_id, "c2@example.test"), "idem-0000000000000002");
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as DomainError).code).toBe("AGENT_REFERRALS_ATTRIBUTION_AUTHORITY_UNAVAILABLE");
    }

    // R2 -> R3: discount actually changes to 15% - now it IS stale, and that
    // check fires BEFORE the attribution refusal.
    const quote3 = domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
    reviseAcceptActivate(db, p1.partner, engagementId, baseTerms(1500), "discount change");
    expect(() => domain.checkout(checkoutInput(quote3.quote_id, "c3@example.test"), "idem-0000000000000003")).toThrow(DomainError);
    try {
      domain.checkout(checkoutInput(quote3.quote_id, "c3@example.test"), "idem-0000000000000003b");
    } catch (error) {
      expect((error as DomainError).code).toBe("QUOTE_STALE");
    }
  });

  it("a promo with no current authorization for the purchased occurrence is refused, not silently downgraded to a discount-only promo", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId); // no engagement ever activated for this occurrence
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    expect(() => domain.checkoutContext({ occurrenceId: occ, promoCode: code.code })).toThrow(DomainError);
    try {
      domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
    } catch (error) {
      expect((error as DomainError).code).toBe("PROMO_NOT_ELIGIBLE");
    }
  });

  it("multiple occurrences at once: quote-time pricing is independently correct for each occurrence, and neither commits an order (pre-PR6 attribution fail-closed)", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occA = seedOccurrence(db, p1.cityId);
    const occB = seedOccurrence(db, p1.cityId);
    offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occA, 1000);
    offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occB, 2000);
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };

    const quoteA = domain.checkoutContext({ occurrenceId: occA, promoCode: code.code });
    const quoteB = domain.checkoutContext({ occurrenceId: occB, promoCode: code.code });
    expect(quoteA.discount_kopecks).toBe(10_000);
    expect(quoteB.discount_kopecks).toBe(20_000);

    for (const [quoteId, email] of [[quoteA.quote_id, "a@example.test"], [quoteB.quote_id, "b@example.test"]] as const) {
      try {
        domain.checkout(checkoutInput(quoteId, email), `idem-multi-${email}-0000001`);
        throw new Error("expected a refusal");
      } catch (error) {
        expect((error as DomainError).code).toBe("AGENT_REFERRALS_ATTRIBUTION_AUTHORITY_UNAVAILABLE");
      }
    }
  });

  it("the attribution refusal leaves no partial order/booking/payment/reward evidence - true fail-closed, not a partial commit", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, 1000);
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    const quote = domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
    expect(() => domain.checkout(checkoutInput(quote.quote_id, "nopartial@example.test"), "idem-nopartial-0000001")).toThrow(/AGENT_REFERRALS_ATTRIBUTION_AUTHORITY_UNAVAILABLE/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bookings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM payments").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM referral_rewards").get()).toEqual({ n: 0 });
  });
});

describe("legacy promo endpoint hardening: PROMO_OWNED_BY_PARTNER", () => {
  it("refuses agent_id, discount_type and discount_value mutation; permits the status toggle", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const otherAgent = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'other', 'Other', 'Other Legal', 'other@example.test', 'SELF_EMPLOYED', '123456789012', 'C-2', 'PERCENT', 500)`).run(otherAgent);

    for (const patch of [{ agent_id: otherAgent }, { discount_type: "PERCENT", discount_value: 500 }, { discount_value: 999 }]) {
      expect(() => domain.patchPromoCommand(p1.promo.promo_code_id, patch, `idem-refuse-${JSON.stringify(patch)}`, "admin-1")).toThrow(DomainError);
      try {
        domain.patchPromoCommand(p1.promo.promo_code_id, patch, `idem-refuse2-${JSON.stringify(patch)}`, "admin-1");
      } catch (error) {
        expect((error as DomainError).code).toBe("PROMO_OWNED_BY_PARTNER");
      }
    }

    const disabled = domain.patchPromoCommand(p1.promo.promo_code_id, { status: "DISABLED" }, "idem-status-1-0000001", "admin-1");
    expect(disabled.status).toBe("DISABLED");
    const reenabled = domain.patchPromoCommand(p1.promo.promo_code_id, { status: "ACTIVE" }, "idem-status-2-0000001", "admin-1");
    expect(reenabled.status).toBe("ACTIVE");
  });

  it("disabling globally refuses checkout everywhere; it is not scoped to one occurrence, and is a DIFFERENT thing from suspending one engagement", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occA = seedOccurrence(db, p1.cityId);
    const occB = seedOccurrence(db, p1.cityId);
    offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occA, 1000);
    offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occB, 1000);
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };

    domain.patchPromoCommand(p1.promo.promo_code_id, { status: "DISABLED" }, "idem-global-disable", "admin-1");
    for (const occ of [occA, occB]) {
      try {
        domain.checkoutContext({ occurrenceId: occ, promoCode: code.code });
        throw new Error("expected refusal");
      } catch (error) {
        expect((error as DomainError).code).toBe("PROMO_NOT_ELIGIBLE");
      }
    }
  });

  it("legacy discount-only promos are completely unaffected by this hardening", () => {
    const { db, domain } = fresh();
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'legacy-agent', 'Legacy', 'Legacy Legal', 'legacy@example.test', 'SELF_EMPLOYED', '123456789012', 'C-3', 'PERCENT', 500)`).run(agentId);
    const legacyPromo = domain.createPromoCommand({ code: "LEGACY10", agent_id: agentId, status: "ACTIVE", discount_type: "PERCENT", discount_value: 1000 }, "idem-legacy-create", "admin-1");
    const patched = domain.patchPromoCommand(String(legacyPromo.id), { discount_value: 1500 }, "idem-legacy-patch", "admin-1");
    expect(patched.discount_value).toBe(1500); // freely repriceable - never PROMO_OWNED_BY_PARTNER
  });
});

describe("occurrence material revision (§ Phase 5 review note 6): occurrence date/time is itself material engagement authority", () => {
  it("a real schedule change (via the legacy patchOccurrence path) suspends the already-ACTIVE engagement and revokes its promo authorization", () => {
    const { db, domain } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, 1000);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });

    domain.patchOccurrence(occ, { starts_at: "2031-05-01T10:00:00.000Z", ends_at: "2031-05-01T13:00:00.000Z", expected_revision: 1 }, "idem-occurrence-patch-0001", "admin-1");

    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    const occurrenceRow = db.prepare("SELECT material_revision FROM occurrences WHERE id = ?").get(occ) as { material_revision: number };
    expect(occurrenceRow.material_revision).toBe(2);
  });

  it("activating the OLD (pre-schedule-change) engagement revision is refused - occurrence_material_revision no longer matches", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId, engagement_revision_id: revision1Id } = offerEngagement(db, admin, p1.partnerIdentityId, occ, baseTerms(1000), "offer");
    const grant1 = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revision1Id }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revision1Id, grant1);
    activateEngagement(db, admin, engagementId, revision1Id);

    // Bump material_revision directly (equivalent to what patchOccurrence's classification would do) without going through the full legacy admin command.
    db.prepare("UPDATE occurrences SET material_revision = material_revision + 1 WHERE id = ?").run(occ);

    // A fresh revision, minted AFTER the change, pins the NEW material_revision and activates cleanly.
    const revision2 = mintEngagementRevision(db, admin, engagementId, baseTerms(1000), "re-offer after schedule change");
    expect(revision2.occurrence_material_revision).toBe(2);

    // But re-activating the OLD, stale revision (still technically "accepted") must be refused.
    expect(() => activateEngagement(db, admin, engagementId, revision1Id)).toThrow(EngagementError);
    expect(() => activateEngagement(db, admin, engagementId, revision1Id)).toThrow(/AGENT_REFERRALS_ACTIVATION_OCCURRENCE_MATERIAL_REVISION_STALE/);

    // The fresh revision activates cleanly once accepted.
    const grant2 = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revision2.id }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revision2.id, grant2);
    expect(() => activateEngagement(db, admin, engagementId, revision2.id)).not.toThrow();
  });

  it("activation never rolls back to a revision OLDER than the one currently governing the engagement", () => {
    const { db } = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, 1000); // activates revision 1
    const revision2 = mintEngagementRevision(db, admin, engagementId, baseTerms(1500), "discount increase");
    const grant2 = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revision2.id }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revision2.id, grant2);
    activateEngagement(db, admin, engagementId, revision2.id); // now revision 2 governs

    const { engagement_revision_id: revision1Id } = { engagement_revision_id: (db.prepare("SELECT id FROM engagement_revisions WHERE engagement_id = ? AND revision = 1").get(engagementId) as { id: string }).id };
    expect(() => activateEngagement(db, admin, engagementId, revision1Id)).toThrow(/AGENT_REFERRALS_ACTIVATION_CANNOT_ROLL_BACK_REVISION/);
  });
});
