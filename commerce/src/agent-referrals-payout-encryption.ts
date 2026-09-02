import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { recordAgentReferralsActivationEvidence } from "./agent-referrals-activation";

/**
 * Dedicated, versioned encryption key for payout-profile destinations -
 * never the ticket-capability key (crypto.ts), never shared across domains.
 * The key id is pinned into PR3's insert-only activation manifest on every
 * encryption call: idempotent if the configured id matches what is already
 * pinned, fail-closed (AGENT_REFERRALS_ACTIVATION_EVIDENCE_CONFLICT, from
 * agent-referrals-activation.ts) if the environment now resolves to a
 * different id than the one already durably pinned. Rotation is
 * deliberately unsupported here - a future PR that needs it gets its own
 * explicit version/supersession semantics rather than this module silently
 * accepting a changed key.
 */

const PAYOUT_KEY_ID = process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_ID ?? "agent-referrals-payout-key-v1";
const PAYOUT_KEY_BASE64 = process.env.COMMERCE_AGENT_REFERRALS_PAYOUT_KEY_BASE64 ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export class PayoutEncryptionError extends Error {
  constructor(readonly code: string, readonly status = 409, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const payoutKeyBytes = () => Buffer.from(PAYOUT_KEY_BASE64, "base64");

export const pinPayoutEncryptionKeyId = (db: Database.Database): string => {
  recordAgentReferralsActivationEvidence(db, "payout_profile_encryption_key_id", PAYOUT_KEY_ID);
  return PAYOUT_KEY_ID;
};

export type EncryptedPayoutDestination = { key_id: string; ciphertext: string; nonce: string };

export const encryptPayoutDestination = (db: Database.Database, plaintext: string): EncryptedPayoutDestination => {
  const keyId = pinPayoutEncryptionKeyId(db);
  const keyBytes = payoutKeyBytes();
  if (keyBytes.length !== 32) throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_INVALID", 500);
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
  if (keyId !== PAYOUT_KEY_ID) throw new PayoutEncryptionError("AGENT_REFERRALS_PAYOUT_KEY_MISMATCH", 409, keyId);
  const keyBytes = payoutKeyBytes();
  const bytes = Buffer.from(ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", keyBytes, Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8");
};
