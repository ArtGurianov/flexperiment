// SharedCheckoutSnapshotV1 and ResolutionInputV1 digests (docs/28 §5, §7).
//
// Merchant and Refref compute these INDEPENDENTLY and compare. That only means something if both
// sides run the same algorithm, so the algorithm is the one ADR-135 already names —
// `refref-jcs-1`: RFC 8785 JCS, SHA-256, lowercase hex — and the digest string carries that name as
// its prefix. A second implementation lives in docs/scripts/rc2-contract-tests.py; the vectors in
// docs/scripts/rc2-contract-fixtures.yaml pin both, so neither can drift and still pass.
//
// Deliberately NOT a general JCS library. The hashed structures contain objects, arrays, strings,
// booleans, null and safe integers only (money is integer kopecks). A non-integer or unsafe number
// is refused rather than serialized, because the ECMAScript number formatting JCS relies on is
// exactly where two careful implementations quietly disagree.

import { createHash } from 'node:crypto';

export const CANONICALIZATION_VERSION = 'refref-jcs-1';
export const SHARED_CHECKOUT_SNAPSHOT_SCHEMA = 'refref.shared-checkout-snapshot/1';
/** New orders carry merchant text; V1 stays unchanged for historical digest/replay. */
export const SHARED_CHECKOUT_SNAPSHOT_V2_SCHEMA = 'refref.shared-checkout-snapshot/2';
export const RESOLUTION_INPUT_SCHEMA = 'refref.referral-resolution-input/1';

export class CanonicalizationError extends Error {}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function serialize(value: unknown, path: string): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(`${path}: only safe integers are admitted, got ${String(value)}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => serialize(v, `${path}[${i}]`)).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Array.prototype.sort without a comparator orders by UTF-16 code units — RFC 8785 §3.2.3.
    const keys = Object.keys(obj).sort();
    const members: string[] = [];
    for (const key of keys) {
      const member = obj[key];
      // An absent optional field is omitted, never null (docs/28 §7 rule 3). `undefined` cannot be
      // hashed on the wire, so treating it as absence here would let a serializer decide presence.
      if (member === undefined) throw new CanonicalizationError(`${path}.${key}: undefined is not JSON`);
      members.push(`${JSON.stringify(key)}:${serialize(member, `${path}.${key}`)}`);
    }
    return `{${members.join(',')}}`;
  }
  throw new CanonicalizationError(`${path}: ${typeof value} is not JSON`);
}

/** RFC 8785 canonical form of `value`, restricted to the domain described above. */
export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

/** `refref-jcs-1:<64 lowercase hex>` over the canonical form's UTF-8 bytes. */
export function digest(value: unknown): string {
  const hex = createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
  return `${CANONICALIZATION_VERSION}:${hex}`;
}

function byRef<T extends Record<string, unknown>>(items: readonly T[], ref: string): T[] {
  // Code-point order. References are ASCII by contract, so this equals UTF-16 order too.
  return [...items].sort((a, b) => {
    const x = String(a[ref]);
    const y = String(b[ref]);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

/**
 * docs/28 §7 rule 6: arrays whose elements carry a reference unique within the array (lines,
 * obligations, an obligation's allocations) are sorted by it; every other array (fiscal items) keeps
 * the merchant's order. Nothing else is normalised —
 * no defaulting, no trimming, no case folding — because anything normalised here is something the
 * two parties could silently disagree about while their digests still matched.
 */
export function normalizeSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const lines = snapshot.lines;
  const obligations = snapshot.paymentObligations;
  if (!Array.isArray(lines) || !Array.isArray(obligations)) {
    throw new CanonicalizationError('snapshot.lines and snapshot.paymentObligations must be arrays');
  }
  return {
    ...snapshot,
    lines: byRef(lines as Record<string, unknown>[], 'lineRef'),
    paymentObligations: byRef(obligations as Record<string, unknown>[], 'obligationRef').map((o) => {
      const allocations = o.allocations;
      if (!Array.isArray(allocations)) {
        throw new CanonicalizationError(`obligation ${String(o.obligationRef)}: allocations must be an array`);
      }
      return { ...o, allocations: byRef(allocations as Record<string, unknown>[], 'lineRef') };
    }),
  };
}

export function snapshotHash(snapshot: Record<string, unknown>): string {
  return digest(normalizeSnapshot(snapshot));
}

const RESOLUTION_LINE_FIELDS = [
  'lineRef', 'offerRef', 'unitRef', 'quantity', 'merchantOfferAmountKopecks', 'serviceStartsAt', 'serviceEndsAt',
] as const;

/**
 * ResolutionInputV1 as projected from a snapshot (rule V3). The same projection applied to the
 * createReferralResolution request lines yields the resolution's inputHash, so a snapshot whose
 * commercial lines changed after resolution cannot reproduce it.
 */
export function resolutionInputFromSnapshot(snapshot: Record<string, unknown>): Record<string, Json> {
  const lines = (snapshot.lines as Record<string, unknown>[]).map((line) => {
    const out: Record<string, Json> = {};
    for (const field of RESOLUTION_LINE_FIELDS) {
      if (line[field] !== undefined) out[field] = line[field] as Json;
    }
    return out;
  });
  return {
    schema: RESOLUTION_INPUT_SCHEMA,
    merchantId: snapshot.merchantId as Json,
    merchantOrderRef: snapshot.merchantOrderRef as Json,
    currency: snapshot.currency as Json,
    lines: byRef(lines, 'lineRef'),
  };
}

export function resolutionInputHash(input: Record<string, unknown>): string {
  const lines = input.lines;
  if (!Array.isArray(lines)) throw new CanonicalizationError('input.lines must be an array');
  return digest({ ...input, lines: byRef(lines as Record<string, unknown>[], 'lineRef') });
}
