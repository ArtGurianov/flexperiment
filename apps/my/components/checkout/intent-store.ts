/** FLEX-122: the buyer's checkout progress across sign-in, refresh and the provider return.
 *
 * Kept in `sessionStorage` (one tab, cleared with it), keyed by the intent id. It holds only
 * idempotency keys, the quote and order ids Commerce issued and the offer kind: no e-mail, receipt
 * contact, acceptance or amount (coordinator, 21.11.2026). The frozen confirm body lives in memory
 * for the page's lifetime; after a refresh the same payment key is resent, and Commerce answers it
 * with the order it already started (contract C I4). Nothing here is an authority: Commerce
 * re-checks every value and answers 404 for an order of another account. */
import { checkoutLessonPath } from "./intent";
import type { CheckoutKind } from "./buyer-status";

export type ConfirmBody = {
  quoteId: string;
  returnPath: string;
  legalAcceptance?: { accepted: true; releaseVersion: string; manifestSha256: string; receiptEmail: string };
  labAcceptance?: { personalDataConsent: true; termsAccepted: true; receiptContactAccepted: true; releaseVersion: string; manifestSha256: string };
};

export type IntentRecord = {
  v: 1;
  offerRef: string;
  previewKey: string;
  kind?: CheckoutKind;
  quoteId?: string;
  paymentKey?: string;
  orderPublicId?: string;
  lessonReturn?: string;
};

const FIELDS = new Set(["v", "offerRef", "previewKey", "kind", "quoteId", "paymentKey", "orderPublicId", "lessonReturn"]);

export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const storageKey = (intentId: string) => `flx-checkout:${intentId}`;

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

function parse(raw: string | null, offerRef: string): IntentRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<IntentRecord>;
    if (value.v !== 1 || value.offerRef !== offerRef || !isString(value.previewKey)) return null;
    for (const key of ["quoteId", "paymentKey", "orderPublicId"] as const) if (value[key] !== undefined && !isString(value[key])) return null;
    if (value.lessonReturn !== undefined && !checkoutLessonPath(value.lessonReturn)) return null;
    if (value.kind !== undefined && value.kind !== "COURSE" && value.kind !== "LAB") return null;
    if (Object.keys(value).some((key) => !FIELDS.has(key))) return null;
    return value as IntentRecord;
  } catch {
    return null;
  }
}

export class IntentStore {
  constructor(private readonly store: KeyValueStore | null, private readonly intentId: string, private readonly offerRef: string,
    private readonly newKey: () => string) {}

  /** A record for another offer under this id (tampered storage) is discarded, never reused. */
  load(): IntentRecord {
    let raw: string | null = null;
    try { raw = this.store?.getItem(storageKey(this.intentId)) ?? null; } catch { /* storage blocked: start fresh */ }
    return parse(raw, this.offerRef) ?? this.save({ v: 1, offerRef: this.offerRef, previewKey: this.newKey() });
  }

  save(record: IntentRecord): IntentRecord {
    const persisted = Object.fromEntries(Object.entries(record).filter(([key, value]) => FIELDS.has(key) && value !== undefined));
    try { this.store?.setItem(storageKey(this.intentId), JSON.stringify(persisted)); } catch { /* progress then lives in memory only */ }
    return record;
  }

  update(patch: Partial<Omit<IntentRecord, "v" | "offerRef">>): IntentRecord {
    return this.save({ ...this.load(), ...patch });
  }

  /** A new quote (expired or stale) needs new keys; an issued order is never forgotten here. */
  restartQuote(): IntentRecord {
    const current = this.load();
    return this.save({ v: 1, offerRef: this.offerRef, previewKey: this.newKey(), ...(current.kind ? { kind: current.kind } : {}), lessonReturn: current.lessonReturn });
  }

  clear() {
    try { this.store?.removeItem(storageKey(this.intentId)); } catch { /* nothing to clear */ }
  }
}
