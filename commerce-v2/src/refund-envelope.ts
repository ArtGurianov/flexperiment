import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The refund submission envelope (ART-174, plan F4): the exact createRefund request Flexperiment sent —
 * its Idempotency-Key and body — frozen at the moment the execution began. A replay after a lost answer
 * sends these bytes again and nothing rebuilt: Refref binds a key to its first request (R4), so a body
 * recomputed from today's balance or today's e-mail would be a different request under the same key.
 *
 * It carries the customer's receipt e-mail, so it is sealed: AES-256-GCM under a keyring
 * (REFUND_ENVELOPE_KEYS / REFUND_ENVELOPE_CURRENT_KEY), the execution id as additional data so a sealed
 * envelope cannot be moved to another execution, and the key id stored beside it so a rotation keeps
 * every earlier envelope readable. A key that leaves the ring makes its envelopes unreadable, and such an
 * execution goes to a person — it is never rebuilt.
 */
export type RefundEnvelope = {
  readonly idempotencyKey: string;
  readonly paymentId: string;
  readonly amountKopecks: number;
  readonly body: Readonly<Record<string, unknown>>;
};

export type RefundEnvelopeKeyring = { readonly currentKeyId: string; readonly keys: Readonly<Record<string, Buffer>> };

export function refundEnvelopeKeyringFromEnvironment(env: Readonly<Record<string, string | undefined>>): RefundEnvelopeKeyring | undefined {
  const ring = env.REFUND_ENVELOPE_KEYS;
  if (!ring) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(ring); } catch { throw new Error("REFUND_ENVELOPE_KEYRING_INVALID"); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("REFUND_ENVELOPE_KEYRING_INVALID");
  const keys: Record<string, Buffer> = {};
  for (const [id, encoded] of Object.entries(raw as Record<string, unknown>)) {
    const key = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    if (!id || key.length !== 32) throw new Error("REFUND_ENVELOPE_KEYRING_INVALID");
    keys[id] = key;
  }
  const currentKeyId = env.REFUND_ENVELOPE_CURRENT_KEY ?? "";
  if (!keys[currentKeyId]) throw new Error("REFUND_ENVELOPE_CURRENT_KEY_INVALID");
  return { currentKeyId, keys };
}

export function sealRefundEnvelope(keyring: RefundEnvelopeKeyring, executionId: string, envelope: RefundEnvelope) {
  const key = keyring.keys[keyring.currentKeyId];
  if (!key) throw new Error("REFUND_ENVELOPE_CURRENT_KEY_INVALID");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`flexperiment.refund-envelope/1:${executionId}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  return { keyId: keyring.currentKeyId, sealed: [iv, cipher.getAuthTag(), ciphertext].map((v) => v.toString("base64url")).join(".") };
}

export function openRefundEnvelope(keyring: RefundEnvelopeKeyring, keyId: string, executionId: string, sealed: string): RefundEnvelope {
  const key = keyring.keys[keyId];
  if (!key) throw new Error("REFUND_ENVELOPE_KEY_UNAVAILABLE");
  const [iv, tag, ciphertext] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) throw new Error("REFUND_ENVELOPE_INVALID");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(`flexperiment.refund-envelope/1:${executionId}`, "utf8"));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as RefundEnvelope;
  } catch {
    throw new Error("REFUND_ENVELOPE_INVALID");
  }
}
