/** FLEX-122 test harness: a scripted Commerce behind `fetch` and an in-memory sessionStorage. */
import { CheckoutController, type CheckoutState } from "@/components/checkout/checkout-controller";
import { encodeIntentId } from "@/components/checkout/intent";
import { IntentStore } from "@/components/checkout/intent-store";
import fixtures from "./fixtures/checkout/commerce-answers.json";

export { fixtures };
export const MY = "https://my.flexperiment.test";

export type Reply = { status: number; body: unknown } | (() => Promise<{ status: number; body: unknown }>);
export type Call = { method: string; path: string; headers: Record<string, string>; body: unknown };

export class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}

/** Routes: "POST /v1/checkout/preview", "POST /v1/checkout", "GET /v1/checkout/<id>". Each route
 * answers from its queue; the last reply repeats. A missing route is a test failure. */
export class FakeCommerce {
  calls: Call[] = [];
  private routes = new Map<string, Reply[]>();
  on(route: string, ...replies: Reply[]) { this.routes.set(route, [...(this.routes.get(route) ?? []), ...replies]); return this; }
  count(route: string) { return this.calls.filter((call) => `${call.method} ${call.path}` === route).length; }
  fetch: typeof fetch = async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    this.calls.push({ method, path, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const queue = this.routes.get(`${method} ${path}`);
    if (!queue?.length) throw new Error(`unexpected ${method} ${path}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    const reply = typeof next === "function" ? await next() : next;
    if (reply.status === 0) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
}

export const ok = (body: unknown, status = 200) => ({ status, body });

export function setup(offerRef: string, options: { storage?: MemoryStorage; returnedOrder?: string | null; commerce?: FakeCommerce } = {}) {
  const intentId = encodeIntentId(offerRef)!;
  const storage = options.storage ?? new MemoryStorage();
  const commerce = options.commerce ?? new FakeCommerce();
  const navigations: string[] = [];
  const states: CheckoutState[] = [];
  let key = 0;
  const controller = new CheckoutController({
    intentId, offerRef, returnedOrder: options.returnedOrder ?? null,
    store: new IntentStore(storage, intentId, offerRef, () => `preview-key-${++key}`),
    fetch: commerce.fetch, myOrigin: MY, navigate: (url) => { navigations.push(url); },
    sleep: async () => {}, pollAttempts: 5, newKey: () => `payment-key-${++key}`,
  });
  controller.subscribe((state) => states.push(state));
  return { controller, commerce, storage, navigations, states, intentId };
}

export const phases = (states: CheckoutState[]) => states.map((state) => state.phase);
