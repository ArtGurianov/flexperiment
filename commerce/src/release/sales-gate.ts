import {
  authorizationDefect,
  type CapabilityDefect, type CertificationCapability, type CertificationClaim, type TrustedCheckoutFacts,
} from "../certification/capability";

export type SalesGateState = {
  readonly emergencyClosed: boolean;
  readonly deploymentClosed: boolean;
  readonly businessClosed: boolean;
  readonly deploymentSessionId?: string | null;
};

/**
 * Everything the one canonical check needs, gathered where each part is
 * authoritative.
 *
 * The claim is the only piece a caller supplies. The facts are derived by the
 * server - its own runtime identity, its own fence, and the price and
 * occurrence this quote actually resolves to. The expectation is read from the
 * durable certification run. A caller able to supply the last two would be
 * telling the gate what to compare against, which is not a gate.
 */
export type PresentedCertificationCapability = {
  readonly capability: CertificationCapability;
  readonly claim: CertificationClaim;
  readonly facts: TrustedCheckoutFacts;
  readonly expected: {
    readonly runId: string;
    readonly releaseSha: string;
    readonly occurrenceId?: string | null;
  };
};

export type SalesGateDecision =
  | { readonly open: true }
  | { readonly open: false; readonly code: "EMERGENCY_SALES_GATE_CLOSED" | "BUSINESS_SALES_GATE_CLOSED" | "DEPLOYMENT_SALES_GATE_CLOSED" | "CERTIFICATION_CONTEXT_SESSION_MISMATCH" | CapabilityDefect };

/**
 * Whether a closed gate may be passed at all, and the ordering is the point.
 *
 * The emergency gate is an operator's own switch and is answered first and
 * unconditionally: a capability that could pass it would turn the last manual
 * stop into an advisory one. Business gates come next, because a certification
 * that bought a seat nobody is allowed to sell has certified the wrong system.
 * Only the deployment fence - which this same release closed, minutes ago, for
 * its own convergence - is something a scoped, expiring, single-use permission
 * may open.
 *
 * This is a question, not an act. It decides nothing about the capability's
 * lifetime and spends nothing: consumption belongs inside the checkout
 * authority's own transaction, together with the order it admits, because a
 * capability spent at the gate and an order created afterwards is exactly the
 * pair that can come apart.
 *
 * It owns no definition of a capability either. There is one scope check in
 * the system, `authorizationDefect`, and this defers to it rather than keeping
 * a weaker copy that would quietly disagree.
 */
export const evaluateSalesGate = (state: SalesGateState, now: Date, presented?: PresentedCertificationCapability): SalesGateDecision => {
  if (state.emergencyClosed) return { open: false, code: "EMERGENCY_SALES_GATE_CLOSED" };
  if (state.businessClosed) return { open: false, code: "BUSINESS_SALES_GATE_CLOSED" };
  if (!state.deploymentClosed) return { open: true };
  if (!presented) return { open: false, code: "DEPLOYMENT_SALES_GATE_CLOSED" };
  // The facts have to describe exactly the fence being bypassed, or they were
  // assembled somewhere that does not know what this gate is holding shut.
  if (presented.facts.deploymentSessionId !== (state.deploymentSessionId ?? "")) return { open: false, code: "CERTIFICATION_CONTEXT_SESSION_MISMATCH" };

  const defect = authorizationDefect(presented.capability, presented.claim, presented.facts, presented.expected, now);
  return defect ? { open: false, code: defect } : { open: true };
};
