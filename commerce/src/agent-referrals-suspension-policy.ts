/**
 * The single authoritative source distinguishing NEW_AUTHORITY operations
 * (blocked while global Agent Referrals state is SUSPENDED) from
 * MATURATION / RECOVERY / REPORTING_TAIL operations (which SUSPENDED must
 * continue to permit for obligations that arose before suspension), per
 * plan section B-8.
 *
 * Most of the named operation classes below have no command yet - they
 * belong to PR4 through PR8. Pinning them here now, as data rather than
 * scattered `if (state === ...)` checks in future PRs, is what keeps a
 * later addition from silently inverting an operation's class: any PR that
 * introduces one of these operations imports its classification from here
 * rather than deciding it locally.
 */

export type AgentReferralsFeatureStateName = "DORMANT" | "ACTIVE" | "SUSPENDED";

export type AgentReferralsOperationClass =
  // NEW_AUTHORITY - blocked by SUSPENDED.
  | "NEW_PARTNER_PROVISIONING"
  | "FRAMEWORK_ACCEPTANCE"
  | "ENGAGEMENT_OFFER"
  | "ENGAGEMENT_ACCEPTANCE"
  | "ENGAGEMENT_ACTIVATION"
  | "NEW_PUBLICATION_AUTHORITY"
  | "NEW_ATTRIBUTION"
  | "ORD_CREATIVE_REGISTRATION"
  // MATURATION / RECOVERY / REPORTING_TAIL - permitted under SUSPENDED.
  | "PORTAL_ACCESS_AND_EVIDENCE_EXPORT"
  | "DISTRIBUTION_FACT_REPORTING"
  | "PUBLICATION_REMOVAL"
  | "REMOVAL_VERIFICATION"
  | "FINANCIAL_EVIDENCE_SYNCHRONIZATION"
  | "REWARD_REGISTRY_FINALIZATION"
  | "ZERO_REWARD_CLOSED"
  | "SETTLEMENT_PREPARED"
  | "ACT_GENERATION"
  | "ACT_PRESENTATION"
  | "ACT_ACCEPTANCE"
  | "ACT_DISPUTE"
  | "PAYMENT_AUTHORIZATION"
  | "PAYMENT_EXECUTION"
  | "PAYMENT_RECONCILIATION"
  | "NPD_STATUS_PROCESSING"
  | "NPD_RECEIPT_PROCESSING"
  | "REFUND_PROCESSING"
  | "CORRECTION_LINEAGE"
  | "RECOVERY_RECONCILIATION"
  | "VK_ERIR_REPORTING"
  | "DELEGATION_REVOCATION"
  | "REPORTING_TAIL_PROCESSING";

export type AgentReferralsOperationPolicyCategory = "NEW_AUTHORITY" | "MATURATION_RECOVERY_REPORTING_TAIL";

/** Exhaustive by construction: TypeScript enforces every AgentReferralsOperationClass has an entry. */
export const AGENT_REFERRALS_OPERATION_POLICY: Readonly<Record<AgentReferralsOperationClass, AgentReferralsOperationPolicyCategory>> = {
  NEW_PARTNER_PROVISIONING: "NEW_AUTHORITY",
  FRAMEWORK_ACCEPTANCE: "NEW_AUTHORITY",
  ENGAGEMENT_OFFER: "NEW_AUTHORITY",
  ENGAGEMENT_ACCEPTANCE: "NEW_AUTHORITY",
  ENGAGEMENT_ACTIVATION: "NEW_AUTHORITY",
  NEW_PUBLICATION_AUTHORITY: "NEW_AUTHORITY",
  NEW_ATTRIBUTION: "NEW_AUTHORITY",
  // Registering (or completing an already-started registration of) a
  // creative with the ORD provider is still minting authority that does not
  // yet exist as a filed fact - the same class as authorizeCreative itself.
  // SUSPENDED must not let an in-progress registration silently complete
  // into a locked, ERID-bearing fact (plan Phase 8 / §B-4: "the first real
  // VK/ERIR business fact stays prohibited before global ACTIVE").
  ORD_CREATIVE_REGISTRATION: "NEW_AUTHORITY",

  PORTAL_ACCESS_AND_EVIDENCE_EXPORT: "MATURATION_RECOVERY_REPORTING_TAIL",
  DISTRIBUTION_FACT_REPORTING: "MATURATION_RECOVERY_REPORTING_TAIL",
  PUBLICATION_REMOVAL: "MATURATION_RECOVERY_REPORTING_TAIL",
  REMOVAL_VERIFICATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  FINANCIAL_EVIDENCE_SYNCHRONIZATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  REWARD_REGISTRY_FINALIZATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  ZERO_REWARD_CLOSED: "MATURATION_RECOVERY_REPORTING_TAIL",
  SETTLEMENT_PREPARED: "MATURATION_RECOVERY_REPORTING_TAIL",
  ACT_GENERATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  ACT_PRESENTATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  ACT_ACCEPTANCE: "MATURATION_RECOVERY_REPORTING_TAIL",
  ACT_DISPUTE: "MATURATION_RECOVERY_REPORTING_TAIL",
  PAYMENT_AUTHORIZATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  PAYMENT_EXECUTION: "MATURATION_RECOVERY_REPORTING_TAIL",
  PAYMENT_RECONCILIATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  NPD_STATUS_PROCESSING: "MATURATION_RECOVERY_REPORTING_TAIL",
  NPD_RECEIPT_PROCESSING: "MATURATION_RECOVERY_REPORTING_TAIL",
  REFUND_PROCESSING: "MATURATION_RECOVERY_REPORTING_TAIL",
  CORRECTION_LINEAGE: "MATURATION_RECOVERY_REPORTING_TAIL",
  RECOVERY_RECONCILIATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  VK_ERIR_REPORTING: "MATURATION_RECOVERY_REPORTING_TAIL",
  DELEGATION_REVOCATION: "MATURATION_RECOVERY_REPORTING_TAIL",
  REPORTING_TAIL_PROCESSING: "MATURATION_RECOVERY_REPORTING_TAIL",
};

export class AgentReferralsSuspensionPolicyError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/**
 * DORMANT permits nothing - the feature has not activated, so no production
 * Agent Referrals authority of any class exists yet. ACTIVE permits every
 * class. SUSPENDED permits only MATURATION_RECOVERY_REPORTING_TAIL classes.
 */
export const isAgentReferralsOperationPermitted = (
  state: AgentReferralsFeatureStateName,
  operationClass: AgentReferralsOperationClass,
): boolean => {
  if (state === "DORMANT") return false;
  if (state === "ACTIVE") return true;
  return AGENT_REFERRALS_OPERATION_POLICY[operationClass] === "MATURATION_RECOVERY_REPORTING_TAIL";
};

export const assertAgentReferralsOperationPermitted = (
  state: AgentReferralsFeatureStateName,
  operationClass: AgentReferralsOperationClass,
): void => {
  if (isAgentReferralsOperationPermitted(state, operationClass)) return;
  const code = state === "DORMANT" ? "AGENT_REFERRALS_FEATURE_DORMANT" : "AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY";
  throw new AgentReferralsSuspensionPolicyError(code, 409, operationClass);
};
