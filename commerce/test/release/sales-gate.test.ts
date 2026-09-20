import { describe, expect, it } from "vitest";
import { evaluateSalesGate, type PresentedCertificationCapability } from "../../src/release/sales-gate";
import { InMemoryCertificationCapabilityStore, issueCapability } from "../../src/certification/capability";

const now = new Date("2026-09-19T00:00:00.000Z");
const sha = "a".repeat(40);
const fenced = { emergencyClosed: false, businessClosed: false, deploymentClosed: true, deploymentSessionId: "deploy" };

const presented = (): PresentedCertificationCapability => {
  const capability = issueCapability(new InMemoryCertificationCapabilityStore(), { runId: "run", deploymentSessionId: "deploy", releaseSha: sha, maxAmountKopecks: 100, ttlMs: 300_000 }, now);
  return {
    capability,
    claim: { capabilityId: capability.id, runId: "run", nonce: capability.nonce },
    facts: { deploymentSessionId: "deploy", runtimeReleaseSha: sha, actualAmountKopecks: 100, checkoutOccurrenceId: "occ" },
    expected: { runId: "run", releaseSha: sha, occurrenceId: "occ" },
  };
};

describe("release sales gate", () => {
  it("opens only the deployment fence, and only for a capability that proves its scope", () => {
    // Certification has to transact while the release is still fenced, or it
    // certifies a system in a state no customer will ever meet.
    expect(evaluateSalesGate(fenced, now, presented())).toEqual({ open: true });
    expect(evaluateSalesGate({ ...fenced, deploymentClosed: false }, now)).toEqual({ open: true });
  });

  it("is overruled by the operator's own stop and by ordinary business gates", () => {
    // A capability that could pass the emergency gate would turn the last
    // manual stop into an advisory one.
    expect(evaluateSalesGate({ ...fenced, emergencyClosed: true }, now, presented())).toEqual({ open: false, code: "EMERGENCY_SALES_GATE_CLOSED" });
    expect(evaluateSalesGate({ ...fenced, businessClosed: true }, now, presented())).toEqual({ open: false, code: "BUSINESS_SALES_GATE_CLOSED" });
  });

  it("is closed when nothing is presented at all", () => {
    expect(evaluateSalesGate(fenced, now)).toEqual({ open: false, code: "DEPLOYMENT_SALES_GATE_CLOSED" });
  });

  it("refuses facts assembled somewhere that does not know what this gate holds shut", () => {
    expect(evaluateSalesGate({ ...fenced, deploymentSessionId: "another-session" }, now, presented()))
      .toEqual({ open: false, code: "CERTIFICATION_CONTEXT_SESSION_MISMATCH" });
  });

  it("defers every scope question to the one canonical check", () => {
    // Not a second, weaker opinion about what a capability is: the same
    // predicate the checkout admission uses, so the two cannot disagree.
    const base = presented();
    expect(evaluateSalesGate(fenced, now, { ...base, facts: { ...base.facts, runtimeReleaseSha: "b".repeat(40) } }))
      .toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_RELEASE_MISMATCH" });
    expect(evaluateSalesGate(fenced, now, { ...base, facts: { ...base.facts, checkoutOccurrenceId: "a-real-event" } }))
      .toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_SESSION_MISMATCH" });
    expect(evaluateSalesGate(fenced, now, { ...base, facts: { ...base.facts, actualAmountKopecks: 350_000 } }))
      .toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_AMOUNT_EXCEEDED" });
    expect(evaluateSalesGate(fenced, now, { ...base, expected: { ...base.expected, runId: "another-run" } }))
      .toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_RUN_MISMATCH" });
  });

  it("refuses a capability already spent or past its expiry", () => {
    const base = presented();
    expect(evaluateSalesGate(fenced, now, { ...base, capability: { ...base.capability, consumedAt: now.toISOString() } }))
      .toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_CONSUMED" });
    expect(evaluateSalesGate(fenced, new Date("2026-09-19T00:06:00.000Z"), base))
      .toEqual({ open: false, code: "CERTIFICATION_CAPABILITY_EXPIRED" });
  });

  it("spends nothing, whatever it decides", () => {
    // A capability spent at the gate and an order created afterwards is
    // exactly the pair that can come apart. Consumption stays inside the
    // checkout authority's own transaction.
    const store = new InMemoryCertificationCapabilityStore();
    const capability = issueCapability(store, { runId: "run", deploymentSessionId: "deploy", releaseSha: sha, maxAmountKopecks: 100, ttlMs: 300_000 }, now);
    const claim = { capabilityId: capability.id, runId: "run", nonce: capability.nonce };
    const facts = { deploymentSessionId: "deploy", runtimeReleaseSha: sha, actualAmountKopecks: 100, checkoutOccurrenceId: "occ" };

    expect(evaluateSalesGate(fenced, now, { capability, claim, facts, expected: { runId: "run", releaseSha: sha, occurrenceId: "occ" } })).toEqual({ open: true });

    expect(store.get(capability.id)?.consumedAt).toBeNull();
  });
});
