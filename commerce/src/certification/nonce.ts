import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * The certification bearer, derived rather than stored.
 *
 * A nonce kept as a column means a read-only leak of the production database is
 * a capability to pass the deployment fence and buy behind it. So the database
 * holds only the digest - the same arrangement as a password - and the bearer
 * itself is recomputed from the capability's own binding and one secret.
 *
 * Only the runner needs that secret. The runtime being certified verifies by
 * hashing what it was presented and comparing it to the stored digest, which
 * means the target containers never hold the material that could mint a claim.
 *
 * Determinism is what makes the handoff work: `prepare` derives it, exits, and
 * `certify` in a new process derives the identical bearer from the row. A
 * random nonce would have had to be kept somewhere, and every candidate place
 * was worse than this.
 */

export class CertificationNonceError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export type NonceBinding = {
  readonly capabilityId: string;
  readonly runId: string;
  readonly deploymentSessionId: string;
  readonly releaseSha: string;
  readonly expiresAt: string;
};

/**
 * Field-separated rather than concatenated. Joining these directly would let
 * two different bindings produce one string - a run id ending where a session
 * id begins - and two capabilities with one bearer is exactly the collision
 * this is scoped to prevent.
 */
const canonical = (binding: NonceBinding): string => JSON.stringify([
  binding.capabilityId, binding.runId, binding.deploymentSessionId, binding.releaseSha, binding.expiresAt,
]);

/** The secret's version travels with it, so a rotation is a different key rather than a silent reinterpretation. */
export const parseCapabilityKey = (raw: string | undefined): { readonly version: string; readonly key: string } => {
  const value = (raw ?? "").trim();
  const [version, key] = value.split(":");
  if (!version || !key || !/^[A-Za-z0-9._-]{1,32}$/.test(version) || key.length < 32) {
    throw new CertificationNonceError("CERTIFICATION_CAPABILITY_KEY_INVALID", "expected <version>:<at least 32 characters>");
  }
  return { version, key };
};

export const deriveCertificationNonce = (secret: { version: string; key: string }, binding: NonceBinding): string =>
  `${secret.version}.${createHmac("sha256", secret.key).update(canonical(binding)).digest("hex")}`;

/** What the database holds. It proves a presented bearer and mints nothing. */
export const certificationNonceDigest = (nonce: string): string =>
  createHash("sha256").update(nonce).digest("hex");

/**
 * Constant time over the whole comparison: a digest checked with `===` leaks
 * its prefix through timing, and this one is the difference between an open
 * fence and a closed one.
 */
export const nonceDigestMatches = (storedDigest: string, presentedNonce: string): boolean => {
  const stored = Buffer.from(storedDigest, "utf8");
  const presented = Buffer.from(certificationNonceDigest(presentedNonce), "utf8");
  if (stored.length !== presented.length) return false;
  return timingSafeEqual(stored, presented);
};
