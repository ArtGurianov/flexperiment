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
 */

export const ordCreativeRegistrationOperationKey = (input: {
  creative_revision_id: string;
  provider_counterparty_profile_id: string;
  provider_contract_profile_id: string;
}): string => sha256(canonicalV2({ op: "ORD_CREATIVE_REGISTRATION", ...input }));

export const ordDistributionPeriodReportOperationKey = (input: {
  distribution_id: string;
  reporting_period_key: string;
  revision: number;
  reporting_basis: string;
  statistics_reason: string;
  zero_reward_closure_id: string | null;
}): string => sha256(canonicalV2({ op: "ORD_DISTRIBUTION_PERIOD_REPORT", ...input }));

export const ordPaidInvoicePayloadOperationKey = (input: {
  act_id: string;
  settlement_id: string;
  accepted_amount_kopecks: number;
  accepted_engagement_revision_id: string;
}): string => sha256(canonicalV2({ op: "ORD_PAID_INVOICE_PAYLOAD", ...input }));
