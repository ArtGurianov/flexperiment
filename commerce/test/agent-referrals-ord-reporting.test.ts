import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { suspendAgentReferrals } from "../src/agent-referrals-feature-state";
import { recordAgentReferralsActivationEvidence } from "../src/agent-referrals-activation";
import {
  admin, fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, closeAndComplete, wait,
} from "./support/agent-referrals-settlement-fixtures";
import { seedOrdProviderProfiles, readyCreative, canonicalTargetUrl, reportedDistribution } from "./support/agent-referrals-ord-fixtures";
import { finalizeEngagementRewardRegistry, closeEngagementWithRewardRegistry } from "../src/agent-referrals-reward-registry";
import {
  fileOrdDistributionPeriodReport, recordOrdDistributionPeriodReportReconciliation, currentOrdDistributionPeriodReport, resolveOrdReportingBasis,
  ordDistributionPeriodReportsForDistribution, OrdReportingError, ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY,
} from "../src/agent-referrals-ord-reporting";

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const distributionFor = (db: Database.Database, engagementId: string, publishedAt: string, channelKey = "telegram") => {
  const p1 = db.prepare("SELECT pi.id AS partner_identity_id FROM engagements e JOIN partner_identities pi ON pi.id = e.partner_identity_id WHERE e.id = ?").get(engagementId) as { partner_identity_id: string };
  const partner = { realm: "PARTNER" as const, partner_identity_id: p1.partner_identity_id, partner_session_id: "n/a" };
  const { distribution_id } = reportedDistribution(db, partner, engagementId, publishedAt, channelKey);
  return distribution_id;
};

const setupWithDistribution = (formatKind: "post" | "long_video" = "post", publishedAt = "2026-09-20T00:00:00.000Z") => {
  const { db, domain } = fresh();
  open.push(db);
  seedOrdProviderProfiles(db);
  const p1 = readyPartner(db, "OTHER");
  const occ = seedOccurrence(db, p1.cityId);
  const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000));
  const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
  readyCreative(db, engagementId, canonicalTargetUrl(p1.cityId, code), formatKind);
  const distributionId = distributionFor(db, engagementId, publishedAt);
  return { db, domain, p1, occ, engagementId, distributionId };
};

describe("resolveOrdReportingBasis", () => {
  it("ordinary formats resolve to CALENDAR_MONTH", () => {
    const { db } = fresh(); open.push(db);
    expect(resolveOrdReportingBasis(db, "post", "2026-09-01T00:00:00.000Z")).toBe("CALENDAR_MONTH");
  });

  it("authored/persistent formats resolve to PROVIDER_SPECIAL_PERIOD", () => {
    const { db } = fresh(); open.push(db);
    expect(resolveOrdReportingBasis(db, "long_video", "2026-09-01T00:00:00.000Z")).toBe("PROVIDER_SPECIAL_PERIOD");
    expect(resolveOrdReportingBasis(db, "stream", "2026-09-01T00:00:00.000Z")).toBe("PROVIDER_SPECIAL_PERIOD");
  });
});

describe("fileOrdDistributionPeriodReport: ordinary CALENDAR_MONTH reporting", () => {
  it("cross-month reporting: one publication spans two independent period reports", () => {
    const { db, distributionId } = setupWithDistribution("post", "2026-09-20T00:00:00.000Z");
    const sep = fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 100 } }, evidence_ref: "ev-sep",
    });
    const oct = fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: "2026-10", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 50 } }, evidence_ref: "ev-oct",
    });
    expect(sep.reporting_period_key).toBe("2026-09");
    expect(oct.reporting_period_key).toBe("2026-10");
    expect(sep.revision).toBe(1);
    expect(oct.revision).toBe(1);
    expect(ordDistributionPeriodReportsForDistribution(db, distributionId)).toHaveLength(2);
  });

  it("REPORTING_DATA_UNAVAILABLE is a first-class state: no statistics_json, forces REVIEW_REQUIRED semantics via the caller", () => {
    const { db, distributionId } = setupWithDistribution();
    const report = fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "REPORTING_DATA_UNAVAILABLE" }, evidence_ref: "ev",
    });
    expect(report.statistics_state).toBe("REPORTING_DATA_UNAVAILABLE");
    expect(report.statistics_json).toBeNull();
  });

  it("a raw INSERT cannot fabricate a zero for unavailable data - statistics_json is impossible when REPORTING_DATA_UNAVAILABLE (CHECK)", () => {
    const { db, distributionId } = setupWithDistribution();
    const revision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(distributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, statistics_state, statistics_json, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', '2026-09', 1, 'REPORTING_DATA_UNAVAILABLE', '{"impressions":0}', 'op-1', 'h', 'admin')`)
      .run(randomUUID(), distributionId, revision.id)).toThrow(/CHECK constraint failed/);
  });

  it("ACTUAL requires statistics_json (CHECK)", () => {
    const { db, distributionId } = setupWithDistribution();
    const revision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(distributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, statistics_state, statistics_json, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', '2026-09', 1, 'ACTUAL', NULL, 'op-1', 'h', 'admin')`)
      .run(randomUUID(), distributionId, revision.id)).toThrow(/CHECK constraint failed/);
  });
});

describe("correction lineage: revision 1 -> 2 -> 3", () => {
  it("a second filing without a correction_reason is refused; with one, mints revision 2 with exact predecessor lineage", () => {
    const { db, distributionId } = setupWithDistribution();
    const r1 = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "REPORTING_DATA_UNAVAILABLE" }, evidence_ref: "ev1" });
    expect(() => fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 10 } }, evidence_ref: "ev2" }))
      .toThrow(/AGENT_REFERRALS_ORD_REPORTING_CORRECTION_REASON_REQUIRED/);
    const r2 = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 10 } }, evidence_ref: "ev2", correction_reason: "data arrived" });
    expect(r2.revision).toBe(2);
    expect(r2.supersedes_report_id).toBe(r1.id);
    const r3 = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 12 } }, evidence_ref: "ev3", correction_reason: "recount" });
    expect(r3.revision).toBe(3);
    expect(r3.supersedes_report_id).toBe(r2.id);
    // Old revisions remain readable and immutable.
    expect(() => db.prepare("UPDATE ord_distribution_period_reports SET statistics_json = 'x' WHERE id = ?").run(r1.id)).toThrow(/ORD_DISTRIBUTION_PERIOD_REPORT_IMMUTABLE/);
    expect(ordDistributionPeriodReportsForDistribution(db, distributionId)).toHaveLength(3);
    expect(currentOrdDistributionPeriodReport(db, distributionId, "2026-09")!.id).toBe(r3.id);
  });

  it("a raw INSERT naming the WRONG predecessor (not exactly revision-1 on the same distribution+period) is refused", () => {
    const { db, distributionId } = setupWithDistribution();
    fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "REPORTING_DATA_UNAVAILABLE" }, evidence_ref: "ev1" });
    const revision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(distributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id, statistics_state, correction_reason, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', '2026-09', 2, ?, 'REPORTING_DATA_UNAVAILABLE', 'x', 'op-wrong', 'h', 'admin')`)
      .run(randomUUID(), distributionId, revision.id, randomUUID())) // a nonexistent predecessor id
      .toThrow(/ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT/);
  });

  it("a raw cross-distribution supersession is refused", () => {
    const { db, distributionId } = setupWithDistribution();
    const first = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "REPORTING_DATA_UNAVAILABLE" }, evidence_ref: "ev1" });
    const otherDistributionId = distributionFor(db, (db.prepare("SELECT engagement_id FROM engagement_distributions WHERE id = ?").get(distributionId) as { engagement_id: string }).engagement_id, "2026-09-21T00:00:00.000Z");
    const otherRevision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(otherDistributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id, statistics_state, correction_reason, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', '2026-09', 2, ?, 'REPORTING_DATA_UNAVAILABLE', 'x', 'op-cross', 'h', 'admin')`)
      .run(randomUUID(), otherDistributionId, otherRevision.id, first.id)) // predecessor belongs to a DIFFERENT distribution
      .toThrow(/ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT/);
  });

  it("a raw cross-period supersession is refused", () => {
    const { db, distributionId } = setupWithDistribution();
    const sep = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "REPORTING_DATA_UNAVAILABLE" }, evidence_ref: "ev1" });
    const revision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(distributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id, statistics_state, correction_reason, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', '2026-10', 2, ?, 'REPORTING_DATA_UNAVAILABLE', 'x', 'op-crossperiod', 'h', 'admin')`)
      .run(randomUUID(), distributionId, revision.id, sep.id)) // predecessor is for a DIFFERENT period
      .toThrow(/ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT/);
  });

  it("a report naming a distribution_revision_id that belongs to a DIFFERENT distribution is refused", () => {
    const { db, distributionId, engagementId } = setupWithDistribution();
    const otherDistributionId = distributionFor(db, engagementId, "2026-09-22T00:00:00.000Z");
    const otherRevision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(otherDistributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, statistics_state, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', '2026-09', 1, 'REPORTING_DATA_UNAVAILABLE', 'op-x', 'h', 'admin')`)
      .run(randomUUID(), distributionId, otherRevision.id)).toThrow(/ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT/);
  });
});

describe("PROVIDER_SPECIAL_PERIOD fail-closed (L5)", () => {
  it("an ACTUAL report on a PROVIDER_SPECIAL_PERIOD format is refused until confirmed - never silently falls back to CALENDAR_MONTH", () => {
    const { db, distributionId } = setupWithDistribution("long_video");
    expect(() => fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "special-2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { views: 5 } }, evidence_ref: "ev" }))
      .toThrow(/AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_UNCONFIRMED/);
  });

  it("REPORTING_DATA_UNAVAILABLE remains legal on PROVIDER_SPECIAL_PERIOD regardless of confirmation - it asserts nothing about the VK field mapping", () => {
    const { db, distributionId } = setupWithDistribution("long_video");
    expect(() => fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "special-2026-09", statistics: { statistics_state: "REPORTING_DATA_UNAVAILABLE" }, evidence_ref: "ev" })).not.toThrow();
  });

  it("once confirmed via the activation manifest, ACTUAL reporting on PROVIDER_SPECIAL_PERIOD succeeds", () => {
    const { db, distributionId } = setupWithDistribution("long_video");
    recordAgentReferralsActivationEvidence(db, ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY, true);
    const report = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "special-2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { views: 5 } }, evidence_ref: "ev" });
    expect(report.reporting_basis).toBe("PROVIDER_SPECIAL_PERIOD");
  });
});

describe("ZERO_REWARD_STATISTICS vs CONTINUING_STATISTICS (plan §B-3)", () => {
  // publication_start_at/end_at are set relative to "now" (not the shared
  // nearTermTerms' fixed 2020-01-01) so the distribution's own publishedAt
  // can land AFTER the creative authorization's real effective_at (which is
  // always "now" at mint time) - otherwise resolveHistoricalCreativeAuthority
  // would correctly resolve NO_AUTHORITY (no creative authorization existed
  // yet as of a 2020 publishedAt) and format_kind could never resolve.
  const zeroRewardClosedWithDistribution = async () => {
    const { db, domain } = fresh();
    open.push(db);
    seedOrdProviderProfiles(db);
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId);
    const start = new Date();
    const terms = { reward_type: "PERCENT" as const, reward_value: 1000, customer_discount_type: "PERCENT" as const, customer_discount_value: 1000, publication_start_at: start.toISOString(), publication_end_at: new Date(start.getTime() + 250).toISOString(), terms: {} };
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, terms);
    const { code } = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    readyCreative(db, engagementId, canonicalTargetUrl(p1.cityId, code), "post");
    const distributionId = distributionFor(db, engagementId, new Date(start.getTime() + 50).toISOString());
    const serviceMonth = start.toISOString().slice(0, 7);
    await wait(300);
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "no purchases");
    const { closeEngagementZeroReward } = await import("../src/agent-referrals-zero-reward-closure");
    const closure = closeEngagementZeroReward(db, admin, engagementId, "NO_ELIGIBLE_CONVERSIONS", randomUUID());
    return { db, domain, engagementId, distributionId, closure, finalize, serviceMonth };
  };

  it("refuses ZERO_REWARD_STATISTICS/CONTINUING_STATISTICS without a genuine current zero-reward closure for this engagement", () => {
    const { db, distributionId } = setupWithDistribution();
    expect(() => fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: "2020-01", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 0 } }, evidence_ref: "ev", statistics_reason: "ZERO_REWARD_STATISTICS",
    })).toThrow(/AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_CLOSURE_MISSING/);
  });

  it("ZERO_REWARD_STATISTICS succeeds for the closure's own original contractual service month", async () => {
    const { db, distributionId, serviceMonth } = await zeroRewardClosedWithDistribution();
    const report = fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: serviceMonth, statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 0 } }, evidence_ref: "ev", statistics_reason: "ZERO_REWARD_STATISTICS",
    });
    expect(report.statistics_reason).toBe("ZERO_REWARD_STATISTICS");
    expect(report.zero_reward_closure_id).not.toBeNull();
  });

  it("ZERO_REWARD_STATISTICS for a DIFFERENT period than the service month is refused", async () => {
    const { db, distributionId, serviceMonth } = await zeroRewardClosedWithDistribution();
    const differentMonth = `${Number(serviceMonth.slice(0, 4)) - 1}${serviceMonth.slice(4)}`;
    expect(() => fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: differentMonth, statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 0 } }, evidence_ref: "ev", statistics_reason: "ZERO_REWARD_STATISTICS",
    })).toThrow(/AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_PERIOD_MISMATCH/);
  });

  it("CONTINUING_STATISTICS succeeds for a LATER period (distribution still accessible)", async () => {
    const { db, distributionId, serviceMonth } = await zeroRewardClosedWithDistribution();
    const laterMonth = `${Number(serviceMonth.slice(0, 4)) + 1}${serviceMonth.slice(4)}`;
    const report = fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: laterMonth, statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 2 } }, evidence_ref: "ev", statistics_reason: "CONTINUING_STATISTICS",
    });
    expect(report.statistics_reason).toBe("CONTINUING_STATISTICS");
  });

  it("CONTINUING_STATISTICS for the service month itself (or earlier) is refused - it is not a LATER period", async () => {
    const { db, distributionId, serviceMonth } = await zeroRewardClosedWithDistribution();
    expect(() => fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: serviceMonth, statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 2 } }, evidence_ref: "ev", statistics_reason: "CONTINUING_STATISTICS",
    })).toThrow(/AGENT_REFERRALS_ORD_REPORTING_CONTINUING_STATISTICS_NOT_LATER/);
  });

  it("a raw INSERT naming a zero_reward_closure_id that does not exist at all is refused (FK)", async () => {
    const { db, distributionId, serviceMonth } = await zeroRewardClosedWithDistribution();
    const revision = db.prepare("SELECT id FROM engagement_distribution_revisions WHERE distribution_id = ?").get(distributionId) as { id: string };
    expect(() => db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, statistics_state, statistics_json, statistics_reason, zero_reward_closure_id, operation_key, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, 'CALENDAR_MONTH', ?, 1, 'ACTUAL', '{}', 'ZERO_REWARD_STATISTICS', ?, 'op-foreign', 'h', 'admin')`)
      .run(randomUUID(), distributionId, revision.id, serviceMonth, randomUUID()))
      .toThrow();
  });

  it("mutual exclusion: a live/paid AGENT_REFERRALS settlement for the engagement blocks ZERO_REWARD_STATISTICS/CONTINUING_STATISTICS filing", async () => {
    const { db, distributionId, engagementId, serviceMonth } = await zeroRewardClosedWithDistribution();
    // Fabricate a PREPARED settlement directly (raw SQL) to simulate the otherwise-impossible "both zero closure and a live settlement exist" state, purely to prove the reporting-side guard independently.
    const registry = db.prepare("SELECT id FROM engagement_reward_registry_snapshot WHERE engagement_id = ?").get(engagementId) as { id: string };
    const effective = db.prepare("SELECT id FROM engagement_effective_reward_snapshots WHERE engagement_id = ? ORDER BY sequence DESC LIMIT 1").get(engagementId) as { id: string };
    db.exec("DROP TRIGGER reward_settlements_authority_tuple_consistency_guard");
    db.prepare(`INSERT INTO reward_settlements(id, agent_id, occurrence_id, amount_kopecks, method, status, contractor_type_snapshot, prepared_at, created_by_admin_id, settlement_flow, engagement_id, engagement_revision_id, base_registry_snapshot_id, reward_registry_hash, effective_reward_snapshot_id, partner_identity_id, payout_profile_revision_id, tax_mode_snapshot, legal_profile_revision_id_snapshot)
      SELECT 'fabricated-settlement', a.id, e.occurrence_id, 1, 'PAYOUT_PROFILE', 'PREPARED', 'INDIVIDUAL_ENTREPRENEUR', datetime('now'), 'admin', 'AGENT_REFERRALS', e.id, er.id, ?, 'h', ?, pi.id, pp.id, 'OTHER', lp.id
      FROM engagements e JOIN partner_identities pi ON pi.id = e.partner_identity_id JOIN agents a ON a.id = pi.agent_id
      JOIN engagement_revisions er ON er.engagement_id = e.id
      JOIN payout_profile_revisions pp ON pp.partner_identity_id = pi.id JOIN agent_referrals_legal_profile_revisions lp ON lp.id = pi.legal_profile_revision_id
      WHERE e.id = ? LIMIT 1`).run(registry.id, effective.id, engagementId);
    expect(() => fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: serviceMonth, statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 0 } }, evidence_ref: "ev", statistics_reason: "ZERO_REWARD_STATISTICS",
    })).toThrow(/ORD_DISTRIBUTION_PERIOD_REPORT_RELATIONAL_INCONSISTENT/);
  });
});

describe("recordOrdDistributionPeriodReportReconciliation", () => {
  it("mints a NEW correction revision carrying identical statistics plus submission/erir evidence - never an UPDATE", () => {
    const { db, distributionId } = setupWithDistribution();
    const r1 = fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 10 } }, evidence_ref: "ev1" });
    const r2 = recordOrdDistributionPeriodReportReconciliation(db, admin, distributionId, "2026-09", "vk-op-1", "erir-1", "ev-reconcile");
    expect(r2.revision).toBe(2);
    expect(r2.supersedes_report_id).toBe(r1.id);
    expect(r2.statistics_state).toBe("ACTUAL");
    expect(JSON.parse(r2.statistics_json!)).toEqual({ impressions: 10 });
    expect(r2.submission_state).toBe("SUBMITTED");
    expect(r2.vk_operation_external_id).toBe("vk-op-1");
    expect(r2.erir_code).toBe("erir-1");
  });
});

describe("existing noncompliant distributions still owe their reporting tail", () => {
  it("a BLOCKED-channel distribution's period reporting is unaffected by the channel classification", () => {
    const { db, engagementId } = setupWithDistribution();
    const distributionId = distributionFor(db, engagementId, "2026-09-25T00:00:00.000Z", "some_blocked_platform"); // no policy row -> REVIEW_REQUIRED, not ALLOWED
    expect(() => fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 1 } }, evidence_ref: "ev" })).not.toThrow();
  });

  it("engagement CLOSED afterwards does not block reporting for an existing distribution", async () => {
    const { db, domain, occ, engagementId, distributionId } = setupWithDistribution();
    await wait(300); // publication_end_at (nearTermTerms) must have passed for closeEngagement to accept it
    closeAndComplete(db, domain, occ);
    const finalize = finalizeEngagementRewardRegistry(db, admin, engagementId, "occurrence completed, no purchases");
    expect(finalize.reward_total_kopecks).toBe(0); // no orders were ever placed
    closeEngagementWithRewardRegistry(db, admin, engagementId, "no eligible conversions");
    expect((db.prepare("SELECT lifecycle_state FROM engagements WHERE id = ?").get(engagementId) as { lifecycle_state: string }).lifecycle_state).toBe("CLOSED");
    expect(() => fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 1 } }, evidence_ref: "ev" })).not.toThrow();
  });

  it("global SUSPENDED does not block reporting for an existing distribution (reporting tail continues)", () => {
    const { db, distributionId } = setupWithDistribution();
    suspendAgentReferrals(db, { expected_revision: 2, owner_id: "test-owner", reason: "pause" });
    expect(() => fileOrdDistributionPeriodReport(db, admin, { distribution_id: distributionId, reporting_period_key: "2026-09", statistics: { statistics_state: "ACTUAL", statistics_json: { impressions: 1 } }, evidence_ref: "ev" })).not.toThrow();
  });
});

describe("errors", () => {
  it("OrdReportingError carries a code and status", () => {
    const err = new OrdReportingError("X", 404, "detail");
    expect(err.code).toBe("X");
    expect(err.status).toBe(404);
  });
});
