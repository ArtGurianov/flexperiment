import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, openDatabase } from "../src/db";
import { activateAgentReferrals, suspendAgentReferrals, reactivateAgentReferrals } from "../src/agent-referrals-feature-state";
import { provisionPartnerOwner, submitPartnerLegalProfile, verifyPartnerLegalProfile, issueFrameworkToPartner, type AdminPrincipal, type PartnerPrincipal } from "../src/agent-referrals-partner-identity";
import { activatePartner, getPartnerIdentity } from "../src/agent-referrals-onboarding";
import { mintFrameworkAgreementRevision, mintDelegationTemplateRevision, FRAMEWORK_AGREEMENT_REQUIRED_CLAUSES, DELEGATION_TEMPLATE_REQUIRED_CLAUSES } from "../src/agent-referrals-framework-delegation";
import { mintStepUpGrant } from "../src/agent-referrals-step-up";
import { acceptFrameworkAndDelegation } from "../src/agent-referrals-framework-acceptance";
import { verifyAudience } from "../src/agent-referrals-audience-verification";
import { createPartnerPromo } from "../src/agent-referrals-promo";
import { mintEngagementStepUpGrant } from "../src/agent-referrals-engagement-step-up";
import { offerEngagement, acceptEngagement, activateEngagement, mintEngagementRevision, suspendEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
import { mintCreativeRevision, authorizeCreative } from "../src/agent-referrals-creative";
import { setAgentReferralsChannelPolicy } from "../src/agent-referrals-channel-policy";
import {
  DistributionError,
  claimRemoval,
  confirmRemoval,
  correctDistribution,
  distributionEvents,
  distributionProjection,
  distributionsForEngagement,
  markOverdueRemoval,
  markReviewCleared,
  reportDistribution,
  requireRemoval,
} from "../src/agent-referrals-distribution";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });
const admin: AdminPrincipal = { realm: "ADMIN", admin_id: "admin-1" };

const fresh = () => {
  const file = join(mkdtempSync(join(tmpdir(), "agent-referrals-distribution-")), "commerce.sqlite");
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
  verifyAudience(db, admin, partnerIdentityId, cityId, "2040-01-01T00:00:00.000Z", "verified", "ev-1");
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

const readyEngagementWithCreative = (db: Database.Database) => {
  const p1 = readyPartner(db);
  const occ = seedOccurrence(db, p1.cityId);
  const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, terms1, "offer");
  const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
  acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
  activateEngagement(db, admin, engagementId, revisionId);
  const creative = mintCreativeRevision(db, admin, engagementId, {
    format_kind: "post", media_ref: null, copy_text: "Buy now", cta_text: "Click", mandatory_labeling_text: "Реклама", creative_target_url: "https://flexperiment.ru/x?promo=ART",
  });
  const authorization = authorizeCreative(db, admin, engagementId, creative.id);
  return { ...p1, engagementId, revisionId, creativeId: creative.id, authorizationId: authorization.id, occurrenceId: occ };
};

/** Mints, accepts and activates a second engagement revision (and a second creative authorized to it), superseding the first authorization. */
const supersedeAuthority = (db: Database.Database, engaged: ReturnType<typeof readyEngagementWithCreative>, overrides: Partial<EngagementRevisionTerms> = {}) => {
  const revision2 = mintEngagementRevision(db, admin, engaged.engagementId, { ...terms1, ...overrides }, "material change");
  const grant2 = mintEngagementStepUpGrant(db, engaged.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engaged.engagementId, engagement_revision_id: revision2.id }).grant_id;
  acceptEngagement(db, engaged.partner, engaged.engagementId, revision2.id, grant2);
  activateEngagement(db, admin, engaged.engagementId, revision2.id);
  const creative2 = mintCreativeRevision(db, admin, engaged.engagementId, {
    format_kind: "post", media_ref: null, copy_text: "Buy now v2", cta_text: "Click", mandatory_labeling_text: "Реклама", creative_target_url: "https://flexperiment.ru/x?promo=ART",
  });
  authorizeCreative(db, admin, engaged.engagementId, creative2.id);
  return { revisionId: revision2.id, creativeId: creative2.id };
};

const report = (db: Database.Database, partner: PartnerPrincipal, engagementId: string, overrides: Partial<Parameters<typeof reportDistribution>[3]> = {}) =>
  reportDistribution(db, partner, engagementId, {
    channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel", distribution_resource_url: "https://t.me/art_channel/1",
    published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1", ...overrides,
  });

describe("minimum actual-distribution facts: a reported distribution is ALWAYS persisted (§B-5c/§B-5e)", () => {
  it("an ALLOWED channel classifies REPORTABLE (MARKED_REPORTABLE)", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const result = report(db, p1.partner, p1.engagementId);
    expect(result.revision.channel_policy_status).toBe("ALLOWED");
    const projection = distributionProjection(db, result.distribution_id);
    expect(projection.compliance_state).toBe("MARKED_REPORTABLE");
  });

  it("a BLOCKED channel is STILL PERSISTED, classified NONCOMPLIANT/REVIEW_REQUIRED - never rejected with a 4xx that loses the fact", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    setAgentReferralsChannelPolicy(db, { channel_key: "shady_platform", status: "BLOCKED", effective_from: "2020-01-01T00:00:00.000Z", reason: "not permitted" });
    const before = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    const result = report(db, p1.partner, p1.engagementId, { channel_key: "shady_platform" });
    const after = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    expect(after.n).toBe(before.n + 1); // the fact was persisted, not rejected
    expect(result.revision.channel_policy_status).toBe("BLOCKED");
    expect(distributionProjection(db, result.distribution_id).compliance_state).toBe("REVIEW_REQUIRED");
  });

  it("an unlisted platform (no policy row at all) resolves to REVIEW_REQUIRED, and the fact is still persisted", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const result = report(db, p1.partner, p1.engagementId, { channel_key: "totally_unknown_platform" });
    expect(result.revision.channel_policy_status).toBe("REVIEW_REQUIRED");
    expect(distributionsForEngagement(db, p1.engagementId)).toHaveLength(1);
  });

  it("policy is resolved AS OF published_at, not as of the report - a later policy change does not retroactively rewrite historical classification", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    // At the time of publication, "dzen" had no policy row (REVIEW_REQUIRED).
    const historical = report(db, p1.partner, p1.engagementId, { channel_key: "dzen", published_at: "2029-01-01T00:00:00.000Z" });
    expect(historical.revision.channel_policy_status).toBe("REVIEW_REQUIRED");
    // Admin reviews and clears "dzen" AFTER that publication.
    setAgentReferralsChannelPolicy(db, { channel_key: "dzen", status: "ALLOWED", effective_from: "2030-01-01T00:00:00.000Z", reason: "reviewed" });
    // The historical revision's classification is immutable evidence - it never changes retroactively.
    const stillHistorical = db.prepare("SELECT channel_policy_status FROM engagement_distribution_revisions WHERE id = ?").get(historical.revision.id) as { channel_policy_status: string };
    expect(stillHistorical.channel_policy_status).toBe("REVIEW_REQUIRED");
    // A NEW report published after the review resolves ALLOWED.
    const newReport = report(db, p1.partner, p1.engagementId, { channel_key: "dzen", published_at: "2030-02-01T00:00:00.000Z" });
    expect(newReport.revision.channel_policy_status).toBe("ALLOWED");
  });
});

describe("correction lineage: a new revision with provenance, never an UPDATE over a filed fact", () => {
  it("revision 1 needs no correction_reason; a correction mints revision 2, superseding revision 1, which stays exactly as filed", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const first = report(db, p1.partner, p1.engagementId, { distribution_resource_url: "https://t.me/art_channel/wrong" });
    const corrected = correctDistribution(db, admin, first.distribution_id, { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel", distribution_resource_url: "https://t.me/art_channel/right", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev-2" }, "typo fix");
    expect(corrected.revision.revision).toBe(2);
    expect(corrected.revision.supersedes_revision_id).toBe(first.revision.id);
    const original = db.prepare("SELECT distribution_resource_url FROM engagement_distribution_revisions WHERE id = ?").get(first.revision.id) as { distribution_resource_url: string };
    expect(original.distribution_resource_url).toBe("https://t.me/art_channel/wrong"); // unchanged, kept for provenance
    // A second correction is a THIRD revision, not a uniqueness violation.
    const secondCorrection = correctDistribution(db, admin, first.distribution_id, { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel", distribution_resource_url: "https://t.me/art_channel/final", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev-3" }, "second correction");
    expect(secondCorrection.revision.revision).toBe(3);
  });

  it("a correction without a reason is refused", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const first = report(db, p1.partner, p1.engagementId);
    expect(() => correctDistribution(db, admin, first.distribution_id, { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@x", distribution_resource_url: "https://t.me/x/2", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev" }, "")).toThrow(DistributionError);
  });
});

describe("removal lifecycle: per distribution, never an aggregate shortcut (§B-5d)", () => {
  it("confirming removal of ONE distribution leaves the other two outstanding", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const d1 = report(db, p1.partner, p1.engagementId, { resource_identifier: "@c1", distribution_resource_url: "https://t.me/c1/1" });
    const d2 = report(db, p1.partner, p1.engagementId, { resource_identifier: "@c2", distribution_resource_url: "https://t.me/c2/1" });
    const d3 = report(db, p1.partner, p1.engagementId, { resource_identifier: "@c3", distribution_resource_url: "https://t.me/c3/1" });

    requireRemoval(db, admin, d1.distribution_id, "manual review flagged");
    confirmRemoval(db, admin, d1.distribution_id, "confirmed-evidence");
    expect(distributionProjection(db, d1.distribution_id).removal_state).toBe("REMOVAL_CONFIRMED");
    expect(distributionProjection(db, d2.distribution_id).removal_state).toBeNull();
    expect(distributionProjection(db, d3.distribution_id).removal_state).toBeNull();
    expect(distributionsForEngagement(db, p1.engagementId)).toHaveLength(3);
  });

  it("claim -> confirm folds to REMOVAL_CONFIRMED as the current removal state, with full event history preserved", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const d = report(db, p1.partner, p1.engagementId);
    claimRemoval(db, p1.partner, d.distribution_id, "claim-evidence");
    expect(distributionProjection(db, d.distribution_id).removal_state).toBe("REMOVAL_CLAIMED");
    confirmRemoval(db, admin, d.distribution_id, "confirm-evidence");
    expect(distributionProjection(db, d.distribution_id).removal_state).toBe("REMOVAL_CONFIRMED");
    expect(distributionEvents(db, d.distribution_id).map((e) => e.event_kind)).toEqual(["DECLARED", "MARKED_REPORTABLE", "REMOVAL_CLAIMED", "REMOVAL_CONFIRMED"]);
  });

  it("OVERDUE_REMOVAL does not block anything else from being recorded for the same distribution", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    const d = report(db, p1.partner, p1.engagementId);
    requireRemoval(db, admin, d.distribution_id, "manual review flagged");
    markOverdueRemoval(db, admin, d.distribution_id, "still not removed");
    expect(distributionProjection(db, d.distribution_id).removal_state).toBe("OVERDUE_REMOVAL");
    confirmRemoval(db, admin, d.distribution_id, "finally confirmed");
    expect(distributionProjection(db, d.distribution_id).removal_state).toBe("REMOVAL_CONFIRMED");
  });
});

describe("no approval workflow, no capacity", () => {
  it("reporting is never gated by any per-post review, and multiple reports for the same engagement/channel are all accepted", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    for (let i = 0; i < 5; i += 1) {
      expect(() => report(db, p1.partner, p1.engagementId, { resource_identifier: `@post-${i}`, distribution_resource_url: `https://t.me/x/${i}` })).not.toThrow();
    }
    expect(distributionsForEngagement(db, p1.engagementId)).toHaveLength(5);
  });
});

describe("fault injection", () => {
  it("a fault at the classification event insert rolls back the ENTIRE distribution report, including its revision row - never a fact with no classification", () => {
    const db = fresh();
    const p1 = readyEngagementWithCreative(db);
    db.exec(`CREATE TRIGGER poison_distribution_event BEFORE INSERT ON engagement_distribution_events
      BEGIN SELECT RAISE(ABORT, 'INJECTED_DISTRIBUTION_EVENT_FAILURE'); END;`);
    const before = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    expect(() => report(db, p1.partner, p1.engagementId)).toThrow(/INJECTED_DISTRIBUTION_EVENT_FAILURE/);
    db.exec("DROP TRIGGER poison_distribution_event");
    const after = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    expect(after.n).toBe(before.n);
    const retry = report(db, p1.partner, p1.engagementId);
    expect(retry.distribution_id).toBeTruthy();
  });
});

describe("partner ownership: a PARTNER may only write evidence for their own engagement/distribution", () => {
  it("reportDistribution refuses a PARTNER reporting for another partner's engagement - zero rows written", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const otherPartner = readyPartner(db);
    const before = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    expect(() => report(db, otherPartner.partner, engaged.engagementId)).toThrow(DistributionError);
    expect(() => report(db, otherPartner.partner, engaged.engagementId)).toThrow(/AGENT_REFERRALS_DISTRIBUTION_WRONG_PARTNER/);
    const after = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it("correctDistribution and claimRemoval refuse a PARTNER acting on another partner's distribution", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const otherPartner = readyPartner(db);
    const real = report(db, engaged.partner, engaged.engagementId);
    expect(() => correctDistribution(db, otherPartner.partner, real.distribution_id,
      { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@x", distribution_resource_url: "https://t.me/x/2", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev" },
      "not mine to correct")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_WRONG_PARTNER/);
    expect(() => claimRemoval(db, otherPartner.partner, real.distribution_id, "ev")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_WRONG_PARTNER/);
    // The real owner still can.
    expect(() => claimRemoval(db, engaged.partner, real.distribution_id, "ev")).not.toThrow();
  });

  it("admin remains permitted for both engagement-scoped and distribution-scoped writes, regardless of which partner owns them", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const admin1 = reportDistribution(db, admin, engaged.engagementId, { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@x", distribution_resource_url: "https://t.me/x/1", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev" });
    requireRemoval(db, admin, admin1.distribution_id, "manual review flagged");
    expect(() => confirmRemoval(db, admin, admin1.distribution_id, "ev")).not.toThrow();
  });
});

describe("historical authority (§B-5c/§B-5d): a distribution pins the creative authority live at published_at, never whatever is current now", () => {
  it("a late report of an old (Monday) publication still pins the OLD engagement/creative revision, even after Tuesday's material change made a new one current", async () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    await new Promise((resolve) => setTimeout(resolve, 50)); // guarantee millisecond separation from the feature's own ACTIVE transition timestamp, minted during fixture setup
    const publishedDuringR1 = new Date().toISOString();
    const superseded = supersedeAuthority(db, engaged, { customer_discount_value: 1500 });
    const publishedDuringR2 = new Date().toISOString();

    const lateReport = report(db, engaged.partner, engaged.engagementId, { published_at: publishedDuringR1 });
    expect(lateReport.revision.engagement_revision_id).toBe(engaged.revisionId);
    expect(lateReport.revision.creative_revision_id).toBe(engaged.creativeId);
    expect(distributionProjection(db, lateReport.distribution_id).compliance_state).toBe("MARKED_REPORTABLE");

    const currentReport = report(db, engaged.partner, engaged.engagementId, { published_at: publishedDuringR2, resource_identifier: "@c2" });
    expect(currentReport.revision.engagement_revision_id).toBe(superseded.revisionId);
    expect(currentReport.revision.creative_revision_id).toBe(superseded.creativeId);
  });

  it("a report whose published_at predates any authorization EVER effective for this engagement is still persisted, pinned to nothing (never fabricated), classified REVIEW_REQUIRED with no removal obligation", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const before = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    const result = report(db, engaged.partner, engaged.engagementId, { published_at: "2000-01-01T00:00:00.000Z" });
    const after = db.prepare("SELECT COUNT(*) AS n FROM engagement_distributions").get() as { n: number };
    expect(after.n).toBe(before.n + 1); // the fact was persisted, not rejected
    expect(result.revision.engagement_revision_id).toBeNull();
    expect(result.revision.creative_revision_id).toBeNull();
    const projection = distributionProjection(db, result.distribution_id);
    expect(projection.compliance_state).toBe("REVIEW_REQUIRED");
    expect(projection.removal_state).toBeNull(); // nothing concrete on record to point a removal obligation at
  });

  it("publishing after publication_end_at is classified REVIEW_REQUIRED + REMOVAL_REQUIRED even on an ALLOWED channel - a new distribution is prohibited past the window (§B-5d)", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db); // publication_end_at = 2035-01-01
    const result = report(db, engaged.partner, engaged.engagementId, { published_at: "2036-06-01T00:00:00.000Z" });
    expect(result.revision.channel_policy_status).toBe("ALLOWED"); // telegram is ALLOWED - the channel itself is not the problem
    expect(result.revision.engagement_revision_id).toBe(engaged.revisionId); // still pinned - we know exactly which creative
    const projection = distributionProjection(db, result.distribution_id);
    expect(projection.compliance_state).toBe("REVIEW_REQUIRED");
    expect(projection.removal_state).toBe("REMOVAL_REQUIRED");
  });

  it("publishing before publication_start_at is classified REVIEW_REQUIRED + REMOVAL_REQUIRED too - not just the end bound", () => {
    const db = fresh();
    const p1 = readyPartner(db);
    const occ = seedOccurrence(db, p1.cityId);
    // publication_start_at is in the future relative to when the creative authorization actually becomes effective (now),
    // so a publish reported between the two exercises the authority's OWN start bound, distinct from NO_AUTHORITY (the authorization does exist by then).
    const futureTerms: EngagementRevisionTerms = { ...terms1, publication_start_at: "2030-01-01T00:00:00.000Z" };
    const { engagement_id: engagementId, engagement_revision_id: revisionId } = offerEngagement(db, admin, p1.partnerIdentityId, occ, futureTerms, "offer");
    const grant = mintEngagementStepUpGrant(db, p1.partner, "ENGAGEMENT_ACCEPTANCE", { engagement_id: engagementId, engagement_revision_id: revisionId }).grant_id;
    acceptEngagement(db, p1.partner, engagementId, revisionId, grant);
    activateEngagement(db, admin, engagementId, revisionId);
    const creative = mintCreativeRevision(db, admin, engagementId, {
      format_kind: "post", media_ref: null, copy_text: "Buy now", cta_text: "Click", mandatory_labeling_text: "Реклама", creative_target_url: "https://flexperiment.ru/x?promo=ART",
    });
    authorizeCreative(db, admin, engagementId, creative.id);

    const result = reportDistribution(db, p1.partner, engagementId, {
      channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel", distribution_resource_url: "https://t.me/art_channel/1",
      published_at: "2029-06-01T00:00:00.000Z", ended_at: null, evidence_ref: "ev-1",
    });
    expect(result.revision.engagement_revision_id).toBe(revisionId); // authority is found and pinned, just invalid at that instant
    const projection = distributionProjection(db, result.distribution_id);
    expect(projection.compliance_state).toBe("REVIEW_REQUIRED");
    expect(projection.removal_state).toBe("REMOVAL_REQUIRED");
  });

  it("a creative authorization left unrevoked while its underlying PROMO authorization was revoked (by suspension) does not falsely read as authorized - the promo authorization's own revocation is checked independently", async () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    // Suspend the engagement: revokes the PROMO authorization (engagement_promo_authorizations.revoked_at)
    // but does NOT touch the creative authorization (engagement_creative_authorizations.revoked_at stays NULL) - the exact gap this check closes.
    suspendEngagement(db, admin, engaged.engagementId, "manual pause");
    await new Promise((resolve) => setTimeout(resolve, 50)); // guarantee millisecond separation from the feature's own ACTIVE transition timestamp, minted during fixture setup
    const publishedAfterSuspension = new Date().toISOString();
    const result = report(db, engaged.partner, engaged.engagementId, { published_at: publishedAfterSuspension });
    expect(result.revision.engagement_revision_id).toBe(engaged.revisionId); // the creative authorization itself is still found and pinned
    const projection = distributionProjection(db, result.distribution_id);
    expect(projection.compliance_state).toBe("REVIEW_REQUIRED"); // but NOT falsely MARKED_REPORTABLE
    expect(projection.removal_state).toBe("REMOVAL_REQUIRED");
  });

  it("a publication reported with published_at inside a window where the feature was GLOBALLY SUSPENDED at that instant is INVALID_AUTHORITY, even though the feature is ACTIVE again by the time it is reported", async () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db); // feature state revision 2 (ACTIVE)
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "global pause" });
    await new Promise((resolve) => setTimeout(resolve, 50)); // guarantee millisecond separation from the SUSPENDED transition's own timestamp
    const publishedDuringSuspension = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 50)); // guarantee millisecond separation before the REACTIVATE transition's own timestamp
    reactivateAgentReferrals(db, { expected_revision: 3, owner_id: "test-owner", reason: "resume" });

    // The report itself is still permitted (DISTRIBUTION_FACT_REPORTING is a
    // reporting-tail class, permitted even under SUSPENDED) - it is the
    // AUTHORITY classification of a publication made globally SUSPENDED
    // that must be INVALID, not the report call itself.
    const result = report(db, engaged.partner, engaged.engagementId, { published_at: publishedDuringSuspension });
    expect(result.revision.engagement_revision_id).toBe(engaged.revisionId); // the per-engagement authorization is still found and pinned
    const projection = distributionProjection(db, result.distribution_id);
    expect(projection.compliance_state).toBe("REVIEW_REQUIRED"); // never falsely MARKED_REPORTABLE
    expect(projection.removal_state).toBe("REMOVAL_REQUIRED");
  });

  it("a correction that moves published_at ACROSS an authority boundary re-resolves and re-pins - never silently retains the prior revision's now-wrong authority", async () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    await new Promise((resolve) => setTimeout(resolve, 50)); // guarantee millisecond separation from the feature's own ACTIVE transition timestamp, minted during fixture setup
    const publishedDuringR1 = new Date().toISOString();
    const superseded = supersedeAuthority(db, engaged, { customer_discount_value: 1500 });
    const publishedDuringR2 = new Date().toISOString();

    const first = report(db, engaged.partner, engaged.engagementId, { published_at: publishedDuringR1 });
    expect(first.revision.engagement_revision_id).toBe(engaged.revisionId);

    // Correct the SAME distribution's published_at into R2/C2's territory.
    const corrected = correctDistribution(db, engaged.partner, first.distribution_id,
      { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel", distribution_resource_url: "https://t.me/art_channel/1", published_at: publishedDuringR2, ended_at: null, evidence_ref: "ev-corrected" },
      "corrected the actual publish date");
    expect(corrected.distribution_id).toBe(first.distribution_id);
    expect(corrected.revision.engagement_revision_id).toBe(superseded.revisionId); // re-pinned to R2, not left on R1
    expect(corrected.revision.creative_revision_id).toBe(superseded.creativeId);

    // The ORIGINAL revision's own pin is untouched - immutable evidence, never rewritten.
    const originalRevision = db.prepare("SELECT engagement_revision_id FROM engagement_distribution_revisions WHERE id = ?").get(first.revision.id) as { engagement_revision_id: string };
    expect(originalRevision.engagement_revision_id).toBe(engaged.revisionId);
  });
});

describe("projection folds only the CURRENT revision's own events, never the whole distribution history (Phase 5 holistic review, P0 finding 4)", () => {
  it("a correction that fixes an INVALID_AUTHORITY report into an AUTHORIZED one clears the stale REMOVAL_REQUIRED - it does not linger from the superseded revision", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db); // publication_start_at = 2020-01-01, publication_end_at = 2035-01-01
    const first = report(db, engaged.partner, engaged.engagementId, { published_at: "2036-06-01T00:00:00.000Z" }); // past the window
    expect(distributionProjection(db, first.distribution_id)).toMatchObject({ compliance_state: "REVIEW_REQUIRED", removal_state: "REMOVAL_REQUIRED" });

    const corrected = correctDistribution(db, engaged.partner, first.distribution_id,
      { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel", distribution_resource_url: "https://t.me/art_channel/1", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev-corrected" },
      "corrected the actual publish date - it was really inside the window");
    expect(corrected.revision.engagement_revision_id).toBe(engaged.revisionId);
    const projection = distributionProjection(db, first.distribution_id);
    expect(projection.compliance_state).toBe("MARKED_REPORTABLE");
    expect(projection.removal_state).toBeNull(); // the stale REMOVAL_REQUIRED from the superseded revision is gone, not inherited
  });

  it("a correction after REMOVAL_CONFIRMED does not let the new revision silently inherit a confirmation that was actually about the PRIOR facts", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const first = report(db, engaged.partner, engaged.engagementId);
    expect(distributionProjection(db, first.distribution_id).compliance_state).toBe("MARKED_REPORTABLE");
    requireRemoval(db, admin, first.distribution_id, "manual review flagged");
    confirmRemoval(db, admin, first.distribution_id, "confirmed removed");
    expect(distributionProjection(db, first.distribution_id).removal_state).toBe("REMOVAL_CONFIRMED");

    // A correction changes the actual facts on record (a different URL) -
    // the OLD confirmation was about the OLD facts, not these new ones.
    const corrected = correctDistribution(db, engaged.partner, first.distribution_id,
      { channel_key: "telegram", resource_kind: "channel", resource_identifier: "@art_channel_2", distribution_resource_url: "https://t.me/art_channel_2/1", published_at: "2030-09-10T00:00:00.000Z", ended_at: null, evidence_ref: "ev-corrected" },
      "the actual channel handle was different");
    expect(corrected.distribution_id).toBe(first.distribution_id);
    // The new revision's own projection starts fresh - not REMOVAL_CONFIRMED for facts nobody has actually confirmed removed yet.
    expect(distributionProjection(db, first.distribution_id).removal_state).toBeNull();
    expect(distributionProjection(db, first.distribution_id).compliance_state).toBe("MARKED_REPORTABLE");
    // The full event history - including the original CONFIRMED - is still preserved, never rewritten.
    const kinds = distributionEvents(db, first.distribution_id).map((e) => e.event_kind);
    expect(kinds).toEqual(["DECLARED", "MARKED_REPORTABLE", "REMOVAL_REQUIRED", "REMOVAL_CONFIRMED", "DECLARED", "MARKED_REPORTABLE"]);
  });
});

describe("removal/compliance lifecycle transition matrix - fail-closed on illegal sequences (Phase 5 holistic review, P1 finding 5)", () => {
  it("refuses REMOVAL_CONFIRMED with no REMOVAL_REQUIRED/CLAIMED/OVERDUE/UNVERIFIED ever recorded for the current revision", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const d = report(db, engaged.partner, engaged.engagementId);
    expect(() => confirmRemoval(db, admin, d.distribution_id, "ev")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_REMOVAL_ILLEGAL_TRANSITION/);
  });

  it("refuses REMOVAL_CLAIMED after REMOVAL_CONFIRMED", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const d = report(db, engaged.partner, engaged.engagementId);
    requireRemoval(db, admin, d.distribution_id, "flagged");
    confirmRemoval(db, admin, d.distribution_id, "confirmed");
    expect(() => claimRemoval(db, engaged.partner, d.distribution_id, "late claim")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_REMOVAL_ILLEGAL_TRANSITION/);
  });

  it("refuses a repeated REMOVAL_CONFIRMED", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const d = report(db, engaged.partner, engaged.engagementId);
    requireRemoval(db, admin, d.distribution_id, "flagged");
    confirmRemoval(db, admin, d.distribution_id, "confirmed");
    expect(() => confirmRemoval(db, admin, d.distribution_id, "confirmed again")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_REMOVAL_ILLEGAL_TRANSITION/);
  });

  it("refuses OVERDUE_REMOVAL with nothing ever required for the current revision", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const d = report(db, engaged.partner, engaged.engagementId);
    expect(() => markOverdueRemoval(db, admin, d.distribution_id, "overdue")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_REMOVAL_ILLEGAL_TRANSITION/);
  });

  it("a partner may proactively CLAIM removal with no prior admin REMOVAL_REQUIRED - a legitimate real sequence, not gated", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const d = report(db, engaged.partner, engaged.engagementId);
    expect(() => claimRemoval(db, engaged.partner, d.distribution_id, "proactive takedown")).not.toThrow();
    expect(distributionProjection(db, d.distribution_id).removal_state).toBe("REMOVAL_CLAIMED");
  });

  it("REVIEW_CLEARED is legal only from REVIEW_REQUIRED - refused when the current compliance state is MARKED_REPORTABLE (nothing under review)", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const compliant = report(db, engaged.partner, engaged.engagementId);
    expect(distributionProjection(db, compliant.distribution_id).compliance_state).toBe("MARKED_REPORTABLE");
    expect(() => markReviewCleared(db, admin, compliant.distribution_id, "clearing something never under review")).toThrow(/AGENT_REFERRALS_DISTRIBUTION_COMPLIANCE_ILLEGAL_TRANSITION/);

    const flagged = report(db, engaged.partner, engaged.engagementId, { channel_key: "totally_unknown_platform", resource_identifier: "@other" });
    expect(distributionProjection(db, flagged.distribution_id).compliance_state).toBe("REVIEW_REQUIRED");
    expect(() => markReviewCleared(db, admin, flagged.distribution_id, "reviewed and cleared")).not.toThrow();
    expect(distributionProjection(db, flagged.distribution_id).compliance_state).toBe("REVIEW_CLEARED");
  });
});

describe("event_sequence: explicit durable canonical fold order, not SQLite's implicit rowid", () => {
  it("events for one distribution get an explicit monotonic 1..N event_sequence, matching insertion order", () => {
    const db = fresh();
    const engaged = readyEngagementWithCreative(db);
    const d = report(db, engaged.partner, engaged.engagementId);
    claimRemoval(db, engaged.partner, d.distribution_id, "ev-claim");
    confirmRemoval(db, admin, d.distribution_id, "ev-confirm");
    const events = distributionEvents(db, d.distribution_id);
    expect(events.map((e) => e.event_sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.event_kind)).toEqual(["DECLARED", "MARKED_REPORTABLE", "REMOVAL_CLAIMED", "REMOVAL_CONFIRMED"]);
    // Structural backstop: no two events for the same distribution can ever share a sequence number.
    expect(() => db.prepare(`INSERT INTO engagement_distribution_events(id, distribution_id, event_sequence, event_kind, actor_realm) VALUES (?, ?, 1, 'DECLARED', 'SYSTEM')`).run(randomUUID(), d.distribution_id))
      .toThrow(/UNIQUE constraint failed/);
  });
});
