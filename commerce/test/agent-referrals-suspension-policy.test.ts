import { describe, expect, it } from "vitest";
import {
  AGENT_REFERRALS_OPERATION_POLICY,
  AgentReferralsSuspensionPolicyError,
  assertAgentReferralsOperationPermitted,
  isAgentReferralsOperationPermitted,
  type AgentReferralsOperationClass,
} from "../src/agent-referrals-suspension-policy";

/**
 * Pins the full frozen §B-8 vocabulary in one matrix so a future PR adding
 * an operation class must add it here too, rather than deciding its
 * suspension behaviour locally at the call site.
 */
const NEW_AUTHORITY_CLASSES: AgentReferralsOperationClass[] = [
  "NEW_PARTNER_PROVISIONING",
  "FRAMEWORK_ACCEPTANCE",
  "ENGAGEMENT_OFFER",
  "ENGAGEMENT_ACCEPTANCE",
  "ENGAGEMENT_ACTIVATION",
  "NEW_PUBLICATION_AUTHORITY",
  "NEW_ATTRIBUTION",
  "ORD_CREATIVE_REGISTRATION",
  "ORD_PROVIDER_OPERATION",
];

const MATURATION_CLASSES: AgentReferralsOperationClass[] = [
  "PORTAL_ACCESS_AND_EVIDENCE_EXPORT",
  "DISTRIBUTION_FACT_REPORTING",
  "PUBLICATION_REMOVAL",
  "REMOVAL_VERIFICATION",
  "FINANCIAL_EVIDENCE_SYNCHRONIZATION",
  "REWARD_REGISTRY_FINALIZATION",
  "ZERO_REWARD_CLOSED",
  "SETTLEMENT_PREPARED",
  "ACT_GENERATION",
  "ACT_PRESENTATION",
  "ACT_ACCEPTANCE",
  "ACT_DISPUTE",
  "PAYMENT_AUTHORIZATION",
  "PAYMENT_EXECUTION",
  "PAYMENT_RECONCILIATION",
  "NPD_STATUS_PROCESSING",
  "NPD_RECEIPT_PROCESSING",
  "REFUND_PROCESSING",
  "CORRECTION_LINEAGE",
  "RECOVERY_RECONCILIATION",
  "VK_ERIR_REPORTING",
  "DELEGATION_REVOCATION",
  "REPORTING_TAIL_PROCESSING",
];

describe("agent-referrals suspension policy", () => {
  it("the matrix here is exhaustive over every declared operation class", () => {
    const allDeclared = Object.keys(AGENT_REFERRALS_OPERATION_POLICY).sort();
    const allPinned = [...NEW_AUTHORITY_CLASSES, ...MATURATION_CLASSES].sort();
    expect(allPinned).toEqual(allDeclared);
    expect(new Set(allPinned).size).toBe(allPinned.length); // no duplicates
  });

  describe("SUSPENDED", () => {
    it.each(NEW_AUTHORITY_CLASSES)("blocks %s", (operationClass) => {
      expect(isAgentReferralsOperationPermitted("SUSPENDED", operationClass)).toBe(false);
      expect(() => assertAgentReferralsOperationPermitted("SUSPENDED", operationClass)).toThrow(AgentReferralsSuspensionPolicyError);
    });

    it.each(MATURATION_CLASSES)("allows %s", (operationClass) => {
      expect(isAgentReferralsOperationPermitted("SUSPENDED", operationClass)).toBe(true);
      expect(() => assertAgentReferralsOperationPermitted("SUSPENDED", operationClass)).not.toThrow();
    });

    it("throws the specific blocking code for a NEW_AUTHORITY class", () => {
      let thrown: unknown;
      try { assertAgentReferralsOperationPermitted("SUSPENDED", "NEW_ATTRIBUTION"); } catch (error) { thrown = error; }
      expect((thrown as AgentReferralsSuspensionPolicyError).code).toBe("AGENT_REFERRALS_SUSPENDED_BLOCKS_NEW_AUTHORITY");
    });
  });

  describe("ACTIVE", () => {
    it.each([...NEW_AUTHORITY_CLASSES, ...MATURATION_CLASSES])("permits %s", (operationClass) => {
      expect(isAgentReferralsOperationPermitted("ACTIVE", operationClass)).toBe(true);
      expect(() => assertAgentReferralsOperationPermitted("ACTIVE", operationClass)).not.toThrow();
    });
  });

  describe("DORMANT", () => {
    it.each([...NEW_AUTHORITY_CLASSES, ...MATURATION_CLASSES])("permits nothing: %s is refused", (operationClass) => {
      expect(isAgentReferralsOperationPermitted("DORMANT", operationClass)).toBe(false);
      let thrown: unknown;
      try { assertAgentReferralsOperationPermitted("DORMANT", operationClass); } catch (error) { thrown = error; }
      expect((thrown as AgentReferralsSuspensionPolicyError).code).toBe("AGENT_REFERRALS_FEATURE_DORMANT");
    });
  });
});
