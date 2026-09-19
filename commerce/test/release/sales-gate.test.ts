import { describe, expect, it } from "vitest";
import { consumeCertificationCapability, evaluateSalesGate, type CertificationCapability } from "../../src/release/sales-gate";

const now = new Date("2026-09-19T00:00:00.000Z");
const capability: CertificationCapability = { id: "cap", deploymentSessionId: "deploy", expiresAt: "2026-09-19T00:05:00.000Z" };

describe("release sales gate", () => {
  it("permits a valid certification capability through only the deployment fence", () => {
    expect(evaluateSalesGate({ emergencyClosed: false, businessClosed: false, deploymentClosed: true, deploymentSessionId: "deploy" }, now, capability).open).toBe(true);
    expect(evaluateSalesGate({ emergencyClosed: true, businessClosed: false, deploymentClosed: true, deploymentSessionId: "deploy" }, now, capability)).toEqual({ open: false, code: "EMERGENCY_SALES_GATE_CLOSED" });
    expect(evaluateSalesGate({ emergencyClosed: false, businessClosed: true, deploymentClosed: true, deploymentSessionId: "deploy" }, now, capability)).toEqual({ open: false, code: "BUSINESS_SALES_GATE_CLOSED" });
  });

  it("does not allow a capability to be reused or applied to another deployment", () => {
    const consumed = consumeCertificationCapability(capability, now);
    expect(evaluateSalesGate({ emergencyClosed: false, businessClosed: false, deploymentClosed: true, deploymentSessionId: "deploy" }, now, consumed)).toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_INVALID" });
    expect(evaluateSalesGate({ emergencyClosed: false, businessClosed: false, deploymentClosed: true, deploymentSessionId: "other" }, now, capability)).toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_INVALID" });
  });
});
