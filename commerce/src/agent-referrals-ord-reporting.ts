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
  review_required: 0 | 1;
  statistics_reason: "ORDINARY" | "ZERO_REWARD_STATISTICS" | "CONTINUING_STATISTICS";
  zero_reward_closure_id: string | null;
  operation_key: string;
  evidence_ref: string;
  submission_state: "NOT_SUBMITTED" | "SUBMITTED" | "SUBMIT_FAILED";
  vk_operation_external_id: string | null;
  erir_code: string | null;
  submission_evidence_ref: string | null;
  correction_reason: string | null;
  canonical_hash: string;
  created_by_admin_id: string;
  created_at: string;
};

const COLUMNS = `id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id, statistics_state, statistics_json, review_required,
  statistics_reason, zero_reward_closure_id, operation_key, evidence_ref, submission_state, vk_operation_external_id, erir_code, submission_evidence_ref, correction_reason, canonical_hash, created_by_admin_id, created_at`;

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

const formatKindForDistributionRevision = (revision: DistributionRevisionRow, db: Database.Database): CreativeFormatKind => {
  if (!revision.creative_revision_id) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_FORMAT_UNRESOLVED", 409, revision.id);
  const row = db.prepare("SELECT format_kind FROM engagement_creative_revisions WHERE id = ?").get(revision.creative_revision_id) as { format_kind: CreativeFormatKind };
  return row.format_kind;
};

/**
 * The authoritative CALENDAR_MONTH obligation set: one reporting_period_key
 * per calendar month from the distribution's own published_at through
 * min(ended_at, referenceInstantIso), inclusive. A live distribution
 * (ended_at IS NULL) keeps accruing a new obligation every month it remains
 * unclosed - that is the entire reason fileOrdDistributionPeriodReport takes
 * a period_key per call rather than once per distribution - so the horizon
 * must be capped by an explicit, caller-supplied reference instant rather
 * than this function reading the wall clock itself (integration-hardening
 * #4): the same distribution, checked twice a month apart, must give a
 * different, deterministic answer driven only by its arguments, never by
 * when the check happens to run.
 */
/**
 * Round-2: a malformed referenceInstantIso (or, defensively, a malformed
 * stored published_at/ended_at) must never silently produce an empty
 * obligation set - proven exploitable: a non-ISO reference instant made
 * startKey/endKey's split("-").map(Number) parts NaN, the while loop below
 * never ran, calendarMonthObligationSet returned [], and
 * [].every(isPeriodComplete) is vacuously true - a distribution with ZERO
 * reports ever filed reported its tail complete. This function is the
 * explicit, sole boundary that must fail closed instead.
 */
const YEAR_MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

const calendarMonthObligationSet = (publishedAt: string, endedAt: string | null, referenceInstantIso: string): string[] => {
  const startKey = calendarMonthKey(publishedAt);
  const horizonIso = endedAt !== null && endedAt < referenceInstantIso ? endedAt : referenceInstantIso;
  const endKey = calendarMonthKey(horizonIso);
  if (!YEAR_MONTH_KEY.test(startKey) || !YEAR_MONTH_KEY.test(endKey)) {
    throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_REFERENCE_INSTANT_INVALID", 422, referenceInstantIso);
  }
  if (endKey < startKey) return [startKey];
  const [startYear, startMonth] = startKey.split("-").map(Number);
  const [endYear, endMonth] = endKey.split("-").map(Number);
  const months: string[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return months;
};

/**
 * Reporting-tail-complete (P0.6/round-3 P0.2, re-derived integration-
 * hardening #4): for CALENDAR_MONTH, true only when EVERY period in the
 * authoritative obligation set above - not merely every period that
 * happens to already have a report row - has a CURRENT report with both
 * review_required = 0 (statistics resolved, never fabricated) and
 * submission_state = 'SUBMITTED'. The prior version asked only "are all
 * EXISTING report rows complete", which was trivially true whenever a
 * genuinely owed period had simply never been filed - proven: a live
 * September-published distribution with only September filed+submitted and
 * October never touched at all returned true. This version returns false
 * for that exact case once referenceInstantIso reaches October.
 *
 * PROVIDER_SPECIAL_PERIOD has no such independent derivation available: VK
 * defines the exact period-key shape/count for a special-period program,
 * and this codebase never fetches that (no provider network client - see
 * this module's own header). Round-2: "we cannot prove the obligation set"
 * is not license to answer true - the prior weaker guarantee ("every period
 * actually filed is itself complete") is exactly the same defect shape as
 * the original CALENDAR_MONTH one (a report that was simply never filed at
 * all is invisible to it), so this now fails closed unconditionally for
 * PROVIDER_SPECIAL_PERIOD: never reports the tail complete, since this
 * codebase structurally cannot know that it is.
 */
export const isOrdReportingTailComplete = (db: Database.Database, distributionId: string, referenceInstantIso: string): boolean => {
  const distributionRevision = currentDistributionRevision(db, distributionId);
  if (!distributionRevision) return false;
  const formatKind = formatKindForDistributionRevision(distributionRevision, db);
  const reportingBasis = resolveOrdReportingBasis(db, formatKind, distributionRevision.published_at);

  if (reportingBasis !== "CALENDAR_MONTH") return false;

  const isPeriodComplete = (periodKey: string): boolean => {
    const current = currentOrdDistributionPeriodReport(db, distributionId, periodKey);
    return !!current && current.review_required === 0 && current.submission_state === "SUBMITTED";
  };
  const obligations = calendarMonthObligationSet(distributionRevision.published_at, distributionRevision.ended_at, referenceInstantIso);
  return obligations.every(isPeriodComplete);
};

/** distribution_revision_id, validated to belong to distributionId - used only to re-pin a PREDECESSOR's own revision (P0.4), never to silently re-derive "current". */
const distributionRevisionByIdForDistribution = (db: Database.Database, distributionId: string, distributionRevisionId: string): DistributionRevisionRow => {
  const row = db.prepare(`SELECT id, distribution_id, revision, supersedes_revision_id, engagement_revision_id, creative_revision_id, channel_key, channel_policy_status, channel_policy_revision,
      resource_kind, resource_identifier, distribution_resource_url, published_at, ended_at, reported_by, correction_reason, evidence_ref, canonical_hash, created_at
    FROM engagement_distribution_revisions WHERE id = ? AND distribution_id = ?`).get(distributionRevisionId, distributionId) as DistributionRevisionRow | undefined;
  if (!row) throw new OrdReportingError("AGENT_REFERRALS_DISTRIBUTION_REVISION_NOT_FOUND", 404, distributionRevisionId);
  return row;
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
   * Required (only) when statistics_reason is ZERO_REWARD_STATISTICS or
   * CONTINUING_STATISTICS AND the resolved reporting_basis is
   * PROVIDER_SPECIAL_PERIOD (round-3 P0.3). The exact SHAPE and ORDER of a
   * special-period reporting_period_key is L5 PENDING_EXTERNAL_
   * CONFIRMATION, so this code can never safely compare two such keys
   * (lexicographically or otherwise) to derive "is this the closure's own
   * original service period, or a later one". Once confirmed
   * (ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY), the caller - who has
   * actually confirmed VK's real representation - asserts this directly:
   * true names the closure's own original contractual service period,
   * false names a later period the distribution remains accessible in.
   * This is never used (and must be omitted) for CALENDAR_MONTH, whose
   * ordinary lexicographic YYYY-MM comparison is confirmed in shape by law.
   */
  special_period_is_service_period?: boolean;
  /**
   * Manual VK submission + ERIR reconciliation evidence, when already on
   * hand at filing time. The report row is fully immutable from INSERT
   * (never UPDATEd, even to attach this) - so evidence that arrives LATER
   * for an already-filed revision is recorded by filing the NEXT revision
   * (see recordOrdDistributionPeriodReportReconciliation), never by
   * mutating this one.
   */
  submission?: { vk_operation_external_id: string; erir_code: string; submission_evidence_ref: string };
};

const canonicalReportHash = (input: {
  distribution_id: string; distribution_revision_id: string; reporting_basis: ReportingBasis; reporting_period_key: string; revision: number; statistics_state: string; statistics_json: string | null; statistics_reason: string;
}): string => sha256(canonicalV2(input as unknown as Record<string, unknown>));

/** Internal: shared insert path used by both fileOrdDistributionPeriodReport (resolves "current" distribution facts) and the reconciliation helper (pins the PREDECESSOR's own facts explicitly - P0.4). */
const insertReport = (
  db: Database.Database,
  admin: AdminPrincipal,
  input: FileDistributionPeriodReportInput,
  distributionRevision: DistributionRevisionRow,
  reportingBasis: ReportingBasis,
): OrdDistributionPeriodReportRow => {
  const statisticsReason = input.statistics_reason ?? "ORDINARY";
  let zeroRewardClosureId: string | null = null;
  if (statisticsReason !== "ORDINARY") {
    const closure = currentZeroRewardClosureForDistribution(db, input.distribution_id);
    if (!closure) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_CLOSURE_MISSING", 409, input.distribution_id);
    zeroRewardClosureId = closure.id;

    if (reportingBasis === "PROVIDER_SPECIAL_PERIOD") {
      // Round-3 P0.3: before L5 is confirmed, the period key's own
      // shape/order is unknown, so classification fails closed exactly
      // like ACTUAL reporting already does. Once confirmed, the caller -
      // who has actually confirmed VK's real representation - asserts the
      // ordering directly via special_period_is_service_period, never a
      // calendar-shaped string comparison this code cannot safely make.
      if (agentReferralsActivationEvidence(db, ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY) !== true) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_SPECIAL_PERIOD_UNCONFIRMED", 409, reportingBasis);
      }
      if (input.special_period_is_service_period === undefined) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_ORDER_REQUIRED", 422, statisticsReason);
      }
      if (statisticsReason === "ZERO_REWARD_STATISTICS" && input.special_period_is_service_period !== true) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_PERIOD_MISMATCH", 409, reportingBasis);
      }
      if (statisticsReason === "CONTINUING_STATISTICS" && input.special_period_is_service_period !== false) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_CONTINUING_STATISTICS_NOT_LATER", 409, reportingBasis);
      }
    } else {
      if (input.special_period_is_service_period !== undefined) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_ORDER_NOT_APPLICABLE", 422, reportingBasis);
      }
      // ZERO_REWARD_STATISTICS is the ONE report for the closure's own
      // original contractual service month; CONTINUING_STATISTICS is any
      // later period the distribution remains accessible. CALENDAR_MONTH's
      // lexicographic YYYY-MM ordering is confirmed in shape by law (L5),
      // so a direct string comparison is sound here (unlike PROVIDER_
      // SPECIAL_PERIOD above).
      const servicePeriodMonth = calendarMonthKey(closure.service_period_start_at);
      const isServiceMonth = input.reporting_period_key === servicePeriodMonth;
      if (statisticsReason === "ZERO_REWARD_STATISTICS" && !isServiceMonth) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_ZERO_REWARD_PERIOD_MISMATCH", 409, `${input.reporting_period_key}!=${servicePeriodMonth}`);
      }
      if (statisticsReason === "CONTINUING_STATISTICS" && input.reporting_period_key <= servicePeriodMonth) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_CONTINUING_STATISTICS_NOT_LATER", 409, `${input.reporting_period_key}<=${servicePeriodMonth}`);
      }
    }
  }

  const statisticsJson = input.statistics.statistics_state === "ACTUAL" ? JSON.stringify(input.statistics.statistics_json) : null;
  const submissionState = input.submission ? "SUBMITTED" : "NOT_SUBMITTED";

  // P1.3 exact-replay detection: compares the CANDIDATE's own content
  // fields directly against the CURRENT report's stored fields - never via
  // operation_key equality (operation_key identifies a ROW, and a genuine
  // correction revision can legitimately carry identical statistics to its
  // predecessor, e.g. reconciliation evidence arriving for an unchanged
  // fact - a content-only key would collide with that row on the UNIQUE
  // constraint). Nothing changed only when the statistics content, the
  // PINNED DISTRIBUTION REVISION (round-3 P0.1: a distribution fact
  // correction with byte-identical statistics is still a real correction,
  // never a replay - omitting this let D1 -> D2 silently vanish whenever an
  // operator happened to re-file the same numbers), AND whatever submission
  // evidence is being supplied are all already exactly on file.
  const current = currentOrdDistributionPeriodReport(db, input.distribution_id, input.reporting_period_key);
  const statisticsAlreadyOnFile = !!current
    && current.distribution_revision_id === distributionRevision.id
    && current.reporting_basis === reportingBasis && current.statistics_state === input.statistics.statistics_state
    && current.statistics_json === statisticsJson && current.statistics_reason === statisticsReason && current.zero_reward_closure_id === zeroRewardClosureId;
  const submissionAlreadyOnFile = !input.submission || (
    current?.submission_state === "SUBMITTED"
    && current.vk_operation_external_id === input.submission.vk_operation_external_id
    && current.erir_code === input.submission.erir_code
    && current.submission_evidence_ref === input.submission.submission_evidence_ref
  );
  if (statisticsAlreadyOnFile && submissionAlreadyOnFile) return current!; // exact semantic replay - idempotent, no new row

  const nextRevision = (current?.revision ?? 0) + 1;
  if (nextRevision > 1 && !input.correction_reason?.trim()) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_CORRECTION_REASON_REQUIRED", 422);

  const canonicalHash = canonicalReportHash({
    distribution_id: input.distribution_id, distribution_revision_id: distributionRevision.id, reporting_basis: reportingBasis, reporting_period_key: input.reporting_period_key,
    revision: nextRevision, statistics_state: input.statistics.statistics_state, statistics_json: statisticsJson, statistics_reason: statisticsReason,
  });
  const operationKey = ordDistributionPeriodReportOperationKey({
    distribution_id: input.distribution_id, reporting_period_key: input.reporting_period_key, revision: nextRevision, reporting_basis: reportingBasis,
    statistics_state: input.statistics.statistics_state, statistics_json: statisticsJson, statistics_reason: statisticsReason, zero_reward_closure_id: zeroRewardClosureId,
  });

  const reportId = id();
  db.prepare(`INSERT INTO ord_distribution_period_reports(id, distribution_id, distribution_revision_id, reporting_basis, reporting_period_key, revision, supersedes_report_id,
      statistics_state, statistics_json, statistics_reason, zero_reward_closure_id, operation_key, evidence_ref, submission_state, vk_operation_external_id, erir_code, submission_evidence_ref, correction_reason, canonical_hash, created_by_admin_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(reportId, input.distribution_id, distributionRevision.id, reportingBasis, input.reporting_period_key, nextRevision, current?.id ?? null,
      input.statistics.statistics_state, statisticsJson, statisticsReason, zeroRewardClosureId, operationKey, input.evidence_ref, submissionState,
      input.submission?.vk_operation_external_id ?? null, input.submission?.erir_code ?? null, input.submission?.submission_evidence_ref ?? null, input.correction_reason ?? null, canonicalHash, admin.admin_id);
  return currentOrdDistributionPeriodReport(db, input.distribution_id, input.reporting_period_key)!;
};

/**
 * Files the NEXT revision for an exact (distribution, reporting_period_key)
 * - revision 1 if none exists yet, else current.revision + 1 with
 * `supersedes_report_id` pinned to the exact predecessor - UNLESS the
 * filing is an exact semantic replay of the current revision, in which
 * case it is returned unchanged (P1.3). `statistics` structurally forbids
 * ever pairing REPORTING_DATA_UNAVAILABLE with a fabricated payload - the
 * type itself has no statistics_json field in that branch.
 * `statistics_reason` defaults to ORDINARY; ZERO_REWARD_STATISTICS/
 * CONTINUING_STATISTICS additionally require a genuine current zero-reward
 * closure for this distribution's own engagement (never a fabricated
 * pretext) and a CALENDAR_MONTH reporting basis (P0.5) - never a
 * PROVIDER_SPECIAL_PERIOD one, whose exact period-key shape is still
 * unconfirmed.
 *
 * PROVIDER_SPECIAL_PERIOD ACTUAL reporting fails closed
 * (AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_UNCONFIRMED) until L5's VK
 * representation is confirmed via the activation manifest -
 * REPORTING_DATA_UNAVAILABLE is always legal regardless, since it asserts
 * nothing about VK's field mapping. This always resolves against the
 * distribution's CURRENT facts - a report reconciled against a since-
 * corrected distribution revision must go through
 * recordOrdDistributionPeriodReportReconciliation instead, which pins the
 * predecessor's own revision explicitly (P0.4).
 */
export const fileOrdDistributionPeriodReport = (db: Database.Database, admin: AdminPrincipal, input: FileDistributionPeriodReportInput): OrdDistributionPeriodReportRow => {
  const run = db.transaction((): OrdDistributionPeriodReportRow => {
    gate(db);
    const distribution = getDistribution(db, input.distribution_id);
    if (!distribution) throw new OrdReportingError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, input.distribution_id);
    const distributionRevision = currentDistributionRevision(db, input.distribution_id);
    if (!distributionRevision) throw new OrdReportingError("AGENT_REFERRALS_DISTRIBUTION_NOT_FOUND", 404, input.distribution_id);

    const formatKind = formatKindForDistributionRevision(distributionRevision, db);
    const reportingBasis = resolveOrdReportingBasis(db, formatKind, distributionRevision.published_at);
    if (reportingBasis === "PROVIDER_SPECIAL_PERIOD" && input.statistics.statistics_state === "ACTUAL") {
      if (agentReferralsActivationEvidence(db, ORD_PROVIDER_SPECIAL_PERIOD_CONFIRMED_KEY) !== true) {
        throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_SPECIAL_PERIOD_UNCONFIRMED", 409, formatKind);
      }
    }
    return insertReport(db, admin, input, distributionRevision, reportingBasis);
  });
  return run.immediate();
};

/**
 * Records manual VK submission + ERIR reconciliation for an
 * ALREADY-FILED report by filing the NEXT correction revision carrying the
 * PREDECESSOR's own exact distribution_revision_id and reporting_basis
 * (P0.4 fix) - never re-resolving "current" distribution facts, which
 * would silently re-describe an old, already-filed report as if it had
 * always been about a distribution fact corrected AFTER the report was
 * filed. If the distribution's facts have genuinely been corrected since,
 * that is a SEPARATE, explicit report correction against the new facts -
 * never an implicit side effect of reconciling evidence for the old one.
 */
export const recordOrdDistributionPeriodReportReconciliation = (
  db: Database.Database,
  admin: AdminPrincipal,
  distributionId: string,
  reportingPeriodKey: string,
  vkOperationExternalId: string,
  erirCode: string,
  submissionEvidenceRef: string,
): OrdDistributionPeriodReportRow => {
  const run = db.transaction((): OrdDistributionPeriodReportRow => {
    gate(db);
    const current = currentOrdDistributionPeriodReport(db, distributionId, reportingPeriodKey);
    if (!current) throw new OrdReportingError("AGENT_REFERRALS_ORD_REPORTING_REPORT_NOT_FOUND", 404, `${distributionId}:${reportingPeriodKey}`);
    const pinnedRevision = distributionRevisionByIdForDistribution(db, distributionId, current.distribution_revision_id);
    const statistics: ReportStatistics = current.statistics_state === "ACTUAL"
      ? { statistics_state: "ACTUAL", statistics_json: JSON.parse(current.statistics_json!) }
      : { statistics_state: "REPORTING_DATA_UNAVAILABLE" };
    // Round-4 P0.3: the CURRENT row already passed insertReport's own
    // special_period_is_service_period validation once, at its own filing
    // time - re-deriving the identical assertion from its already-pinned
    // statistics_reason (never re-asking the caller, who has no new
    // ordering fact to supply for a reconciliation) is what lets a
    // PROVIDER_SPECIAL_PERIOD zero/continuing report ever reach VK
    // submission + ERIR reconciliation at all. Omitting this reintroduced
    // exactly the P0.3 dead-end this round closes: a valid confirmed
    // special-period report could never complete its reporting tail.
    const specialPeriodIsServicePeriod = current.reporting_basis === "PROVIDER_SPECIAL_PERIOD" && current.statistics_reason !== "ORDINARY"
      ? current.statistics_reason === "ZERO_REWARD_STATISTICS"
      : undefined;
    return insertReport(
      db, admin,
      {
        distribution_id: distributionId, reporting_period_key: reportingPeriodKey, statistics, evidence_ref: current.evidence_ref,
        correction_reason: "ERIR reconciliation received", statistics_reason: current.statistics_reason === "ORDINARY" ? undefined : current.statistics_reason,
        special_period_is_service_period: specialPeriodIsServicePeriod,
        submission: { vk_operation_external_id: vkOperationExternalId, erir_code: erirCode, submission_evidence_ref: submissionEvidenceRef },
      },
      pinnedRevision, current.reporting_basis,
    );
  });
  return run.immediate();
};

export { calendarMonthKey };
