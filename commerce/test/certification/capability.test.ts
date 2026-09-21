import { describe, expect, it } from "vitest";
import {
  CertificationCapabilityError, authorizationDefect, issueCapability,
  type TrustedCheckoutFacts,
} from "../../src/certification/capability";
import { certificationCapabilityStores } from "../support/certification-stores";
import { testSecret } from "../support/certification-secret";

const now = new Date("2026-09-19T00:00:00.000Z");
const sha = "a".repeat(40);
const scope = { runId: "run", deploymentSessionId: "deploy", releaseSha: sha, maxAmountKopecks: 100, ttlMs: 300_000 };
const facts: TrustedCheckoutFacts = { deploymentSessionId: "deploy", runtimeReleaseSha: sha, actualAmountKopecks: 100, checkoutOccurrenceId: "occ" };
const expected = { runId: "run", releaseSha: sha, occurrenceId: "occ" };

describe.each(certificationCapabilityStores)("certification capability (%s)", (_name, makeFixture) => {
  it("admits possession only when three views of the release agree", () => {
    // What the capability was issued against, what the runtime is serving, and
    // what the run set out to certify. Any disagreement means one of them moved.
    const { store, bind } = makeFixture();
    bind("run", "deploy");
    const { capability, nonce } = issueCapability(store, scope, now, testSecret());
    const claim = { capabilityId: capability.id, runId: "run", nonce };

    expect(authorizationDefect(capability, claim, facts, expected, now)).toBeUndefined();
    expect(authorizationDefect(capability, claim, { ...facts, runtimeReleaseSha: "b".repeat(40) }, expected, now)).toBe("CERTIFICATION_CAPABILITY_RELEASE_MISMATCH");
    expect(authorizationDefect(capability, claim, facts, { ...expected, releaseSha: "b".repeat(40) }, now)).toBe("CERTIFICATION_CAPABILITY_RELEASE_MISMATCH");
  });

  it("names the defect rather than only refusing", () => {
    // An expired capability is reissued and the run continues; a runtime on a
    // different revision means production moved and the run must not continue
    // at all. A single boolean cannot tell those apart.
    const { store, bind } = makeFixture();
    bind("run", "deploy");
    const { capability, nonce } = issueCapability(store, scope, now, testSecret());
    const claim = { capabilityId: capability.id, runId: "run", nonce };

    expect(authorizationDefect(capability, { ...claim, nonce: "not-the-nonce" }, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_NONCE_MISMATCH");
    expect(authorizationDefect(capability, { ...claim, runId: "another" }, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_RUN_MISMATCH");
    expect(authorizationDefect(undefined, claim, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_NOT_FOUND");
    expect(authorizationDefect({ ...capability, consumedAt: now.toISOString() }, claim, facts, expected, now)).toBe("CERTIFICATION_CAPABILITY_CONSUMED");
    expect(authorizationDefect(capability, claim, facts, expected, new Date("2026-09-19T00:05:00.000Z"))).toBe("CERTIFICATION_CAPABILITY_EXPIRED");
  });

  it("refuses to put a second live capability behind the same fence", () => {
    // Whoever still holds the forgotten one decides when to use it.
    const { store, bind } = makeFixture();
    bind("run", "deploy");
    issueCapability(store, scope, now, testSecret());
    expect(() => issueCapability(store, scope, now, testSecret())).toThrow("CERTIFICATION_CAPABILITY_ALREADY_LIVE");
    expect(() => issueCapability(store, scope, new Date("2026-09-19T01:00:00.000Z"), testSecret())).not.toThrow();
  });

  it("reissues once the first has expired, and keeps it", () => {
    // Expiry alone does not free the fence: the slot is a stored fact, so the
    // old capability has to be retired for a replacement to exist at all. Both
    // endings are kept, because "spent" and "replaced" are different histories.
    const { store, bind } = makeFixture();
    bind("run", "deploy");
    const { capability: first, nonce: firstNonce } = issueCapability(store, scope, now, testSecret());
    const afterExpiry = new Date(now.getTime() + scope.ttlMs + 1_000);

    const { capability: second } = issueCapability(store, scope, afterExpiry, testSecret());
    expect(second.id).not.toBe(first.id);
    expect(store.get(first.id)).toBeDefined();
    // ...and the replacement is the only one a claim can now be admitted with.
    // Retired, not merely expired: without that case a retired-but-unconsumed
    // capability would go on satisfying this predicate while the row that
    // replaced it already existed - two capabilities, both authorised.
    expect(authorizationDefect(store.get(first.id), { capabilityId: first.id, runId: "run", nonce: firstNonce }, facts, expected, afterExpiry))
      .toBe("CERTIFICATION_CAPABILITY_RETIRED");
  });

  it("will not issue an unbounded or unscoped permission", () => {
    const { store, bind } = makeFixture();
    bind("run", "deploy");
    expect(() => issueCapability(store, { ...scope, releaseSha: "" }, now, testSecret())).toThrow(CertificationCapabilityError);
    expect(() => issueCapability(store, { ...scope, maxAmountKopecks: 0 }, now, testSecret())).toThrow("CERTIFICATION_CAPABILITY_AMOUNT_INVALID");
    expect(() => issueCapability(store, { ...scope, ttlMs: 0 }, now, testSecret())).toThrow("CERTIFICATION_CAPABILITY_TTL_INVALID");
  });
});
