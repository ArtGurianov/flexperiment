import { describe, expect, it } from "vitest";
import {
  CertificationCapabilityError, InMemoryCertificationCapabilityStore, authorizationDefect, issueCapability,
  type TrustedCheckoutFacts,
} from "../../src/certification/capability";

const now = new Date("2026-09-19T00:00:00.000Z");
const sha = "a".repeat(40);
const scope = { runId: "run", deploymentSessionId: "deploy", releaseSha: sha, maxAmountKopecks: 100, ttlMs: 300_000 };
const facts: TrustedCheckoutFacts = { deploymentSessionId: "deploy", runtimeReleaseSha: sha, actualAmountKopecks: 100, checkoutOccurrenceId: "occ" };
const expected = { runId: "run", releaseSha: sha, occurrenceId: "occ" };

describe("certification capability", () => {
  it("admits possession only when three views of the release agree", () => {
    // What the capability was issued against, what the runtime is serving, and
    // what the run set out to certify. Any disagreement means one of them moved.
    const store = new InMemoryCertificationCapabilityStore();
    const capability = issueCapability(store, scope, now);
    const claim = { capabilityId: capability.id, runId: "run", nonce: capability.nonce };

    expect(authorizationDefect(capability, claim, facts, expected, now)).toBeUndefined();
    expect(authorizationDefect(capability, claim, { ...facts, runtimeReleaseSha: "b".repeat(40) }, expected, now)).toBe("CERTIFICATION_CAPABILITY_RELEASE_MISMATCH");
    expect(authorizationDefect(capability, claim, facts, { ...expected, releaseSha: "b".repeat(40) }, now)).toBe("CERTIFICATION_CAPABILITY_RELEASE_MISMATCH");
  });

  it("names the defect rather than only refusing", () => {
    // An expired capability is reissued and the run continues; a runtime on a
    // different revision means production moved and the run must not continue
    // at all. A single boolean cannot tell those apart.
    const store = new InMemoryCertificationCapabilityStore();
    const capability = issueCapability(store, scope, now);
    const claim = { capabilityId: capability.id, runId: "run", nonce: capability.nonce };

    expect(authorizationDefect(capability, { ...claim, nonce: "not-the-nonce" }, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_NONCE_MISMATCH");
    expect(authorizationDefect(capability, { ...claim, runId: "another" }, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_RUN_MISMATCH");
    expect(authorizationDefect(undefined, claim, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_NOT_FOUND");
    expect(authorizationDefect({ ...capability, consumedAt: now.toISOString() }, claim, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_CONSUMED");
    expect(authorizationDefect(capability, claim, facts, expected, new Date("2026-09-19T00:05:00.000Z"))).toBe("CERTIFICATION_CAPABILITY_EXPIRED");
  });

  it("refuses to put a second live capability behind the same fence", () => {
    // Whoever still holds the forgotten one decides when to use it.
    const store = new InMemoryCertificationCapabilityStore();
    issueCapability(store, scope, now);
    expect(() => issueCapability(store, scope, now)).toThrow("CERTIFICATION_CAPABILITY_ALREADY_LIVE");
    expect(() => issueCapability(store, scope, new Date("2026-09-19T01:00:00.000Z"))).not.toThrow();
  });

  it("will not issue an unbounded or unscoped permission", () => {
    const store = new InMemoryCertificationCapabilityStore();
    expect(() => issueCapability(store, { ...scope, releaseSha: "" }, now)).toThrow(CertificationCapabilityError);
    expect(() => issueCapability(store, { ...scope, maxAmountKopecks: 0 }, now)).toThrow("CERTIFICATION_CAPABILITY_AMOUNT_INVALID");
    expect(() => issueCapability(store, { ...scope, ttlMs: 0 }, now)).toThrow("CERTIFICATION_CAPABILITY_TTL_INVALID");
  });
});
