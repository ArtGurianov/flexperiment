import { randomUUID } from "node:crypto";

/**
 * A one-shot permission to transact through a deployment fence, and nothing
 * else.
 *
 * The mechanism it replaces was an allowlist row tied to a release generation
 * and a promo code, which made "this is a certification order" a property the
 * business logic could read and branch on. Nothing downstream may know: a
 * certification purchase is an ordinary purchase whose only difference is that
 * it was allowed past a closed deployment gate.
 *
 * Every field narrows the permission:
 *
 *   deploymentSessionId  the one fence it opens, and no other
 *   releaseSha           the exact revision it was issued against
 *   runId + nonce        the single run allowed to present it
 *   maxAmountKopecks     a ceiling, so a leaked capability cannot buy a real seat
 *   expiresAt            minutes, not the life of a release
 */
export type CertificationCapability = {
  readonly id: string;
  readonly runId: string;
  readonly deploymentSessionId: string;
  readonly releaseSha: string;
  readonly maxAmountKopecks: number;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly consumedAt?: string | null;
  /** Set when the capability was replaced after expiry rather than spent. One-way, and never both. */
  readonly retiredAt?: string | null;
};

/**
 * What the client sends: possession, and which run is speaking. It asserts no
 * fact the server would otherwise have to establish.
 *
 * A claim that carried the release or the amount would invert the whole point -
 * whoever presented a capability would also choose the revision it was "for"
 * and the price it was "within".
 */
export type CertificationClaim = {
  readonly capabilityId: string;
  readonly runId: string;
  readonly nonce: string;
};

/**
 * The facts only the server can know, each taken where it is authoritative:
 * the deployment session from the gate that is closed, the release SHA from
 * the runtime's own identity, and the amount and occurrence from the quote
 * being checked out - not from the request that asked for it.
 */
export type TrustedCheckoutFacts = {
  readonly deploymentSessionId: string;
  readonly runtimeReleaseSha: string;
  readonly actualAmountKopecks: number;
  readonly checkoutOccurrenceId: string;
};

export type CapabilityDefect =
  | "CERTIFICATION_CAPABILITY_NOT_FOUND"
  | "CERTIFICATION_CAPABILITY_CONSUMED"
  | "CERTIFICATION_CAPABILITY_RETIRED"
  | "CERTIFICATION_CAPABILITY_EXPIRED"
  | "CERTIFICATION_CAPABILITY_RUN_MISMATCH"
  | "CERTIFICATION_CAPABILITY_NONCE_MISMATCH"
  | "CERTIFICATION_CAPABILITY_RELEASE_MISMATCH"
  | "CERTIFICATION_CAPABILITY_AMOUNT_EXCEEDED"
  | "CERTIFICATION_CAPABILITY_SESSION_MISMATCH";

export class CertificationCapabilityError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "CertificationCapabilityError";
  }
}

export type IssueCapabilityInput = {
  readonly runId: string;
  readonly deploymentSessionId: string;
  readonly releaseSha: string;
  readonly maxAmountKopecks: number;
  readonly ttlMs: number;
};

export interface CertificationCapabilityStore {
  issue(capability: CertificationCapability, now: Date): CertificationCapability;
  get(id: string): CertificationCapability | undefined;
}

const nonceMatches = (left: string, right: string): boolean => {
  // Constant time over the whole comparison: a nonce checked with `===` leaks
  // its prefix through timing, and this one is the difference between an open
  // fence and a closed one.
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

export const issueCapability = (store: CertificationCapabilityStore, input: IssueCapabilityInput, now: Date): CertificationCapability => {
  if (!input.runId || !input.deploymentSessionId || !input.releaseSha) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_SCOPE_REQUIRED");
  if (!Number.isSafeInteger(input.maxAmountKopecks) || input.maxAmountKopecks <= 0) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_AMOUNT_INVALID");
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_TTL_INVALID");
  return store.issue({
    id: randomUUID(),
    runId: input.runId,
    deploymentSessionId: input.deploymentSessionId,
    releaseSha: input.releaseSha,
    maxAmountKopecks: input.maxAmountKopecks,
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    nonce: randomUUID(),
    consumedAt: null,
  }, now);
};

/**
 * Pure. Compares possession against facts the server established and against
 * the durable run, never against anything the claim asserted, and names the
 * defect rather than only refusing: an expired capability is reissued and the
 * run continues, while a runtime on a different revision means production
 * moved underneath the run and it must not continue at all.
 */
export const authorizationDefect = (
  capability: CertificationCapability | undefined,
  claim: CertificationClaim,
  facts: TrustedCheckoutFacts,
  expected: { readonly runId: string; readonly releaseSha: string; readonly occurrenceId?: string | null },
  now: Date,
): CapabilityDefect | undefined => {
  if (!capability || capability.id !== claim.capabilityId) return "CERTIFICATION_CAPABILITY_NOT_FOUND";
  if (capability.consumedAt) return "CERTIFICATION_CAPABILITY_CONSUMED";
  // The live slot is a stored fact now, not a computed one. Retiring frees the
  // index slot immediately, so without this a retired-but-unconsumed
  // capability would go on satisfying this predicate while its replacement
  // already existed - two capabilities, both authorised.
  if (capability.retiredAt) return "CERTIFICATION_CAPABILITY_RETIRED";
  if (!(Date.parse(capability.expiresAt) > now.getTime())) return "CERTIFICATION_CAPABILITY_EXPIRED";
  if (capability.runId !== claim.runId || capability.runId !== expected.runId) return "CERTIFICATION_CAPABILITY_RUN_MISMATCH";
  if (!nonceMatches(capability.nonce, claim.nonce)) return "CERTIFICATION_CAPABILITY_NONCE_MISMATCH";
  // Three views of the release have to agree: what the capability was issued
  // against, what the runtime is actually serving, and what the run set out to
  // certify. Any disagreement means one of them moved.
  if (capability.releaseSha !== facts.runtimeReleaseSha || capability.releaseSha !== expected.releaseSha) return "CERTIFICATION_CAPABILITY_RELEASE_MISMATCH";
  if (!facts.deploymentSessionId || capability.deploymentSessionId !== facts.deploymentSessionId) return "CERTIFICATION_CAPABILITY_SESSION_MISMATCH";
  // The occurrence being bought is the run's own fixture. Without this a
  // leaked capability could be spent on a real event priced under the ceiling.
  if (!expected.occurrenceId || facts.checkoutOccurrenceId !== expected.occurrenceId) return "CERTIFICATION_CAPABILITY_SESSION_MISMATCH";
  if (!Number.isSafeInteger(facts.actualAmountKopecks) || facts.actualAmountKopecks <= 0 || facts.actualAmountKopecks > capability.maxAmountKopecks) return "CERTIFICATION_CAPABILITY_AMOUNT_EXCEEDED";
  return undefined;
};

/** Test-only storage. In P9 the live-uniqueness rule becomes a partial UNIQUE index. */
export class InMemoryCertificationCapabilityStore implements CertificationCapabilityStore {
  #capabilities = new Map<string, CertificationCapability>();

  issue(capability: CertificationCapability, now: Date): CertificationCapability {
    // One live capability per fence. A second one issued while the first is
    // still usable is a second way through the same gate, and whoever holds
    // the forgotten one decides when to use it.
    for (const existing of this.#capabilities.values()) {
      if (existing.deploymentSessionId !== capability.deploymentSessionId || existing.consumedAt) continue;
      if (Date.parse(existing.expiresAt) > now.getTime()) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_ALREADY_LIVE", existing.id);
    }
    this.#capabilities.set(capability.id, capability);
    return capability;
  }

  get(id: string): CertificationCapability | undefined { return this.#capabilities.get(id); }

  /** Used only by the checkout authority, which owns the transaction it happens in. */
  spend(id: string, now: Date): CertificationCapability {
    const capability = this.#capabilities.get(id)!;
    const consumed = { ...capability, consumedAt: now.toISOString() };
    this.#capabilities.set(id, consumed);
    return consumed;
  }

  /** The in-memory stand-in for a transaction rolling back. */
  restore(capability: CertificationCapability): void {
    this.#capabilities.set(capability.id, capability);
  }
}
