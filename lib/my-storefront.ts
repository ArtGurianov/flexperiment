import { encodeIntentId } from "./my-checkout-intent";

/** Undefined keeps the existing storefront flow. Null means MY was requested but not configured. */
export function storefrontMyOrigin(environment: Readonly<Record<string, string | undefined>>) {
  if (environment.MY_IDENTITY_MODE !== "on") return undefined;
  const value = environment.MY_ORIGIN?.trim();
  if (!value) return null;
  const origin = URL.parse(value);
  return origin?.protocol === "https:" && origin.href === origin.origin + "/" ? origin.origin : null;
}

/** MY sign-in and the native sales handoff have independent release switches. */
export function storefrontCheckoutMyOrigin(environment: Readonly<Record<string, string | undefined>>) {
  if (environment.MY_CHECKOUT_MODE !== "native") return undefined;
  return storefrontMyOrigin(environment) ?? null;
}

export function myCheckoutHref(origin: string | null | undefined, offerRef: string | null, type: "course" | "lab") {
  const id = offerRef && encodeIntentId(offerRef);
  if (!origin || !id) return null;
  return new URL(`/checkout/${id}?type=${type}`, origin).href;
}
