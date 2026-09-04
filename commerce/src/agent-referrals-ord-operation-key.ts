import { canonicalV2, sha256 } from "./crypto";

/**
 * The ONE canonical operation_key / payload-hash formula for every PR8 ORD
 * operation - reused identically by runtime writers and by tests, per the
 * repo's "no duplicate formula/serializer implementation between runtime
 * and tests" convention. Every key is derived ONLY from pinned immutable
 * local authority (never from a nullable provider-observed id such as
 * vk_external_id/vk_object_id/erid, which do not exist yet at mint time and
 * must never gate or vary this key once they arrive) - the same semantic
 * operation always produces the same key, and a changed semantic authority
 * always produces a different one.
 *
 * `revision` IS included in every key below, including the distribution-
 * period-report one: `operation_key` identifies this exact ROW (globally
 * UNIQUE at the DB level, one per actual revision ever filed), never a
 * content-only fingerprint - a genuine correction revision can legitimately
 * carry IDENTICAL statistics to its predecessor (e.g. ERIR reconciliation
 * arriving for an unchanged fact), which a revision-less "same content ->
 * same key" scheme would collide on. Exact-replay detection (P1.3:
 * "retrying the identical filing is idempotent, not a new revision") is a
 * SEPARATE concern, handled by fileOrdDistributionPeriodReport comparing
 * the candidate's own content fields directly against the CURRENT report's
 * stored fields - never by reusing this key for double duty.
 */

export const ordProviderOperationKey = (input: {
  operation_kind: string;
  revision: number;
  provider_profile_revision_id: string;
}): string => sha256(canonicalV2({ op: "ORD_PROVIDER_OPERATION", ...input }));

export const ordCreativeRegistrationOperationKey = (input: {
  creative_revision_id: string;
  revision: number;
  provider_counterparty_profile_id: string;
  provider_contract_profile_id: string;
}): string => sha256(canonicalV2({ op: "ORD_CREATIVE_REGISTRATION", ...input }));

export const ordDistributionPeriodReportOperationKey = (input: {
  distribution_id: string;
  reporting_period_key: string;
  revision: number;
  reporting_basis: string;
  statistics_state: string;
  statistics_json: string | null;
  statistics_reason: string;
  zero_reward_closure_id: string | null;
  submission_state: string;
  vk_operation_external_id: string | null;
  erir_code: string | null;
}): string => sha256(canonicalV2({ op: "ORD_DISTRIBUTION_PERIOD_REPORT", ...input }));

export const ordPaidInvoicePayloadOperationKey = (input: {
  act_id: string;
  settlement_id: string;
  accepted_amount_kopecks: number;
  accepted_engagement_revision_id: string;
  provider_contract_profile_id: string;
}): string => sha256(canonicalV2({ op: "ORD_PAID_INVOICE_PAYLOAD", ...input }));
