import { describe, expect, it } from "vitest";
import { canonicalV2, decryptTicketCapability, encryptTicketCapability, publicOrderNumber } from "../src/crypto";

/** Flips one bit of a base64url payload and re-encodes it, as a real corruption would. */
const tamper = (encoded: string, index: number) => {
  const bytes = Buffer.from(encoded, "base64url");
  bytes[index] ^= 0x01;
  return bytes.toString("base64url");
};

describe("public order number", () => {
  it("uses an immutable-reference format with 80 random bits", () => {
    const value = publicOrderNumber();
    expect(value).toMatch(/^FX-[0-9A-F]{20}$/);
    expect(new Set(Array.from({ length: 50 }, () => publicOrderNumber())).size).toBe(50);
  });
});

describe("ticket capability encryption", () => {
  it("round-trips a capability", () => {
    const { ciphertext, nonce } = encryptTicketCapability("ticket-capability");
    expect(decryptTicketCapability(ciphertext, nonce)).toBe("ticket-capability");
  });

  it("uses a fresh nonce for every encryption", () => {
    // Reusing a nonce under one key is the failure that makes AES-GCM leak.
    const nonces = new Set(Array.from({ length: 50 }, () => encryptTicketCapability("same input").nonce));
    expect(nonces.size).toBe(50);
  });

  it("refuses a ciphertext that has been altered", () => {
    // The authentication tag is the reason this mode was chosen. Without it a
    // ticket is decryptable-but-forgeable, and a capability is exactly the kind
    // of value someone would try to edit.
    const { ciphertext, nonce } = encryptTicketCapability("ticket-capability");
    expect(() => decryptTicketCapability(tamper(ciphertext, 0), nonce)).toThrow();
  });

  it("refuses a ciphertext whose authentication tag has been altered", () => {
    // The tag is the last 16 bytes; changing it must fail as loudly as changing
    // the message, or the tag is decoration.
    const { ciphertext, nonce } = encryptTicketCapability("ticket-capability");
    const bytes = Buffer.from(ciphertext, "base64url");
    expect(() => decryptTicketCapability(tamper(ciphertext, bytes.length - 1), nonce)).toThrow();
  });

  it("refuses a capability presented under a different nonce", () => {
    // Including one from another genuine encryption: the nonce is part of what
    // is authenticated, so swapping it is forgery, not a decoding accident.
    const first = encryptTicketCapability("ticket-capability");
    const second = encryptTicketCapability("ticket-capability");
    expect(() => decryptTicketCapability(first.ciphertext, second.nonce)).toThrow();
    expect(() => decryptTicketCapability(first.ciphertext, tamper(first.nonce, 0))).toThrow();
  });
});

describe("canonical v2 encoding", () => {
  // This text is the identity of a command: two requests are the same request
  // exactly when this function agrees. So the assertions are on the exact
  // string, not on round-tripping through a parser that would hide a change.
  it("produces one encoding whatever order the keys arrive in", () => {
    expect(canonicalV2({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalV2({ a: 2, b: 1 })).toBe(canonicalV2({ b: 1, a: 2 }));
  });

  it("sorts nested objects too, at every depth", () => {
    // The older `canonical` sorts only the top level, which is why it is kept
    // for historical rows and not used for new nested contracts.
    expect(canonicalV2({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it("leaves array order alone", () => {
    // Order is meaning in a list. Sorting one would make two different requests
    // hash identically.
    expect(canonicalV2({ items: ["b", "a"] })).toBe('{"items":["b","a"]}');
    expect(canonicalV2({ items: ["b", "a"] })).not.toBe(canonicalV2({ items: ["a", "b"] }));
  });

  it("sorts objects inside arrays without moving the array", () => {
    expect(canonicalV2([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe('[{"a":2,"b":1},{"c":4,"d":3}]');
  });

  it("omits undefined properties and keeps null", () => {
    // Matching JSON.stringify, so an absent field and a field set to undefined
    // are the same request - while null stays a value someone chose.
    expect(canonicalV2({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });

  it("refuses values that have no stable encoding", () => {
    // A digest over NaN or a function would be a digest over whatever the
    // serializer felt like that day.
    expect(() => canonicalV2({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalV2({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalV2({ a: () => 1 })).toThrow(TypeError);
    expect(() => canonicalV2({ a: Symbol("nope") })).toThrow(TypeError);
  });
});
