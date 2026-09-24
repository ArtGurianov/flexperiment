import { describe, expect, it } from "vitest";
import { capabilityBearerDefect, capabilityPossessionDefect, issueCapability, type CertificationCapability } from "../../src/certification/capability";
import { CERTIFICATION_CAPABILITY_TTL_MS } from "../../src/certification/scope";
import { testSecret } from "../support/certification-secret";

/**
 * The capability's lifetime bounds only the window before it is spent.
 *
 * Deploy hands over (exit 13), the operator starts `certify`, and the checkout
 * spends the capability - minutes in practice. After that, the payment, the
 * refund and cleanup prove possession, never freshness, so an hour-long TTL
 * cannot cut a refund off halfway.
 */

const SESSION = "session-ttl";
const RUN = "certification-session-ttl-r1";
const SHA = "d".repeat(40);
const T0 = new Date("2026-09-24T10:00:00.000Z");

const issued = () => {
  let stored: CertificationCapability | undefined;
  const { capability, nonce } = issueCapability(
    { issue: (candidate) => (stored = candidate), get: () => stored },
    { runId: RUN, deploymentSessionId: SESSION, releaseSha: SHA, maxAmountKopecks: 100, ttlMs: CERTIFICATION_CAPABILITY_TTL_MS },
    T0, testSecret(),
  );
  return { capability, claim: { capabilityId: capability.id, runId: RUN, nonce } };
};
const context = { deploymentSessionId: SESSION, runtimeReleaseSha: SHA };
const expected = { runId: RUN, releaseSha: SHA };

describe("the certification capability's lifetime", () => {
  it("is one hour", () => {
    expect(CERTIFICATION_CAPABILITY_TTL_MS).toBe(60 * 60_000);
    expect(issued().capability.expiresAt).toBe("2026-09-24T11:00:00.000Z");
  });

  it("may be spent up to its last millisecond, and not at its expiry", () => {
    const { capability, claim } = issued();
    const expiry = Date.parse(capability.expiresAt);
    expect(capabilityBearerDefect(capability, claim, context, expected, new Date(expiry - 1))).toBeUndefined();
    expect(capabilityBearerDefect(capability, claim, context, expected, new Date(expiry))).toBe("CERTIFICATION_CAPABILITY_EXPIRED");
  });

  it("does not bound anything after the checkout spent it: possession is what the refund and cleanup prove", () => {
    const { capability, claim } = issued();
    const spent = { ...capability, consumedAt: new Date(T0.getTime() + 5 * 60_000).toISOString() };
    const hoursLater = new Date(T0.getTime() + 6 * 60 * 60_000);
    // Possession holds long past expiry...
    expect(capabilityPossessionDefect(spent, claim, context, expected)).toBeUndefined();
    // ...and a second spend is refused because it was spent, not because it aged.
    expect(capabilityBearerDefect(spent, claim, context, expected, hoursLater)).toBe("CERTIFICATION_CAPABILITY_CONSUMED");
  });
});
