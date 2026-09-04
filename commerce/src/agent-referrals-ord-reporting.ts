import type Database from "better-sqlite3";
import { canonicalV2, id, sha256 } from "./crypto";
import { agentReferralsFeatureState } from "./agent-referrals-feature-state";
import { assertAgentReferralsOperationPermitted } from "./agent-referrals-suspension-policy";
import { agentReferralsActivationEvidence } from "./agent-referrals-activation";
import { getDistribution, currentDistributionRevision, type DistributionRevisionRow } from "./agent-referrals-distribution";
import { ordDistributionPeriodReportOperationKey } from "./agent-referrals-ord-operation-key";
import type { AdminPrincipal } from "./agent-referrals-partner-identity";

/**
 * Reporting-period policy resolution (plan §B-10) and distribution-period
 * reporting + correction lineage (plan §B-5c, table
 * "ord_distribution_period_reports") + the zero-reward-vs-continuing-
 * statistics split (plan §B-3). NO PROVIDER NETWORK CALL is reachable from
 * this module - every "submission" recorded here is a durable manual fact
 * an operator observed by hand.
 */

export class OrdReportingError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type ReportingBasis = "CALENDAR_MONTH" | "PROVIDER_SPECIAL_PERIOD";
export type CreativeFormatKind = "post" | "story" | "short_video" | "long_video" | "stream" | "audio" | "text" | "graphic" | "text_graphic" | "native_authored";

/** The activation-manifest key that gates ever FILING an ACTUAL report on the PROVIDER_SPECIAL_PERIOD basis (L5) - never gates the config mapping itself. */
export const ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY = "ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED";

/**
 * Historical-instant resolution, matching resolveAgentReferralsChannelPolicy
 * one migration over: the basis effective AT `atInstant`, never "the
 * mapping now". format_kind is a closed, fully-seeded enum, so an
 * unresolvable lookup is a genuine schema defect, never a silent
 * CALENDAR_MONTH fallback.
 */
export const resolveOrdReportingBasis = (db: Database.Database, formatKind: CreativeFormatKind, atInstant: string): ReportingBasis => {
  const row = db.prepare(`SELECT reporting_basis FROM ord_reporting_period_policy
    WHERE format_kind = ? AND effective_from <= ? ORDER BY effective_from DESC, policy_revision DESC LIMIT 1`)
    .get(formatKind, atInstant) as { reporting_basis: ReportingBasis } | undefined;
  if (!row) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_POLICY_NOT_FOUND", 500, formatKind);
  return row.reporting_basis;
};

const calendarMonthKey = (isoInstant: string): string => isoInstant.slice(0, 7); // "YYYY-MM"

const gate = (db: Database.Database) => assertAgentReferralsOperationPermitted(agentReferralsFeatureState(db).state, "VK_ERIR_REPORTING");

export type OrdDistributionPeriodReportRow = {
  id: string;
  distribution_id: string;
  distribution_revision_id: string;
  reporting_basis: ReportingBasis;
  reporting_period_key: string;
  revision: number;
  supersedes_report_id: string | null;
  statistics_state: "ACTUAL" | "REPORTING_DATA_UNAVAILABLE";
  statistics_json: string | null;
  statistics_reason: "ORDINARY" | "ZERO_REWARD_STATISTICS" | "CONTINUING_STATISTICS";
  zero_reward_closure_id: string | null;
  operation_key: string;
  submission_state: "NOT_SUBMITTED" | "SUBMITTED" | "SUBMIT_FAILED";
  vk_operation_external_id: string | null;
  erir_code: string | null;
  evidence_ref: string | null;
  correction_reason: string | null;
  canonical_hash: string;
  created_by_admin_id: string;
  created_at: string;
};

const COLUMNS = `id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id, statistics_state, statistics_json,
  statistics_reason, zero_reward_closure_id, operation_key, submission_state, vk_operation_external_id, erir_code, evidence_ref, correction_reason, canonical_hash, created_by_admin_id, created_at`;

/** The current (highest-revision) report for an exact (distribution, period) - never rowid or created_at. */
export const currentOrdDistributionPeriodReport = (db: Database.Database, distributionId: string, reportingPeriodKey: string): OrdDistributionPeriodReportRow | null =>
  (db.prepare(`SELECT ${COLUMNS} FROM ord_distribution_period_reports WHERE distribution_id = ? AND reporting_period_key = ? ORDER BY revision DESC LIMIT 1`)
    .get(distributionId, reportingPeriodKey) as OrdDistributionPeriodReportRow | undefined) ?? null;

export const ordDistributionPeriodReportsForDistribution = (db: Database.Database, distributionId: string): OrdDistributionPeriodReportRow[] =>
  db.prepare(`SELECT ${COLUMNS} FROM ord_distribution_period_reports WHERE distribution_id = ? ORDER BY reporting_period_key ASC, revision ASC`).all(distributionId) as OrdDistributionPeriodReportRow[];

/** A real, current zero-reward closure for the exact engagement this distribution belongs to - or null. */
const currentZeroRewardClosureForDistribution = (db: Database.Database, distributionId: string): { id: string; service_period_start_at: string; service_period_end_at: string } | null =>
  (db.prepare(`SELECT z.id AS id, z.service_period_start_at AS service_period_start_at, z.service_period_end_at AS service_period_end_at
    FROM engagement_zero_reward_closures z JOIN engagement_distributions d ON d.engagement_id = z.engagement_id WHERE d.id = ?`)
    .get(distributionId) as { id: string; service_period_start_at: string; service_period_end_at: string } | undefined) ?? null;

const formatKindForDistributionRevision = (db: Database.Database, revision: DistributionRevisionRow): CreativeFormatKind => {
  if (!revision.creative_revision_id) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_FORMAT_UNRESOLVED", 409, revision.id);
  const row = db.prepare("SELECT format_kind FROM engagement_creative_revisions WHERE id = ?").get(revision.creative_revision_id) as { format_kind: CreativeFormatKind };
  return row.format_kind;
};

export type ActualStatistics = { statistics_state: "ACTUAL"; statistics_json: Record<string, unknown> };
export type UnavailableStatistics = { statistics_state: "REPORTING_DATA_UNAVAILABLE" };
export type ReportStatistics = ActualStatistics | UnavailableStatistics;

export type FileDistributionPeriodReportInput = {
  distribution_id: string;
  reporting_period_key: string;
  statistics: ReportStatistics;
  evidence_ref: string;
  /** Required for revision > 1; forbidden for revision 1 (mirrors engagement_distribution_revisions' own CHECK). */
  correction_reason?: string;
  statistics_reason?: "ZERO_REWARD_STATISTICS" | "CONTINUING_STATISTICS";
  /**
   * Manual VK submission + ERIR reconciliation evidence, when already on
   * hand at filing time. The report row is fully immutable from INSERT
   * (never UPDATEd, even to attach this) - so evidence that arrives LATER
   * for an already-filed revision is recorded by filing the NEXT revision
   * (see recordOrdDistributionPeriodReportReconciliation), never by
   * mutating this one.
   */
  submission?: { vk_operation_external_id: string; erir_code: string };
};

const canonicalReportHash = (input: {
  distribution_id: string; distribution_revision_id: string; reporting_basis: ReportingBasis; reporting_period_key: string; revision: number; statistics_state: string; statistics_json: string | null; statistics_reason: string;
}): string => sha256(canonicalV2(input as unknown as Record<string, unknown>));

/**
 * Files the NEXT revision for an exact (distribution, reporting_period_key)
 * - revision 1 if none exists yet, else current.revision + 1 with
 * `supersedes_report_id` pinned to the exact predecessor. `statistics`
 * structurally forbids ever pairing REPORTING_DATA_UNAVAILABLE with a
 * fabricated payload - the type itself has no statistics_json field in that
 * branch. `statistics_reason` defaults to ORDINARY; ZERO_REWARD_STATISTICS/
 * CONTINUING_STATISTICS additionally require a genuine current zero-reward
 * closure for this distribution's own engagement (never a fabricated
 * pretext), resolved here and re-proven independently by the migration's
 * own relational guard.
 *
 * PROVIDER_SPECIAL_PERIOD ACTUAL reporting fails closed
 * (AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_UNCONFIRMED) until L5's VK
 * representation is confirmed via the activation manifest -
 * REPORTING_DATA_UNAVAILABLE is always legal regardless, since it asserts
 * nothing about VK's field mapping.
 */
export const fileOrdDistributionPeriodReport = (db: Database.Database, admin: AdminPrincipal, input: FileDistributionPeriodReportInput): OrdDistributionPeriodReportRow => {
  const run = db.transaction((): OrdDistributionPeriodReportRow => {
    gate(db);
    const distribution = getDistribution(db, input.distribution_id);
    if (!distribution) throw new OrdReportingError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, input.distribution_id);
    const distributionRevision = currentDistributionRevision(db, input.distribution_id);
    if (!distributionRevision) throw new OrdReportingError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, input.distribution_id);

    const formatKind = formatKindForDistributionRevision(db, distributionRevision);
    const reportingBasis = resolveOrdReportingBasis(db, formatKind, distributionRevision.published_at);
    if (reportingBasis === "PROVIDER_SPECIAL_PERIOD" && input.statistics.statistics_state === "ACTUAL") {
      if (agentReferralsActivationEvidence(db, ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY) !== true) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_UNCONFIRMED", 409, formatKind);
      }
    }

    const statisticsReason = input.statistics_reason ?? "ORDINARY";
    let zeroRewardClosureId: string | null = null;
    if (statisticsReason !== "ORDINARY") {
      const closure = currentZeroRewardClosureForDistribution(db, input.distribution_id);
      if (!closure) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_CLOSURE_MISSING", 409, input.distribution_id);
      zeroRewardClosureId = closure.id;
      // ZERO_REWARD_STATISTICS is the ONE report for the closure's own
      // original contractual service month; CONTINUING_STATISTICS is any
      // later period the distribution remains accessible. Both require the
      // closure to be real (checked above); this additionally proves the
      // caller named the right reason for the period they are filing.
      const servicePeriodMonth = closure.service_period_start_at.slice(0, 7);
      const isServiceMonth = input.reporting_period_key === servicePeriodMonth;
      if (statisticsReason === "ZERO_REWARD_STATISTICS" && !isServiceMonth) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_PERIOD_MISMATCH", 409, `${input.reporting_period_key}!=${servicePeriodMonth}`);
      }
      if (statisticsReason === "CONTINUING_STATISTICS" && input.reporting_period_key <= servicePeriodMonth) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_CONTINUING_STATISTICS_NOT_LATER", 409, `${input.reporting_period_key}<=${servicePeriodMonth}`);
      }
    }

    const current = currentOrdDistributionPeriodReport(db, input.distribution_id, input.reporting_period_key);
    const nextRevision = (current?.revision ?? 0) + 1;
    if (nextRevision > 1 && !input.correction_reason?.trim()) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_CORRECTION_REASON_REQUIRED", 422);

    const statisticsJson = input.statistics.statistics_state === "ACTUAL" ? JSON.stringify(input.statistics.statistics_json) : null;
    const operationKey = ordDistributionPeriodReportOperationKey({
      distribution_id: input.distribution_id, reporting_period_key: input.reporting_period_key, revision: nextRevision, reporting_basis: reportingBasis, statistics_reason: statisticsReason, zero_reward_closure_id: zeroRewardClosureId,
    });
    const canonicalHash = canonicalReportHash({
      distribution_id: input.distribution_id, distribution_revision_id: distributionRevision.id, reporting_basis: reportingBasis, reporting_period_key: input.reporting_period_key,
      revision: nextRevision, statistics_state: input.statistics.statistics_state, statistics_json: statisticsJson, statistics_reason: statisticsReason,
    });

    const reportId = id();
    const submissionState = input.submission ? "SUBMITTED" : "NOT_SUBMITTED";
    db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id,
        statistics_state, statistics_json, statistics_reason, zero_reward_closure_id, operation_key, submission_state, vk_operation_external_id, erir_code, evidence_ref, correction_reason, canonical_hash, created_by_admin_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(reportId, input.distribution_id, distributionRevision.id, reportingBasis, input.reporting_period_key, nextRevision, current?.id ?? null,
        input.statistics.statistics_state, statisticsJson, statisticsReason, zeroRewardClosureId, operationKey, submissionState,
        input.submission?.vk_operation_external_id ?? null, input.submission?.erir_code ?? null, input.evidence_ref, input.correction_reason ?? null, canonicalHash, admin.admin_id);
    return currentOrdDistributionPeriodReport(db, input.distribution_id, input.reporting_period_key)!;
  });
  return run.immediate();
};

/**
 * Records manual VK submission + ERIR reconciliation for an
 * ALREADY-FILED report by filing the NEXT correction revision carrying the
 * identical statistics but new reconciliation evidence - filed facts are
 * never UPDATEd, even to attach this.
 */
export const recordOrdDistributionPeriodReportReconciliation = (
  db: Database.Database,
  admin: AdminPrincipal,
  distributionId: string,
  reportingPeriodKey: string,
  vkOperationExternalId: string,
  erirCode: string,
  evidenceRef: string,
): OrdDistributionPeriodReportRow => {
  const run = db.transaction((): OrdDistributionPeriodReportRow => {
    const current = currentOrdDistributionPeriodReport(db, distributionId, reportingPeriodKey);
    if (!current) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_REPORT_NOT_FOUND", 404, `${distributionId}:${reportingPeriodKey}`);
    const statistics: ReportStatistics = current.statistics_state === "ACTUAL"
      ? { statistics_state: "ACTUAL", statistics_json: JSON.parse(current.statistics_json!) }
      : { statistics_state: "REPORTING_DATA_UNAVAILABLE" };
    return fileOrdDistributionPeriodReport(db, admin, {
      distribution_id: distributionId, reporting_period_key: reportingPeriodKey, statistics, evidence_ref: evidenceRef,
      correction_reason: "ERIR reconciliation received", statistics_reason: current.statistics_reason === "ORDINARY" ? undefined : current.statistics_reason,
      submission: { vk_operation_external_id: vkOperationExternalId, erir_code: erirCode },
    });
  });
  return run.immediate();
};

export { calendarMonthKey };
