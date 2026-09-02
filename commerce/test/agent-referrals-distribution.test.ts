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
import { offerEngagement, acceptEngagement, activateEngagement, type EngagementRevisionTerms } from "../src/agent-referrals-engagement";
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
  reportDistribution,
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
  mintAudienceVerificationEvent(db, admin, partnerIdentityId, cityId, "VERIFIED", "verified", "ev-1");
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
  const creative = mintCreativeRevision(db, admin, engagementId, p1.agentId, p1.promo.promo_code_id, {
    format_kind: "post", media_ref: null, copy_text: "Buy now", cta_text: "Click", mandatory_labeling_text: "Реклама", creative_target_url: "https://flexperiment.ru/x?promo=ART",
  });
  authorizeCreative(db, admin, engagementId, creative.id);
  return { ...p1, engagementId };
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
