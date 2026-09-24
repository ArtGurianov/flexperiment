import { randomUUID } from "node:crypto";
import { certificationNonceDigest, deriveCertificationNonce, nonceDigestMatches, type CapabilityKey, type NonceBinding } from "./nonce";

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
  /**
   * The digest of the bearer, never the bearer.
   *
   * A nonce kept as a column makes a read-only leak of this database a
   * capability to pass the deployment fence and buy behind it. The bearer is
   * derived from the fields above and one secret the runner holds; this proves
   * a presented one and mints nothing.
   */
  readonly nonceDigest: string;
  readonly consumedAt?: string | null;
  /** Set when the capability ended without being spent. One-way, and never both. */
  readonly retiredAt?: string | null;
  /** Why it was retired: replaced after expiry, or revoked early by forward supersession. */
  readonly retirementReason?: "EXPIRED_REPLACED" | "FORWARD_SUPERSESSION" | null;
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

/**
 * Issues, and hands the bearer back exactly once.
 *
 * The capability that goes into the store carries only the digest; the bearer
 * is returned beside it and never persisted. A caller that needs it again
 * derives it from the row, which is what makes the handoff between two
 * processes work without keeping a secret anywhere.
 */
export const issueCapability = (
  store: CertificationCapabilityStore,
  input: IssueCapabilityInput,
  now: Date,
  secret: CapabilityKey,
): { capability: CertificationCapability; nonce: string } => {
  if (!input.runId || !input.deploymentSessionId || !input.releaseSha) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_SCOPE_REQUIRED");
  if (!Number.isSafeInteger(input.maxAmountKopecks) || input.maxAmountKopecks <= 0) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_AMOUNT_INVALID");
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_TTL_INVALID");
  const binding = {
    capabilityId: randomUUID(),
    runId: input.runId,
    deploymentSessionId: input.deploymentSessionId,
    releaseSha: input.releaseSha,
    expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
  };
  const nonce = deriveCertificationNonce(secret, binding);
  const capability = store.issue({
    id: binding.capabilityId,
    runId: binding.runId,
    deploymentSessionId: binding.deploymentSessionId,
    releaseSha: binding.releaseSha,
    maxAmountKopecks: input.maxAmountKopecks,
    expiresAt: binding.expiresAt,
    nonceDigest: certificationNonceDigest(nonce),
    consumedAt: null,
  }, now);
  return { capability, nonce };
};

/** The binding a stored capability was derived from, for a caller re-deriving the bearer. */
export const capabilityBinding = (capability: CertificationCapability): NonceBinding => ({
  capabilityId: capability.id,
  runId: capability.runId,
  deploymentSessionId: capability.deploymentSessionId,
  releaseSha: capability.releaseSha,
  expiresAt: capability.expiresAt,
});

/**
 * Pure. Compares possession against facts the server established and against
 * the durable run, never against anything the claim asserted, and names the
 * defect rather than only refusing: an expired capability is reissued and the
 * run continues, while a runtime on a different revision means production
 * moved underneath the run and it must not continue at all.
 */
/**
 * Possession, currency and fence: the part of a capability's authorisation that
 * does not depend on there being a purchase.
 *
 * A catalogue command has no price and, on its first step, no occurrence yet,
 * so it cannot answer the two checkout clauses below. Splitting them out is the
 * alternative to inventing values for those fields at the catalogue seam, which
 * would be a weaker copy of this check that quietly disagrees with it - exactly
 * what the sales gate refuses to keep.
 */
/**
 * Possession and scope: this bearer holds this run's capability, for this
 * release, behind this fence.
 *
 * It says nothing about the capability still being spendable, and that is the
 * point. Cleanup happens after the checkout has spent it - shutting the fixture
 * is the last thing a run does - so a check that required an unspent capability
 * would make the close unreachable and leave the occurrence for sale forever.
 * What cleanup needs to prove is that the caller is this run, which is exactly
 * this.
 */
export const capabilityPossessionDefect = (
  capability: CertificationCapability | undefined,
  claim: CertificationClaim,
  context: { readonly deploymentSessionId: string; readonly runtimeReleaseSha: string },
  expected: { readonly runId: string; readonly releaseSha: string },
): CapabilityDefect | undefined => {
  if (!capability || capability.id !== claim.capabilityId) return "CERTIFICATION_CAPABILITY_NOT_FOUND";
  if (capability.runId !== claim.runId || capability.runId !== expected.runId) return "CERTIFICATION_CAPABILITY_RUN_MISMATCH";
  if (!nonceDigestMatches(capability.nonceDigest, claim.nonce)) return "CERTIFICATION_CAPABILITY_NONCE_MISMATCH";
  // Three views of the release have to agree: what the capability was issued
  // against, what the runtime is actually serving, and what the run set out to
  // certify. Any disagreement means one of them moved.
  if (capability.releaseSha !== context.runtimeReleaseSha || capability.releaseSha !== expected.releaseSha) return "CERTIFICATION_CAPABILITY_RELEASE_MISMATCH";
  if (!context.deploymentSessionId || capability.deploymentSessionId !== context.deploymentSessionId) return "CERTIFICATION_CAPABILITY_SESSION_MISMATCH";
  return undefined;
};

/** Possession, plus the capability still being one that could be spent. */
export const capabilityBearerDefect = (
  capability: CertificationCapability | undefined,
  claim: CertificationClaim,
  context: { readonly deploymentSessionId: string; readonly runtimeReleaseSha: string },
  expected: { readonly runId: string; readonly releaseSha: string },
  now: Date,
): CapabilityDefect | undefined => {
  const possession = capabilityPossessionDefect(capability, claim, context, expected);
  if (possession) return possession;
  if (capability!.consumedAt) return "CERTIFICATION_CAPABILITY_CONSUMED";
  // The live slot is a stored fact now, not a computed one. Retiring frees the
  // index slot immediately, so without this a retired-but-unconsumed
  // capability would go on satisfying this predicate while its replacement
  // already existed - two capabilities, both authorised.
  if (capability!.retiredAt) return "CERTIFICATION_CAPABILITY_RETIRED";
  if (!(Date.parse(capability!.expiresAt) > now.getTime())) return "CERTIFICATION_CAPABILITY_EXPIRED";
  return undefined;
};

export const authorizationDefect = (
  capability: CertificationCapability | undefined,
  claim: CertificationClaim,
  facts: TrustedCheckoutFacts,
  expected: { readonly runId: string; readonly releaseSha: string; readonly occurrenceId?: string | null },
  now: Date,
): CapabilityDefect | undefined => {
  const bearer = capabilityBearerDefect(capability, claim, facts, expected, now);
  if (bearer) return bearer;
  // The occurrence being bought is the run's own fixture. Without this a
  // leaked capability could be spent on a real event priced under the ceiling.
  if (!expected.occurrenceId || facts.checkoutOccurrenceId !== expected.occurrenceId) return "CERTIFICATION_CAPABILITY_SESSION_MISMATCH";
  if (!Number.isSafeInteger(facts.actualAmountKopecks) || facts.actualAmountKopecks <= 0 || facts.actualAmountKopecks > capability!.maxAmountKopecks) return "CERTIFICATION_CAPABILITY_AMOUNT_EXCEEDED";
  return undefined;
};

/**
 * Test-only storage, modelling the same slot the schema enforces with a partial
 * UNIQUE index over `consumed_at IS NULL AND retired_at IS NULL`.
 *
 * The slot is a stored fact, not a computed one: expiry alone does not free it,
 * so a replacement requires the old capability to be retired. Keeping that here
 * is what makes this a reference rather than a looser stand-in.
 */
export class InMemoryCertificationCapabilityStore implements CertificationCapabilityStore {
  #capabilities = new Map<string, CertificationCapability>();

  issue(capability: CertificationCapability, now: Date): CertificationCapability {
    // One live capability per fence. A second one issued while the first is
    // still usable is a second way through the same gate, and whoever holds
    // the forgotten one decides when to use it.
    for (const existing of this.#capabilities.values()) {
      if (existing.deploymentSessionId !== capability.deploymentSessionId || existing.consumedAt || existing.retiredAt) continue;
      if (Date.parse(existing.expiresAt) > now.getTime()) throw new CertificationCapabilityError("CERTIFICATION_CAPABILITY_ALREADY_LIVE", existing.id);
      // Retiring is what frees the slot, and it keeps the row: "spent" and
      // "replaced" are different histories and neither is a deletion.
      this.#capabilities.set(existing.id, { ...existing, retiredAt: now.toISOString() });
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
