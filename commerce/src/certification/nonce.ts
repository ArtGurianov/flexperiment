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

export type CapabilityKey = { readonly version: string; readonly key: Buffer };

/**
 * `<version>:<base64url of at least 32 random bytes>`.
 *
 * Measured in decoded bytes, not characters: a long human-readable string is
 * not a long key, and this one is the only thing standing between a database
 * reader and a claim.
 *
 * The version travels with the secret and inside every bearer it derives, so a
 * rotation is a different key rather than a silent reinterpretation of the
 * same one.
 */
export const parseCapabilityKey = (raw: string | undefined): CapabilityKey => {
  const value = (raw ?? "").trim();
  const separator = value.indexOf(":");
  const version = separator < 0 ? "" : value.slice(0, separator);
  const encoded = separator < 0 ? "" : value.slice(separator + 1);
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(version) || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CertificationNonceError("CERTIFICATION_CAPABILITY_KEY_INVALID", "expected <version>:<base64url key>");
  }
  const key = Buffer.from(encoded, "base64url");
  if (key.length < 32) {
    throw new CertificationNonceError("CERTIFICATION_CAPABILITY_KEY_INVALID", `key is ${key.length} bytes; at least 32 random bytes are required`);
  }
  return { version, key };
};

/**
 * Every key this runner may derive with, newest first.
 *
 * A key cannot be retired while a non-terminal run issued under it still
 * exists: that run's bearer is derivable only from the key that made it, and
 * dropping it would strand a certification mid-payment. So rotation adds a
 * version rather than replacing one, and the ring is what lets an old run
 * finish while new ones are issued under the new key.
 */
export const parseCapabilityKeyring = (raw: string | undefined): readonly CapabilityKey[] => {
  const keys = (raw ?? "").split(/[\s,]+/).filter(Boolean).map(parseCapabilityKey);
  if (!keys.length) throw new CertificationNonceError("CERTIFICATION_CAPABILITY_KEY_INVALID", "no key configured");
  const versions = new Set(keys.map((entry) => entry.version));
  if (versions.size !== keys.length) throw new CertificationNonceError("CERTIFICATION_CAPABILITY_KEY_INVALID", "two keys share a version");
  return keys;
};

/**
 * The bearer for a stored capability, found by asking which key produces the
 * digest it was issued with.
 *
 * The version is inside the bearer and the bearer is what was thrown away, so
 * the ring is tried rather than indexed. Answering undefined is the honest
 * result for a capability whose key is gone - and the caller turns that into a
 * refusal before anything is armed, not into a guess.
 */
export const recoverCertificationNonce = (
  keyring: readonly CapabilityKey[],
  binding: NonceBinding,
  storedDigest: string,
): string | undefined => {
  for (const secret of keyring) {
    const nonce = deriveCertificationNonce(secret, binding);
    if (nonceDigestMatches(storedDigest, nonce)) return nonce;
  }
  return undefined;
};

export const deriveCertificationNonce = (secret: CapabilityKey, binding: NonceBinding): string =>
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
