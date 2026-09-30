import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

type HandoffState = { customerId: string; orderPublicId: string; returnPath: string; expiresAt: number };

const signature = (payload: string, secret: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueCheckoutHandoffState(secret: string, input: { customerId: string; returnPath: string }, now = Date.now()) {
  if (!input.returnPath.startsWith("/") || input.returnPath.startsWith("//")) throw new Error("CHECKOUT_RETURN_PATH_INVALID");
  const state: HandoffState = { customerId: input.customerId, orderPublicId: randomUUID(), returnPath: input.returnPath, expiresAt: now + 10 * 60_000 };
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return { token: `${payload}.${signature(payload, secret)}`, state };
}

export function verifyCheckoutHandoffState(secret: string, token: string, customerId: string, now = Date.now()) {
  const [payload, presented = ""] = token.split(".");
  if (!payload) throw new Error("CHECKOUT_STATE_INVALID");
  const expected = signature(payload, secret);
  const left = Buffer.from(presented); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error("CHECKOUT_STATE_INVALID");
  let state: HandoffState;
  try { state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HandoffState; }
  catch { throw new Error("CHECKOUT_STATE_INVALID"); }
  if (state.customerId !== customerId || state.expiresAt < now || !state.returnPath.startsWith("/") || state.returnPath.startsWith("//")) {
    throw new Error("CHECKOUT_STATE_INVALID");
  }
  return state;
}
