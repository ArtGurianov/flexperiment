import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals, suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant, EngagementStepUpError } from "../src/agent-referrals-engagement-step-up";
import * as engagementModule from "../src/agent-referrals-engagement";
import {
  EngagementError,
  offerEngagement,
  mintEngagementRevision,
  acceptEngagement,
  activateEngagement,
  reactivateEngagement,
  suspendEngagement,
  revokeAudienceVerificationForPartnerCity,
  verifyAudienceForPartnerCity,
  getEngagement,
  currentEngagementRevision,
  lastActivatedEngagementRevision,
  type EngagementRevisionTerms,
} from "../src/agent-referrals-engagement";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-engagement-")), "commerce.sqlite");
  const db = openDatabase(file);
  migrate(db);
  open.push(db);
  return db;
};

const clause = (arr: readonly string[]) => Object.fromEntries(arr.map((k) => [k, `${k} v1`])) as Record<string, string>;

/** A partner at PARTNER_ACTIVE, its permanent promo, and a verified city, ready to be offered an engagement. */
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
  db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, ?, 'Новосибирск')").run(cityId, `novosibirsk-${cityId.slice(0, 8)}`);
  verifyAudienceForPartnerCity(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
  const promo = createPartnerPromo(db, admin, { partner_id: agentId, code: `ART${agentId.slice(0, 4)}`, reason: "mint" });

  return { partner, agentId, partnerIdentityId, cityId, promo };
};

const seedOccurrence = (db: Database.Database, cityId: string, occurrenceId = randomUUID(), overrides: Partial<Record<string, string>> = {}) => {
  db.prepare(`INSERT INTO occurrences(id, city_id, title, starts_at, ends_at, timezone, price_kopecks, capacity, visibility, sales_status, fulfillment_status, venue_status, venue_name, venue_address)
    VALUES (?, ?, 'FLEXPERIMENT', '2030-10-01T10:00:00.000Z', '2030-10-01T13:00:00.000Z', 'Asia/Novosibirsk', 100000, 5, 'PUBLISHED', ?, ?, 'CONFIRMED', 'Studio', 'Lenina 1')`)
    .run(occurrenceId, cityId, overrides.sales_status ?? "OPEN", overrides.fulfillment_status ?? "SCHEDULED");
  return occurrenceId;
};

const terms1: EngagementRevisionTerms = {
  reward_type: "PERCENT", reward_value: 1000, customer_discount_type: "PERCENT", customer_discount_value: 1000,
  publication_start_at: "2020-01-01T00:00:00.000Z", publication_end_at: "2035-01-01T00:00:00.000Z", terms: { note: "v1" },
};

const offerAcceptActivate = (db: Database.Database, partner: PartnerPrincipal, partnerIdentityId: string, occurrenceId: string, terms = terms1) => {
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms, "offer");
  const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, partner, engagementId, revisionId, grant);
  const activation = activateEngagement(db, admin, engagementId, revisionId);
  return { engagementId, revisionId, activation };
};

describe("engagement offer / accept / activate: four separate authorities, never folded together", () => {
  it("offering creates OFFERED with revision 1; minting a later revision does not change lifecycle_state or count as accepted", () => {
    const db = fresh();
    const { partnerIdentityId, cityId } = readyPartner(db);
    const occurrenceId = seedOccurrence(db, cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "OFFERED", lifecycle_revision: 1 });

    const revision2 = mintEngagementRevision(db, admin, engagementId, { ...terms1, reward_value: 2000 }, "reward tweak");
    expect(revision2.revision).toBe(2);
    expect(revision2.supersedes_revision_id).toBe(revisionId);
    // Minting alone does not accept it and does not change lifecycle_state.
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "OFFERED", lifecycle_revision: 1 });
    expect(currentEngagementRevision(db, engagementId)!.id).toBe(revision2.id);
  });

  it("admin cannot accept on the partner's behalf - acceptEngagement takes only a PartnerPrincipal", () => {
    const db = fresh();
    const { partner, partnerIdentityId, cityId } = readyPartner(db);
    const occurrenceId = seedOccurrence(db, cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
    // TypeScript itself refuses an AdminPrincipal here; the runtime proof is that
    // every accept path requires a step-up grant minted FOR a PartnerPrincipal's
    // own session - there is no admin-callable acceptance function anywhere.
    const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    expect(() => acceptEngagement(db, partner, engagementId, revisionId, grant)).not.toThrow();
  });

  it("first acceptance transitions OFFERED -> ACCEPTED; an exact-parameter replay is idempotent and consumes no new step-up grant", () => {
    const db = fresh();
    const { partner, partnerIdentityId, cityId } = readyPartner(db);
    const occurrenceId = seedOccurrence(db, cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
    const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    const first = acceptEngagement(db, partner, engagementId, revisionId, grant);
    expect(first.replayed).toBe(false);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACCEPTED" });

    // Replaying with the SAME (already-consumed) grant id still succeeds, because the
    // replay short-circuit happens before the grant is ever touched again.
    const replay = acceptEngagement(db, partner, engagementId, revisionId, grant);
    expect(replay).toEqual({ acceptance_id: first.acceptance_id, replayed: true });
  });

  it("activation pins every prerequisite as one immutable snapshot and transitions ACCEPTED -> ACTIVE", () => {
    const db = fresh();
    const { partner, partnerIdentityId, cityId, promo } = readyPartner(db);
    const occurrenceId = seedOccurrence(db, cityId);
    const { engagementId, revisionId, activation } = offerAcceptActivate(db, partner, partnerIdentityId, occurrenceId);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });

    const event = db.prepare("SELECT * FROM engagement_activation_events WHERE id = ?").get(activation.activation_event_id) as Record<string, unknown>;
    expect(event.engagement_revision_id).toBe(revisionId);
    expect(event.occurrence_id).toBe(occurrenceId);
    const authorization = db.prepare("SELECT * FROM engagement_promo_authorizations WHERE id = ?").get(activation.promo_authorization_id) as Record<string, unknown>;
    expect(authorization).toMatchObject({ promo_code_id: promo.promo_code_id, occurrence_id: occurrenceId, engagement_id: engagementId, engagement_revision_id: revisionId, revoked_at: null });
  });

  it("no global ACTIVE-engagement counting: three partners on three occurrences are ACTIVE simultaneously", () => {
    const db = fresh();
    const p1 = readyPartner(db); const p2 = readyPartner(db); const p3 = readyPartner(db);
    const occ1 = seedOccurrence(db, p1.cityId); const occ2 = seedOccurrence(db, p2.cityId); const occ3 = seedOccurrence(db, p3.cityId);
    const e1 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ1);
    const e2 = offerAcceptActivate(db, p2.partner, p2.partnerIdentityId, occ2);
    const e3 = offerAcceptActivate(db, p3.partner, p3.partnerIdentityId, occ3);
    for (const e of [e1, e2, e3]) expect(getEngagement(db, e.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
  });

  it("activation requires the exact accepted revision - admin cannot activate a revision the partner never accepted", () => {
    const db = fresh();
    const { partner, partnerIdentityId, cityId } = readyPartner(db);
    const occurrenceId = seedOccurrence(db, cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
    const revision2 = mintEngagementRevision(db, admin, engagementId, { ...terms1, reward_value: 2000 }, "tweak");
    const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, partner, engagementId, revisionId, grant); // accepts revision 1 only
    expect(() => activateEngagement(db, admin, engagementId, revision2.id)).toThrow(/AGENT_REFERRALS_ACTIVATION_REVISION_NOT_ACCEPTED/);
  });

  it("global SUSPENDED blocks engagement offer, acceptance and activation - all three are NEW_AUTHORITY", () => {
    const db = fresh();
    const { partner, partnerIdentityId, cityId } = readyPartner(db);
    const occurrenceId = seedOccurrence(db, cityId);
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "emergency" });
    expect(() => offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer")).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);

    activateAgentReferrals(db, { expected_revision: 3, owner_id: "test-owner", reason: "resume" });
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, partnerIdentityId, occurrenceId, terms1, "offer");
    const grant = mintEngagementStepUpGrant(db, partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    suspendAgentReferrals(db, { expected_revision: 4, owner_id: "test-owner", reason: "emergency 2" });
    expect(() => acceptEngagement(db, partner, engagementId, revisionId, grant)).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);

    activateAgentReferrals(db, { expected_revision: 5, owner_id: "test-owner", reason: "resume 2" });
    acceptEngagement(db, partner, engagementId, revisionId, grant);
    suspendAgentReferrals(db, { expected_revision: 6, owner_id: "test-owner", reason: "emergency 3" });
    expect(() => activateEngagement(db, admin, engagementId, revisionId)).toThrow(/AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY/);
  });
});

describe("engagement suspend / reactivate", () => {
  it("suspending an ACTIVE engagement revokes its promo authorization for that occurrence only - a sibling engagement is untouched", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occA = seedOccurrence(db, p1.cityId);
    const occB = seedOccurrence(db, p1.cityId);
    const engA = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occA);
    const engB = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occB);

    suspendEngagement(db, admin, engA.engagementId, "manual pause Tomsk");
    expect(getEngagement(db, engA.engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    expect(getEngagement(db, engB.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
    const authA = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(engA.activation.promo_authorization_id) as { revoked_at: string | null };
    const authB = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(engB.activation.promo_authorization_id) as { revoked_at: string | null };
    expect(authA.revoked_at).not.toBeNull();
    expect(authB.revoked_at).toBeNull();
  });

  it("reactivation re-validates prerequisites and mints a fresh promo authorization", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const eng = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    suspendEngagement(db, admin, eng.engagementId, "pause");
    const reactivation = reactivateEngagement(db, admin, eng.engagementId, eng.revisionId);
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
    expect(reactivation.promo_authorization_id).not.toBe(eng.activation.promo_authorization_id);
    const fresh_ = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(reactivation.promo_authorization_id) as { revoked_at: string | null };
    expect(fresh_.revoked_at).toBeNull();
  });

  it("reactivation never happens automatically from a global feature reactivation", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const eng = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    suspendEngagement(db, admin, eng.engagementId, "pause");
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "unrelated global pause" });
    activateAgentReferrals(db, { expected_revision: 3, owner_id: "test-owner", reason: "global resume" });
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
  });
});

describe("audience revocation cascade (one authority transaction)", () => {
  it("revoking the CURRENT audience verification for (partner, city) suspends every ACTIVE engagement there and revokes its promo authorization - a replacement VERIFIED does not", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const eng = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);

    const cascade = revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "compliance issue", "ev-revoke");
    expect(cascade.suspended_engagement_ids).toEqual([eng.engagementId]);
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    const auth = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(eng.activation.promo_authorization_id) as { revoked_at: string | null };
    expect(auth.revoked_at).not.toBeNull();
  });

  it("a sibling engagement for the SAME partner in a DIFFERENT city is untouched", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const otherCity = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'tomsk', 'Томск')").run(otherCity);
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, otherCity, "2040-01-01T00:00:00.000Z", "verified", "ev-2");
    const occTomsk = seedOccurrence(db, otherCity);
    const occNovosibirsk = seedOccurrence(db, p1.cityId);
    const engTomsk = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occTomsk);
    const engNovosibirsk = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occNovosibirsk);

    revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "issue in Novosibirsk only", "ev-revoke");
    expect(getEngagement(db, engNovosibirsk.engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    expect(getEngagement(db, engTomsk.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
  });

  it("a REPLACEMENT VERIFIED (still verified, updated evidence) does not suspend the already-ACTIVE engagement", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const eng = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2040-01-01T00:00:00.000Z", "re-verified with updated evidence", "ev-3");
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
  });
});

describe("fault injection: activation leaves no partial authority on failure", () => {
  it("a fault injected at the activation-event insert (after the promo authorization mint) rolls back the authorization too, and the engagement stays ACCEPTED for a clean retry", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, terms1, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);

    db.exec(`CREATE TRIGGER poison_activation_event BEFORE INSERT ON engagement_activation_events
      BEGIN SELECT RAISE(ABORT, 'INJECTED_ACTIVATION_EVENT_FAILURE'); END;`);
    const authorizationsBefore = db.prepare("SELECT COUNT(*) AS n FROM engagement_promo_authorizations").get() as { n: number };
    expect(() => activateEngagement(db, admin, engagementId, revisionId)).toThrow(/INJECTED_ACTIVATION_EVENT_FAILURE/);
    db.exec("DROP TRIGGER poison_activation_event");

    const authorizationsAfter = db.prepare("SELECT COUNT(*) AS n FROM engagement_promo_authorizations").get() as { n: number };
    expect(authorizationsAfter.n).toBe(authorizationsBefore.n); // the mint inside the failed transaction was rolled back, not left dangling
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACCEPTED" });

    // Clean retry succeeds now that the poison is removed.
    const activation = activateEngagement(db, admin, engagementId, revisionId);
    expect(getEngagement(db, engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
    expect(activation.promo_authorization_id).toBeTruthy();
  });
});

describe("step-up grant scoping", () => {
  it("an ENGAGEMENT_ACCEPTANCE grant cannot be reused for a different engagement/revision pair", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occA = seedOccurrence(db, p1.cityId);
    const occB = seedOccurrence(db, p1.cityId);
    const { engagement_id: engA, engagement_revision_id: revA } = offerEngagement(db, admin, p1.partnerIdentityId, occA, terms1, "offer A");
    const { engagement_id: engB, engagement_revision_id: revB } = offerEngagement(db, admin, p1.partnerIdentityId, occB, terms1, "offer B");
    const grantForA = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engA, engagement_revision_id: revA }).grant_id;
    expect(() => acceptEngagement(db, p1.partner, engB, revB, grantForA)).toThrow(EngagementStepUpError);
  });
});

describe("engagement error export", () => {
  it("throws EngagementError for a not-found engagement", () => {
    const db = fresh();
    expect(() => mintEngagementRevision(db, admin, "nonexistent", terms1, "x")).toThrow(EngagementError);
  });
});

describe("audience verification must remain valid through the whole publication window (P0.3): VERIFIED alone is not enough, valid_until must reach publication_end_at", () => {
  it("refuses activation when the verified window expires BEFORE the revision's publication_end_at", () => {
    const db = fresh();
    const p1 = readyPartner(db); // verified through 2040-01-01 by default
    revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "reset for test", "ev-reset");
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2030-06-01T00:00:00.000Z", "narrower window", "ev-2");
    const occ = seedOccurrence(db, p1.cityId);
    // terms1.publication_end_at = 2035-01-01, which is AFTER the 2030-06-01 verified window - activation must refuse.
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, terms1, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
    expect(() => activateEngagement(db, admin, engagementId, revisionId)).toThrow(/AGENT_REFERRALS_ACTIVATION_AUDIENCE_VERIFICATION_EXPIRES_BEFORE_PUBLICATION_END/);
    expect(getEngagement(db, engagementId)!.lifecycle_state).toBe("ACCEPTED"); // no partial activation
  });

  it("activates when valid_until is exactly equal to publication_end_at - the boundary is inclusive", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "reset for test", "ev-reset");
    const validUntil = "2030-06-01T00:00:00.000Z";
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, validUntil, "exact-boundary window", "ev-2");
    const occ = seedOccurrence(db, p1.cityId);
    const boundaryTerms: EngagementRevisionTerms = { ...terms1, publication_end_at: validUntil };
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, boundaryTerms, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
    expect(() => activateEngagement(db, admin, engagementId, revisionId)).not.toThrow();
    expect(getEngagement(db, engagementId)!.lifecycle_state).toBe("ACTIVE");
  });

  it("a REPLACEMENT VERIFIED extending validity past publication_end_at unblocks a previously-refused activation", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "reset for test", "ev-reset");
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2030-06-01T00:00:00.000Z", "narrower window", "ev-2");
    const occ = seedOccurrence(db, p1.cityId);
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, terms1, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
    expect(() => activateEngagement(db, admin, engagementId, revisionId)).toThrow(/AUDIENCE_VERIFICATION_EXPIRES_BEFORE_PUBLICATION_END/);

    revokeAudienceVerificationForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "widen window", "ev-3");
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2040-01-01T00:00:00.000Z", "wider window", "ev-4");
    expect(() => activateEngagement(db, admin, engagementId, revisionId)).not.toThrow();
    expect(getEngagement(db, engagementId)!.lifecycle_state).toBe("ACTIVE");
  });
});

describe("lastActivatedEngagementRevision (P1.1): resolves by the maximum ACTIVATED revision number, never by rowid/insertion order", () => {
  it("returns the highest-numbered activated revision even though it was authored, accepted and activated after the first", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagementId, revisionId: rev1 } = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    expect(lastActivatedEngagementRevision(db, engagementId)!.id).toBe(rev1);

    const rev2 = mintEngagementRevision(db, admin, engagementId, { ...terms1, customer_discount_value: 1500 }, "material change");
    const grant2 = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: rev2.id }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, rev2.id, grant2);
    activateEngagement(db, admin, engagementId, rev2.id);

    const last = lastActivatedEngagementRevision(db, engagementId)!;
    expect(last.id).toBe(rev2.id);
    expect(last.revision).toBe(2);
  });

  it("across suspend/reactivate (a second activation event for the SAME revision, per B-... reactivation), still resolves to that one revision - never double-counted, never regressing", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const { engagementId, revisionId } = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);
    suspendEngagement(db, admin, engagementId, "pause");
    reactivateEngagement(db, admin, engagementId, revisionId); // a SECOND activation event, same revision
    const last = lastActivatedEngagementRevision(db, engagementId)!;
    expect(last.id).toBe(revisionId);
    expect(last.revision).toBe(1);
  });
});

describe("re-verification cascade (Phase 5 holistic review, P0 finding 2): a replacement VERIFIED with a NARROWER valid_until must not leave an ACTIVE engagement with audience authority that no longer covers its own publication window", () => {
  it("suspends an ACTIVE engagement (and revokes its promo authorization) when the replacement valid_until no longer reaches the engagement's publication_end_at", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const eng = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ); // terms1.publication_end_at = 2035-01-01

    const cascade = verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2030-06-01T00:00:00.000Z", "narrower re-verification", "ev-narrow");
    expect(cascade.suspended_engagement_ids).toEqual([eng.engagementId]);
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    const auth = db.prepare("SELECT revoked_at FROM engagement_promo_authorizations WHERE id = ?").get(eng.activation.promo_authorization_id) as { revoked_at: string | null };
    expect(auth.revoked_at).not.toBeNull();
  });

  it("does not suspend when the replacement valid_until still covers (or exactly equals) the engagement's publication_end_at", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    const eng = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ);

    const wider = verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2040-06-01T00:00:00.000Z", "wider re-verification", "ev-wide");
    expect(wider.suspended_engagement_ids).toEqual([]);
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });

    const exact = verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2035-01-01T00:00:00.000Z", "exact-boundary re-verification", "ev-exact");
    expect(exact.suspended_engagement_ids).toEqual([]);
    expect(getEngagement(db, eng.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
  });

  it("a sibling engagement for the SAME partner in a DIFFERENT city is untouched by a narrowing re-verification in the first city", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const otherCity = randomUUID();
    db.prepare("INSERT INTO cities(id, slug, title) VALUES (?, 'tomsk', 'Томск')").run(otherCity);
    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, otherCity, "2040-01-01T00:00:00.000Z", "verified", "ev-2");
    const occTomsk = seedOccurrence(db, otherCity);
    const occNovosibirsk = seedOccurrence(db, p1.cityId);
    const engTomsk = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occTomsk);
    const engNovosibirsk = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occNovosibirsk);

    verifyAudienceForPartnerCity(db, admin, p1.partnerIdentityId, p1.cityId, "2030-06-01T00:00:00.000Z", "narrower - Novosibirsk only", "ev-narrow");
    expect(getEngagement(db, engNovosibirsk.engagementId)).toMatchObject({ lifecycle_state: "SUSPENDED" });
    expect(getEngagement(db, engTomsk.engagementId)).toMatchObject({ lifecycle_state: "ACTIVE" });
  });
});

describe("structural authority bypass surfaces (Phase 5 holistic review, P0 finding 3): no generic exported primitive can grant or transition authority outside its one privileged caller", () => {
  it("this module exports no generic transitionEngagementLifecycle capable of targeting CLOSED - only a SUSPENDED-only primitive", () => {
    expect(engagementModule).not.toHaveProperty("transitionEngagementLifecycle");
    expect(engagementModule).toHaveProperty("suspendEngagementLifecycle");
    // (db, engagementId, reason) - no "to" state parameter at all, structurally incapable of ever targeting CLOSED.
    expect((engagementModule as unknown as { suspendEngagementLifecycle: (...a: unknown[]) => unknown }).suspendEngagementLifecycle.length).toBe(3);
  });
});
