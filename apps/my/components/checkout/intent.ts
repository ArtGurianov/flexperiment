/** FLEX-122: the checkout intent id in `/checkout/<id>` (contract B §7: `^/checkout/[A-Za-z0-9_-]{16,64}$`).
 *
 * The id is stateless: `offer` + base64url(offerRef). It carries only the buyer's choice of offer, so a
 * forged or edited id can at most name another offer. Commerce derives the storefront, price, documents
 * and rights from the offer and its own state (`storefrontForOffer`), never from this id or `?type=`.
 * Nothing is created server-side by opening the page: no order, LAB seat hold or payment before a
 * MY-session preview. */
export const INTENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const PREFIX = "offer";
const OFFER_REF = /^(?:course:[a-z0-9][a-z0-9-]{0,62}|lab:[A-Za-z0-9][A-Za-z0-9._-]{0,62}|bundle:all-courses)$/;

const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

export function validOfferRef(value: unknown): value is string {
  return typeof value === "string" && OFFER_REF.test(value);
}

/** `null` when the offer ref is malformed or the id would not fit the my return-target rule. */
export function encodeIntentId(offerRef: string): string | null {
  if (!validOfferRef(offerRef)) return null;
  const id = PREFIX + toBase64Url(new TextEncoder().encode(offerRef));
  return INTENT_ID.test(id) ? id : null;
}

/** Strict inverse of `encodeIntentId`: a non-canonical encoding is refused, so one offer has one id. */
export function decodeIntentId(id: unknown): string | null {
  if (typeof id !== "string" || !INTENT_ID.test(id) || !id.startsWith(PREFIX)) return null;
  try {
    const offerRef = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(id.slice(PREFIX.length)));
    return validOfferRef(offerRef) && encodeIntentId(offerRef) === id ? offerRef : null;
  } catch {
    return null;
  }
}

/** `?type=` from a storefront link is a UI hint only (FLEX-122). */
export type KindHint = "COURSE" | "LAB" | null;
export function kindHint(value: unknown): KindHint {
  return value === "lab" ? "LAB" : value === "course" ? "COURSE" : null;
}

/** Order ids are Commerce UUIDs. Anything else in `?order=` is ignored, never sent upstream. */
export function validOrderPublicId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}
