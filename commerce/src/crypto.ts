import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const emailKey = process.env.COMMERCE_EMAIL_HMAC_KEY ?? "development-only-email-hmac-key-change-before-production";
const ticketKey = Buffer.from(
  process.env.COMMERCE_TICKET_KEY_BASE64 ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  "base64",
);

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const publicId = () => randomBytes(32).toString("base64url");
// An immutable customer-facing reference: 80 random bits, non-sequential and
// safe to include in transactional emails. It is not an authentication token.
export const publicOrderNumber = () => `FX-${randomBytes(10).toString("hex").toUpperCase()}`;
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const emailHash = (value: string) => createHmac("sha256", emailKey).update(value.trim().toLowerCase()).digest("hex");
// Kept for historical idempotency rows. Its array replacer is intentionally not
// suitable for new nested request contracts; use canonicalV2 for those.
export const canonical = (value: unknown) => JSON.stringify(value, Object.keys(value as object).sort());

const canonicalV2Value = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalV2Value(item));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      // JSON.stringify omits undefined object properties; retain that stable
      // JSON behaviour while making every retained nested value explicit.
      if (item !== undefined) result[key] = canonicalV2Value(item);
    }
    return result;
  }
  throw new TypeError("Canonical JSON cannot contain an unsupported value.");
};

/** Deterministic recursive JSON encoding for new versioned request hashes. */
export const canonicalV2 = (value: unknown) => JSON.stringify(canonicalV2Value(value));

export function encryptTicketCapability(capability: string) {
  if (ticketKey.length !== 32) throw new Error("COMMERCE_TICKET_KEY_BASE64 must be a 32-byte base64 key.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ticketKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(capability, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString("base64url"),
    nonce: nonce.toString("base64url"),
  };
}

export function decryptTicketCapability(ciphertext: string, nonce: string) {
  if (ticketKey.length !== 32) throw new Error("COMMERCE_TICKET_KEY_BASE64 must be a 32-byte base64 key.");
  const bytes = Buffer.from(ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", ticketKey, Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8");
}
