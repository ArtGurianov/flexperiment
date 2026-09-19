export type SalesGateState = {
  readonly emergencyClosed: boolean;
  readonly deploymentClosed: boolean;
  readonly businessClosed: boolean;
  readonly deploymentSessionId?: string | null;
};

export type CertificationCapability = {
  readonly id: string;
  readonly deploymentSessionId: string;
  readonly expiresAt: string;
  readonly consumedAt?: string | null;
};

export type SalesGateDecision =
  | { readonly open: true; readonly capability?: CertificationCapability }
  | { readonly open: false; readonly code: "EMERGENCY_SALES_GATE_CLOSED" | "BUSINESS_SALES_GATE_CLOSED" | "DEPLOYMENT_SALES_GATE_CLOSED" | "CERTIFICATION_CAPABILITY_INVALID" };

const isUsableCapability = (capability: CertificationCapability | undefined, state: SalesGateState, now: Date): capability is CertificationCapability => {
  if (!capability || capability.consumedAt || !state.deploymentSessionId || capability.deploymentSessionId !== state.deploymentSessionId) return false;
  const expiresAt = Date.parse(capability.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
};

/** A capability can bypass a deployment fence only; emergency and business gates always win. */
export const evaluateSalesGate = (state: SalesGateState, now: Date, capability?: CertificationCapability): SalesGateDecision => {
  if (state.emergencyClosed) return { open: false, code: "EMERGENCY_SALES_GATE_CLOSED" };
  if (state.businessClosed) return { open: false, code: "BUSINESS_SALES_GATE_CLOSED" };
  if (!state.deploymentClosed) return { open: true };
  if (!capability) return { open: false, code: "DEPLOYMENT_SALES_GATE_CLOSED" };
  if (!isUsableCapability(capability, state, now)) return { open: false, code: "CERTIFICATION_CAPABILITY_INVALID" };
  return { open: true, capability };
};

export const consumeCertificationCapability = (capability: CertificationCapability, consumedAt: Date): CertificationCapability => {
  if (capability.consumedAt) throw new Error("CERTIFICATION_CAPABILITY_ALREADY_CONSUMED");
  if (Date.parse(capability.expiresAt) <= consumedAt.getTime()) throw new Error("CERTIFICATION_CAPABILITY_EXPIRED");
  return { ...capability, consumedAt: consumedAt.toISOString() };
};
