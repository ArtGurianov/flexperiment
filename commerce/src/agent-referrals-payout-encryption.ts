import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { recordAgentReferralsActivationEvidence } from "./agent-referrals-activation";

/**
 * Dedicated, versioned encryption key for payout-profile destinations -
 * never the ticket-capability key (crypto.ts), never shared across domains,
 * and deliberately with NO committed development fallback: unlike
 * crypto.ts's ticket key (which protects an ephemeral, non-financial
 * capability), a fallback here would mean a real payout destination could
 * be encrypted under a key published in this repository's git history.
 * Missing or malformed configuration is a hard failure, not a quiet
 * dev-mode default.
 *
 * Configuration is fully validated BEFORE the key id is pinned into PR3's
 * insert-only activation manifest - an invalid or absent key must leave no
 * manifest evidence at all, so a later correctly-configured deploy is never
 * blocked by a bad value pinned during misconfiguration.
 *
 * The key id is pinned on every encryption call: idempotent if the
 * configured id matches what is already pinned, fail-closed
 * (AGENT_REFERRALS_ACTIVATION_EVIDENCE_CONFLICT, from
 * agent-referrals-activation.ts) if the environment now resolves to a
 * different id than the one already durably pinned. Rotation is
 * deliberately unsupported here - a future PR that needs it gets its own
 * explicit version/supersession semantics rather than this module silently
 * accepting a changed key.
 */

export class PayoutEncryptionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const resolvePayoutKeyId = (): string => {
  const keyId = process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_ID;
  if (!keyId || keyId.trim().length === 0) throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_ID_MISSING", 500);
  return keyId;
};

const resolvePayoutKeyBytes = (): Buffer => {
  const configured = process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_BASE64;
  if (!configured) throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_MISSING", 500);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(configured, "base64");
  } catch {
    throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_INVALID", 500, "not valid base64");
  }
  if (bytes.length !== 32) throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_INVALID", 500, `expected 32 bytes, got ${bytes.length}`);
  return bytes;
};

/** Validates configuration fully, then pins the key id. Never pins on a validation failure. */
export const pinPayoutEncryptionKeyId = (db: Database.Database): string => {
  const keyId = resolvePayoutKeyId();
  resolvePayoutKeyBytes();
  recordAgentReferralsActivationEvidence(db, "payout_profile_encryption_key_id", keyId);
  return keyId;
};

export type EncryptedPayoutDestination = { key_id: string; ciphertext: string; nonce: string };

export const encryptPayoutDestination = (db: Database.Database, plaintext: string): EncryptedPayoutDestination => {
  const keyId = resolvePayoutKeyId();
  const keyBytes = resolvePayoutKeyBytes();
  recordAgentReferralsActivationEvidence(db, "payout_profile_encryption_key_id", keyId);

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    key_id: keyId,
    ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64url"),
    nonce: nonce.toString("base64url"),
  };
};

export const decryptPayoutDestination = (keyId: string, ciphertext: string, nonce: string): string => {
  const configuredKeyId = resolvePayoutKeyId();
  if (keyId !== configuredKeyId) throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_MISMATCH", 409, keyId);
  const keyBytes = resolvePayoutKeyBytes();
  const bytes = Buffer.from(ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8");
};
