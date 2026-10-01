import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Storefront } from "./origins";

type CheckoutState = {
  phase: "HANDOFF" | "PAYMENT_RETURN";
  customerId: string;
  orderPublicId: string;
  returnPath: string;
  storefront: Storefront;
  expiresAt: number;
};

const signature = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

const issueState = (secret: string, state: CheckoutState) => {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return { token: `${payload}.${signature(payload, secret)}`, state };
};

const verifyState = (secret: string, token: string, customerId: string, now: number) => {
  const [payload, presented = ""] = token.split(".");
  if (!payload) throw new Error("CHECKOUT_STATE_INVALID");
  const expected = signature(payload, secret);
  const left = Buffer.from(presented); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("CHECKOUT_STATE_INVALID");
  let state: CheckoutState;
  try { state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CheckoutState; }
  catch { throw new Error("CHECKOUT_STATE_INVALID"); }
  if (!["HANDOFF", "PAYMENT_RETURN"].includes(state.phase) || state.customerId !== customerId || state.expiresAt < now
    || !["COURSES", "LAB"].includes(state.storefront)
    || !state.returnPath.startsWith("/") || state.returnPath.startsWith("//")) {
    throw new Error("CHECKOUT_STATE_INVALID");
  }
  return state;
};

export function issueCheckoutHandoffState(secret: string, input: { customerId: string; returnPath: string; storefront: Storefront }, now = Date.now()) {
  if (!input.returnPath.startsWith("/") || input.returnPath.startsWith("//")) throw new Error("CHECKOUT_RETURN_PATH_INVALID");
  return issueState(secret, {
    phase: "HANDOFF",
    customerId: input.customerId,
    orderPublicId: randomUUID(),
    returnPath: input.returnPath,
    storefront: input.storefront,
    expiresAt: now + 10 * 60_000,
  });
}

export function verifyCheckoutHandoffState(secret: string, token: string, customerId: string, now = Date.now()) {
  const state = verifyState(secret, token, customerId, now);
  if (state.phase !== "HANDOFF") throw new Error("CHECKOUT_STATE_INVALID");
  return state;
}

export function issueCheckoutPaymentReturnState(secret: string, handoff: CheckoutState, now = Date.now()) {
  if (handoff.phase !== "HANDOFF") throw new Error("CHECKOUT_STATE_INVALID");
  return issueState(secret, { ...handoff, phase: "PAYMENT_RETURN", expiresAt: now + 24 * 60 * 60_000 });
}

export function verifyCheckoutNavigationState(secret: string, token: string, customerId: string, now = Date.now()) {
  return verifyState(secret, token, customerId, now);
}
