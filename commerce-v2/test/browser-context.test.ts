import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AfterResponseTasks } from "../src/after-response";
import { createCommerceV2App } from "../src/app";
import { BROWSER_CONTEXT_COOKIES, BrowserContexts, cleanArrivalTarget, loadBrowserContextConfig, type BrowserContextConfig } from "../src/browser-context";
import { MockPaymentRail, type PaymentResolveInput } from "../src/checkout";
import { migrateV2 } from "../src/db";
import { loadCommerceOrigins } from "../src/origins";
import {
  RefrefArrivalExchange, type ArrivalClaimInput, type ArrivalClaimOutcome, type ArrivalExchange, type ContextCloseOutcome,
} from "../src/refref-arrival-exchange";
import { stageALegalManifestJson, stageBLegalManifestJson } from "./fixtures/legal";
import { activatePublicSales, qualifyTestFiscalPolicies, testCheckoutConfig } from "./fixtures/sales";

// ART-378 (B2): storefront arrival endpoints, first-party context lifecycle, 30-minute exchange and
// retry, bounded Buy readback and frozen delivery degradation (refref docs/29 §2, §4, §6).

const T0 = new Date("2026-10-19T10:00:00.000Z");
const origins = loadCommerceOrigins({ NODE_ENV: "test" });
const PLATFORM = "localhost:3001";
const LAB = "localhost:3000";
const PROOF = `ar1.${"A".repeat(43)}`;
const OTHER_PROOF = `ar1.${"B".repeat(43)}`;
const confirmed = (n = 1): ArrivalClaimOutcome => ({ kind: "CONFIRMED", claimId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  eligibleUntil: "2026-11-18T10:00:00.000Z" });

class FakeExchange implements ArrivalExchange {
  readonly claims: ArrivalClaimInput[] = [];
  readonly closes: string[] = [];
  readonly script: Array<ArrivalClaimOutcome | "HANG"> = [];
  readonly closeScript: ContextCloseOutcome[] = [];
  async claim(input: ArrivalClaimInput, signal: AbortSignal): Promise<ArrivalClaimOutcome> {
    this.claims.push(input);
    const next = this.script.shift() ?? confirmed(this.claims.length);
    if (next !== "HANG") return next;
    return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ kind: "UNKNOWN", code: "TRANSPORT" })));
  }
  async close(id: string): Promise<ContextCloseOutcome> {
    this.closes.push(id);
    return this.closeScript.shift() ?? "CLOSED";
  }
}

let db: Database.Database;
let clock: Date;
let exchange: FakeExchange;
let tasks: AfterResponseTasks;
let contexts: BrowserContexts;
let alerts: string[];
let rail: MockPaymentRail;
let app: ReturnType<typeof createCommerceV2App>;

const config: BrowserContextConfig = { maxAgeSeconds: { COURSES: 2_592_000, LAB: 2_592_000 }, attemptCeilingMs: 60, buyBudgetMs: 250 };
const build = (options: { enabled?: boolean; withExchange?: boolean } = {}) => {
  tasks = new AfterResponseTasks();
  contexts = new BrowserContexts({ db, origins, config, exchange: options.withExchange === false ? undefined : exchange,
    now: () => clock, schedule: (task) => tasks.schedule(task), alert: (code) => alerts.push(code) });
  app = createCommerceV2App({
    db, config: testCheckoutConfig, serviceToken: "synthetic", sourceCommit: "a".repeat(40), paymentRail: rail, origins,
    now: () => clock, authenticateCustomer: async (headers) => headers.get("x-test-customer"),
    authHandler: async () => new Response(JSON.stringify({ success: true }), { status: 200,
      headers: { "content-type": "application/json", "set-cookie": "flx.session=; Path=/; Max-Age=0" } }),
    ...(options.enabled === false ? {} : { browserContexts: contexts }),
  });
};
const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };

/** One browser on one storefront host: a cookie jar, and optionally a signed-in account. */
class Browser {
  readonly jar = new Map<string, string>();
  constructor(readonly host: string, public customer?: string) {}
  headers(extra: Record<string, string> = {}) {
    return {
      "x-forwarded-host": this.host,
      ...(this.jar.size ? { cookie: [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ") } : {}),
      ...(this.customer ? { "x-test-customer": this.customer } : {}),
      ...extra,
    };
  }
  absorb(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      if (/Max-Age=0(;|$)/.test(cookie)) this.jar.delete(name); else this.jar.set(name, pair.slice(separator + 1));
    }
    return response;
  }
  async get(path: string) { return this.absorb(await app.request(path, { headers: this.headers() })); }
  async post(path: string, body?: unknown, extra: Record<string, string> = {}) {
    return this.absorb(await app.request(path, { method: "POST", headers: this.headers({ "content-type": "application/json", ...extra }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  }
  context(storefront: "COURSES" | "LAB" = this.host === LAB ? "LAB" : "COURSES") { return this.jar.get(BROWSER_CONTEXT_COOKIES[storefront]); }
  arrive(proof: string | undefined, to = "/courses/intro") {
    const query = new URLSearchParams({ to, ...(proof ? { arrival: proof } : {}) });
    return this.get(`/v1/browser-context/arrive?${query}`);
  }
  buy(key: string, offerRef = "course:one") { return this.post("/v1/checkout/preview", { offerRef }, { "idempotency-key": key }); }
}

const contextRow = (id: string) => db.prepare("SELECT * FROM browser_contexts WHERE id=?").get(id) as Record<string, unknown> | undefined;
const arrivals = () => db.prepare("SELECT * FROM browser_context_arrivals ORDER BY captured_at").all() as Array<Record<string, unknown>>;
const frozenRequest = (key: string) => (JSON.parse((db.prepare("SELECT resolution_request_json FROM checkout_quotes WHERE preview_idempotency_key=?")
  .get(key) as { resolution_request_json: string }).resolution_request_json) as PaymentResolveInput).request;

const addLab = () => {
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('lab-legal','LAB','lab-stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
  db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
    VALUES ('occurrence','lab:november','city','LAB в ноябре','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Красный проспект, 1')`).run();
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab-product','lab:november','LAB','PAID','lab:november')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('lab-offer','lab:november','lab-product',250000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db);
  activatePublicSales(db, "LAB");
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateV2(db);
  clock = T0;
  exchange = new FakeExchange();
  alerts = [];
  rail = new MockPaymentRail();
  for (const id of ["A", "B"]) db.prepare("INSERT INTO customers(id,email_normalized) VALUES (?,?)").run(id, `${id.toLowerCase()}@example.com`);
  db.prepare(`INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active)
    VALUES ('legal','COURSES','stage-a-v1',?,'2026-09-30T00:00:00Z',1)`).run(stageALegalManifestJson);
  db.prepare("INSERT INTO products(id,product_ref,kind,access_model,course_ref) VALUES ('product','course:one','ONLINE_COURSE','PAID','course-one')").run();
  db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('offer','course:one','product',10000,'PUBLIC')").run();
  qualifyTestFiscalPolicies(db);
  activatePublicSales(db);
  build();
});

describe("arrival endpoint on each storefront origin", () => {
  it.each([[PLATFORM, "COURSES", "http://localhost:3001"], [LAB, "LAB", "http://localhost:3000"]] as const)(
    "sets the server-only context cookie after a decorated URL and redirects to a clean first-party URL (%s)",
    async (host, storefront, origin) => {
      const browser = new Browser(host);
      const response = await browser.arrive(PROOF);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${origin}/courses/intro`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const [cookie, ...others] = response.headers.getSetCookie();
      expect(others).toEqual([]);
      // HTTP Set-Cookie only (never document.cookie): Secure, HttpOnly, SameSite=Lax, host-scoped, ≥ campaign window.
      expect(cookie).toMatch(new RegExp(`^${BROWSER_CONTEXT_COOKIES[storefront]}=[A-Za-z0-9_-]{43}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$`));
      expect(cookie).not.toMatch(/domain=/i);
      expect(contextRow(browser.context()!)).toMatchObject({ storefront, storefront_origin: origin, status: "ACTIVE", bound_customer_id: null });
    });

  it("answers before any Refref call and claims after the response with only proof, context and origin", async () => {
    exchange.script.push("HANG");
    const browser = new Browser(PLATFORM);
    const response = await browser.arrive(PROOF);
    expect(response.status).toBe(303);
    expect(exchange.claims).toHaveLength(0);
    expect(tasks.size).toBeGreaterThan(0);
    await tasks.drain();
    expect(exchange.claims).toEqual([{ arrivalProof: PROOF, browserContextId: browser.context(), storefrontOrigin: "http://localhost:3001" }]);
    expect(arrivals()[0]).toMatchObject({ state: "PENDING", attempts: 1 });
  });

  it("reuses the ACTIVE context on every later landing, so A-then-B arrivals share one context", async () => {
    const browser = new Browser(PLATFORM);
    await browser.arrive(PROOF);
    const first = browser.context();
    advance(60_000);
    const again = await browser.arrive(OTHER_PROOF);
    expect(again.headers.getSetCookie()).toEqual([]);
    await tasks.drain();
    expect(exchange.claims.map(({ browserContextId }) => browserContextId)).toEqual([first, first]);
    expect(arrivals().map(({ state }) => state)).toEqual(["CONFIRMED", "CONFIRMED"]);
  });

  it("captures a repeated landing of the same proof once", async () => {
    const browser = new Browser(PLATFORM);
    await browser.arrive(PROOF);
    await tasks.drain();
    await browser.arrive(PROOF);
    await tasks.drain();
    expect(arrivals()).toHaveLength(1);
    expect(exchange.claims).toHaveLength(1);
  });

  it.each([
    ["//evil.example/x"], ["https://evil.example/"], ["/\\evil.example"], ["/arrive?arrival=x"], ["/v1/me"], ["courses"], [""],
  ])("never redirects off the storefront or back into the endpoint (to=%s)", (to) => {
    expect(cleanArrivalTarget(origins, "COURSES", to)).toBe("http://localhost:3001/");
  });

  it("keeps the target's own query but never a proof", () => {
    expect(cleanArrivalTarget(origins, "LAB", `/lab?city=nsk&arrival=${PROOF}#top`)).toBe("http://localhost:3000/lab?city=nsk");
  });

  it("ignores an absent, duplicated or malformed proof but still lands the buyer", async () => {
    const browser = new Browser(LAB);
    expect((await browser.arrive(undefined)).status).toBe(303);
    expect((await browser.get(`/v1/browser-context/arrive?arrival=${PROOF}&arrival=${OTHER_PROOF}`)).status).toBe(303);
    expect((await browser.get("/v1/browser-context/arrive?arrival=%3Cscript%3E")).status).toBe(303);
    await tasks.drain();
    expect(arrivals()).toEqual([]);
    expect(exchange.claims).toEqual([]);
  });

  it("refuses a host that is not a storefront origin", async () => {
    const response = await app.request(`/v1/browser-context/arrive?arrival=${PROOF}`, { headers: { "x-forwarded-host": "api.example" } });
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("with the feature off, still lands the buyer cleanly and keeps nothing", async () => {
    build({ enabled: false });
    const response = await new Browser(PLATFORM).arrive(PROOF);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost:3001/courses/intro");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(arrivals()).toEqual([]);
  });
});

describe("30-minute exchange and retry on later same-context requests", () => {
  it("retries a failed first attempt on an anonymous page view and confirms it", async () => {
    exchange.script.push({ kind: "UNKNOWN", code: "HTTP_503" });
    const browser = new Browser(LAB);
    await browser.arrive(PROOF, "/");
    await tasks.drain();
    expect(arrivals()[0]).toMatchObject({ state: "PENDING", attempts: 1 });
    advance(3_000);
    // The LAB page loads its catalogue anonymously; the retry runs after that response.
    expect((await browser.get("/v1/lab/catalogue")).status).toBe(200);
    await tasks.drain();
    expect(exchange.claims).toHaveLength(2);
    expect(exchange.claims[1]).toEqual(exchange.claims[0]);
    expect(arrivals()[0]).toMatchObject({ state: "CONFIRMED", attempts: 2, arrival_proof: null });
  });

  it("retries on a platform page view through the touch hook, rate-limited and single-flight", async () => {
    exchange.script.push({ kind: "UNKNOWN", code: "TRANSPORT" }, { kind: "UNKNOWN", code: "TRANSPORT" });
    const browser = new Browser(PLATFORM);
    await browser.arrive(PROOF);
    await tasks.drain();
    // Within the retry interval: no new attempt.
    expect((await browser.post("/v1/browser-context/touch")).status).toBe(204);
    await tasks.drain();
    expect(exchange.claims).toHaveLength(1);
    advance(2_500);
    await Promise.all([browser.post("/v1/browser-context/touch"), browser.post("/v1/browser-context/touch")]);
    await tasks.drain();
    expect(exchange.claims).toHaveLength(2);
    advance(2_500);
    await browser.post("/v1/browser-context/touch");
    await tasks.drain();
    expect(arrivals()[0]).toMatchObject({ state: "CONFIRMED", attempts: 3 });
  });

  it("never claims after the 30-minute window and clears the raw proof", async () => {
    exchange.script.push({ kind: "UNKNOWN", code: "TRANSPORT" });
    const browser = new Browser(LAB);
    await browser.arrive(PROOF);
    await tasks.drain();
    advance(30 * 60_000);
    await browser.get("/v1/lab/catalogue");
    await tasks.drain();
    expect(exchange.claims).toHaveLength(1);
    expect(arrivals()[0]).toMatchObject({ state: "EXPIRED", arrival_proof: null });
  });

  it("treats a definitive refusal as final for that proof", async () => {
    exchange.script.push({ kind: "REFUSED", code: "ARRIVAL_PROOF_INVALID" });
    const browser = new Browser(LAB);
    await browser.arrive(PROOF);
    await tasks.drain();
    advance(5_000);
    await browser.get("/v1/lab/catalogue");
    await tasks.drain();
    expect(exchange.claims).toHaveLength(1);
    expect(arrivals()[0]).toMatchObject({ state: "FAILED", failure_code: "ARRIVAL_PROOF_INVALID", arrival_proof: null });
  });

  it("continues a Refref-closed context in a successor that keeps the proof and reaches the browser", async () => {
    exchange.script.push({ kind: "CONTEXT_CLOSED" });
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    const closed = browser.context()!;
    await tasks.drain();
    const successor = contextRow(closed)!.successor_id as string;
    expect(contextRow(closed)).toMatchObject({ status: "CLOSED", retire_reason: "REFREF_CLOSED" });
    expect(contextRow(successor)).toMatchObject({ status: "ACTIVE", bound_customer_id: "A" });
    const response = await browser.buy("closed");
    expect(response.status).toBe(200);
    expect(browser.context()).toBe(successor);
    expect(exchange.claims.at(-1)).toMatchObject({ browserContextId: successor, arrivalProof: PROOF });
    expect(frozenRequest("closed")).toMatchObject({ browserContextId: successor, deliveryDegraded: { degraded: false } });
  });
});

describe("Buy: bounded exchange/readback and frozen delivery degradation", () => {
  it("freezes the context, origin and a clean delivery when the claim confirms", async () => {
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    expect((await browser.buy("clean")).status).toBe(200);
    expect(frozenRequest("clean")).toMatchObject({ storefrontOrigin: "http://localhost:3001", browserContextId: browser.context(),
      deliveryDegraded: { degraded: false } });
  });

  it("gives up after the budget with TIMEOUT, and a late ACK never clears it on replay", async () => {
    exchange.script.push("HANG", "HANG", "HANG", "HANG", "HANG", "HANG", "HANG", "HANG");
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    const started = performance.now();
    expect((await browser.buy("timeout")).status).toBe(200);
    expect(performance.now() - started).toBeLessThan(config.buyBudgetMs! + 400);
    expect(frozenRequest("timeout").deliveryDegraded).toEqual({ degraded: true, reason: "TIMEOUT" });
    exchange.script.length = 0;
    advance(3_000);
    await browser.post("/v1/browser-context/touch");
    await tasks.drain();
    expect(arrivals()[0]).toMatchObject({ state: "CONFIRMED" });
    const resolve = vi.spyOn(rail, "resolve");
    expect((await browser.buy("timeout")).status).toBe(200);
    expect(frozenRequest("timeout").deliveryDegraded).toEqual({ degraded: true, reason: "TIMEOUT" });
    expect(resolve).not.toHaveBeenCalled();
    expect(alerts).toContain("ARRIVAL_DELIVERY_DEGRADED_TIMEOUT");
  });

  it("stays within 1,500 ms by default", () => {
    const contexts = new BrowserContexts({ db, origins, config: { maxAgeSeconds: config.maxAgeSeconds }, now: () => clock, schedule: () => {} });
    expect((contexts as unknown as { buyBudgetMs: number; attemptCeilingMs: number }).buyBudgetMs).toBe(1_500);
    expect((contexts as unknown as { attemptCeilingMs: number }).attemptCeilingMs).toBe(500);
  });

  it("marks FAILED for a definitive refusal and EXPIRED for a proof whose window ran out unconfirmed", async () => {
    exchange.script.push({ kind: "REFUSED", code: "ARRIVAL_PROOF_INVALID" });
    const failing = new Browser(PLATFORM, "A");
    await failing.arrive(PROOF);
    await tasks.drain();
    await failing.buy("failed");
    expect(frozenRequest("failed").deliveryDegraded).toEqual({ degraded: true, reason: "FAILED" });

    exchange.script.push({ kind: "UNKNOWN", code: "TRANSPORT" });
    const late = new Browser(PLATFORM, "B");
    await late.arrive(OTHER_PROOF);
    await tasks.drain();
    advance(31 * 60_000);
    await late.buy("expired");
    expect(exchange.claims).toHaveLength(2);
    expect(frozenRequest("expired").deliveryDegraded).toEqual({ degraded: true, reason: "EXPIRED" });
  });

  it("creates a context for a direct purchase with no cookie, undegraded", async () => {
    const browser = new Browser(PLATFORM, "A");
    expect((await browser.buy("direct")).status).toBe(200);
    expect(browser.context()).toBeDefined();
    expect(frozenRequest("direct")).toMatchObject({ browserContextId: browser.context(), deliveryDegraded: { degraded: false } });
    expect(exchange.claims).toEqual([]);
  });
});

describe("LMS account boundary", () => {
  it("anonymous click → login → Buy keeps the anonymous Arrival's context", async () => {
    const browser = new Browser(PLATFORM);
    await browser.arrive(PROOF);
    await tasks.drain();
    const anonymous = browser.context();
    browser.customer = "A";
    expect((await browser.get("/v1/me")).status).toBe(200);
    expect(browser.context()).toBe(anonymous);
    expect(contextRow(anonymous!)).toMatchObject({ bound_customer_id: "A" });
    await browser.buy("login-buy");
    expect(frozenRequest("login-buy")).toMatchObject({ browserContextId: anonymous, deliveryDegraded: { degraded: false } });
  });

  it("logout A → login B: a new context ID, the old one closed, A's pending proof not migrated", async () => {
    exchange.script.push({ kind: "UNKNOWN", code: "TRANSPORT" });
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    const a = browser.context()!;
    const signOut = await browser.post("/v1/auth/sign-out", {});
    expect(signOut.status).toBe(200);
    expect(signOut.headers.getSetCookie()).toEqual(expect.arrayContaining([expect.stringMatching(/^flx\.session=/),
      expect.stringMatching(new RegExp(`^${BROWSER_CONTEXT_COOKIES.COURSES}=`))]));
    await tasks.drain();
    const fresh = browser.context()!;
    expect(fresh).not.toBe(a);
    expect(contextRow(a)).toMatchObject({ status: "ROTATED", retire_reason: "LOGOUT", close_state: "ACKNOWLEDGED" });
    expect(exchange.closes).toEqual([a]);
    expect(arrivals()[0]).toMatchObject({ browser_context_id: a, state: "ABANDONED", arrival_proof: null });
    browser.customer = "B";
    await browser.buy("b-buys");
    expect(frozenRequest("b-buys")).toMatchObject({ browserContextId: fresh, deliveryDegraded: { degraded: false } });
    expect(exchange.claims.every(({ browserContextId }) => browserContextId === a)).toBe(true);
  });

  it("rotates on logout even when the anonymous context was never bound", async () => {
    const browser = new Browser(PLATFORM);
    await browser.arrive(PROOF);
    await tasks.drain();
    const before = browser.context()!;
    browser.customer = "A";
    await browser.post("/v1/auth/sign-out", {});
    expect(browser.context()).not.toBe(before);
    browser.customer = "B";
    await browser.buy("after-logout");
    expect(frozenRequest("after-logout").browserContextId).not.toBe(before);
  });

  it("an account switch without sign-out rotates at the next request, and Buy never uses the old context", async () => {
    exchange.script.push({ kind: "UNKNOWN", code: "TRANSPORT" });
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    const a = browser.context()!;
    browser.customer = "B";
    await browser.buy("switched");
    expect(frozenRequest("switched").browserContextId).not.toBe(a);
    expect(frozenRequest("switched").deliveryDegraded).toEqual({ degraded: false });
    expect(contextRow(a)).toMatchObject({ status: "ROTATED", retire_reason: "ACCOUNT_SWITCH" });
    expect(contextRow(browser.context()!)).toMatchObject({ bound_customer_id: "B" });
  });

  it("a session that ended without sign-out rotates on the next page load", async () => {
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    const a = browser.context()!;
    browser.customer = undefined;
    await browser.get("/v1/me");
    expect(browser.context()).not.toBe(a);
    expect(contextRow(a)).toMatchObject({ retire_reason: "LOGOUT" });
  });

  it("never presents a rotated ID again, even from a second tab that still sends it", async () => {
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    const a = browser.context()!;
    const staleTab = new Browser(PLATFORM, "A");
    staleTab.jar.set(BROWSER_CONTEXT_COOKIES.COURSES, a);
    await browser.post("/v1/auth/sign-out", {});
    staleTab.customer = undefined;
    await staleTab.arrive(OTHER_PROOF);
    await tasks.drain();
    expect(staleTab.context()).not.toBe(a);
    expect(exchange.claims.find(({ arrivalProof }) => arrivalProof === OTHER_PROOF)?.browserContextId).toBe(staleTab.context());
  });

  it("does not retry a bound context from a request of another account in the background", async () => {
    exchange.script.push({ kind: "UNKNOWN", code: "TRANSPORT" });
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    advance(3_000);
    browser.customer = "B";
    await browser.post("/v1/browser-context/touch");
    await tasks.drain();
    expect(exchange.claims).toHaveLength(1);
  });

  it("retries an unacknowledged close until Refref acknowledges it", async () => {
    exchange.closeScript.push("UNKNOWN");
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    const a = browser.context()!;
    await browser.post("/v1/auth/sign-out", {});
    await tasks.drain();
    expect(contextRow(a)).toMatchObject({ close_state: "PENDING", close_attempts: 1 });
    await contexts.maintain();
    expect(contextRow(a)).toMatchObject({ close_state: "ACKNOWLEDGED", close_attempts: 2 });
    expect(exchange.closes).toEqual([a, a]);
  });

  it("LAB has no account boundary: sign-out and sign-in keep the guest context", async () => {
    const browser = new Browser(LAB, "A");
    await browser.arrive(PROOF);
    const guest = browser.context();
    await browser.post("/v1/auth/sign-out", {});
    browser.customer = "B";
    await browser.get("/v1/me");
    expect(browser.context()).toBe(guest);
    expect(contextRow(guest!)).toMatchObject({ status: "ACTIVE", bound_customer_id: null });
  });
});

describe("one context per storefront origin", () => {
  it("a referral to an LMS page then a LAB purchase is not attributed by link", async () => {
    addLab();
    const lms = new Browser(PLATFORM, "A");
    await lms.arrive(PROOF);
    await tasks.drain();
    // Same person, same browser, other origin: the LAB host never receives the LMS cookie.
    const lab = new Browser(LAB, "A");
    expect((await lab.buy("lab-buy", "lab:november")).status).toBe(200);
    const request = frozenRequest("lab-buy");
    expect(request).toMatchObject({ storefrontOrigin: "http://localhost:3000", deliveryDegraded: { degraded: false } });
    expect(request.browserContextId).toBe(lab.context("LAB"));
    expect(request.browserContextId).not.toBe(lms.context("COURSES"));
    expect(exchange.claims).toEqual([{ arrivalProof: PROOF, browserContextId: lms.context("COURSES"), storefrontOrigin: "http://localhost:3001" }]);
  });

  it("an LMS cookie presented to the LAB host is not a LAB context", async () => {
    const lms = new Browser(PLATFORM);
    await lms.arrive(PROOF);
    const lab = new Browser(LAB);
    lab.jar.set(BROWSER_CONTEXT_COOKIES.LAB, lms.context("COURSES")!);
    await lab.arrive(OTHER_PROOF);
    expect(lab.context("LAB")).not.toBe(lms.context("COURSES"));
  });
});

describe("LAB guest Buy (ART-384 guest checkout)", () => {
  it("freezes the guest's LAB context, origin and delivery state; a repeat on the order sends what it froze", async () => {
    db.prepare("INSERT INTO legal_releases(id,storefront,version,manifest_json,effective_at,active) VALUES ('lab-b','LAB','lab-b',?,?,1)")
      .run(stageBLegalManifestJson, T0.toISOString());
    db.prepare("INSERT INTO cities(id,slug,title) VALUES ('city','nsk','Новосибирск')").run();
    db.prepare(`INSERT INTO lab_occurrences(id,occurrence_ref,city_id,title,starts_at,ends_at,timezone,capacity,venue_status,venue_name,venue_address)
      VALUES ('event','lab:one','city','LAB','2026-11-01T09:00:00Z','2026-11-01T17:00:00Z','Asia/Novosibirsk',20,'CONFIRMED','Студия','Адрес')`).run();
    db.prepare("INSERT INTO products(id,product_ref,kind,access_model,occurrence_ref) VALUES ('lab-product','lab:one','LAB','PAID','lab:one')").run();
    db.prepare("INSERT INTO offers(id,offer_ref,product_id,price_kopecks,sale_mode) VALUES ('lab-offer','lab:one','lab-product',10000,'PUBLIC')").run();
    qualifyTestFiscalPolicies(db);
    activatePublicSales(db, "LAB");
    app = createCommerceV2App({ db, config: testCheckoutConfig, serviceToken: "synthetic", sourceCommit: "a".repeat(40), paymentRail: rail, origins,
      now: () => clock, authenticateCustomer: async () => null, browserContexts: contexts, sendLabTicketEmail: async () => {},
      labGuestTrustedProxyIps: ["10.0.5.4"], labGuestPeerAddress: () => "10.0.5.4" });
    exchange.script.push("HANG", "HANG", "HANG", "HANG", "HANG", "HANG", "HANG", "HANG");
    const browser = new Browser(LAB);
    await browser.arrive(PROOF, "/");
    await tasks.drain();
    const token = "g".repeat(43);
    const guestHeaders = (key: string) => browser.headers({ origin: "http://localhost:3000", "x-real-ip": "203.0.113.1",
      "content-type": "application/json", "idempotency-key": key, authorization: `Bearer ${token}` });
    const started = await app.request("/v1/lab/guest/start", { method: "POST", headers: guestHeaders("start"),
      body: JSON.stringify({ email: "guest@example.com", accessToken: token }) });
    expect(started.status).toBe(201);
    const preview = () => app.request("/v1/checkout/preview", { method: "POST", headers: guestHeaders("guest-preview"),
      body: JSON.stringify({ offerRef: "lab:one" }) });
    expect((await preview()).status).toBe(200);
    const request = (JSON.parse((db.prepare("SELECT resolution_request_json FROM checkout_quotes").get() as { resolution_request_json: string })
      .resolution_request_json) as PaymentResolveInput).request;
    expect(request).toMatchObject({ storefrontOrigin: "http://localhost:3000", browserContextId: browser.context("LAB"),
      deliveryDegraded: { degraded: true, reason: "TIMEOUT" } });
    expect(JSON.stringify(request)).not.toContain("guest@example.com");
    exchange.script.length = 0;
    advance(3_000);
    await browser.get("/v1/lab/catalogue");
    await tasks.drain();
    expect(arrivals()[0]).toMatchObject({ state: "CONFIRMED" });
    expect((await preview()).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkout_quotes").get()).toEqual({ n: 1 });
  });
});

describe("no arrival token in logs, analytics or retained state", () => {
  it("keeps the proof out of every log line, Location, frozen intent and settled row", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(capture));
    try {
      exchange.script.push({ kind: "REFUSED", code: "ARRIVAL_PROOF_INVALID" });
      const browser = new Browser(PLATFORM, "A");
      const landing = await browser.arrive(PROOF);
      await tasks.drain();
      await browser.arrive(OTHER_PROOF);
      await tasks.drain();
      await browser.buy("leak");
      expect(landing.headers.get("location")).not.toContain(PROOF);
      expect(lines.join("\n")).not.toContain(PROOF);
      expect(lines.join("\n")).not.toContain(OTHER_PROOF);
      expect(alerts.join(" ")).not.toMatch(/ar1\./);
      expect(JSON.stringify(frozenRequest("leak"))).not.toMatch(/ar1\./);
      expect(JSON.stringify(arrivals())).not.toMatch(/ar1\./);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it("sends no buyer identity to Refref", async () => {
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    expect(Object.keys(exchange.claims[0]).sort()).toEqual(["arrivalProof", "browserContextId", "storefrontOrigin"]);
    expect(JSON.stringify(exchange.claims)).not.toMatch(/a@example\.com|"A"/);
  });
});

describe("maintenance and configuration", () => {
  it("drops contexts past their cookie lifetime once no close is outstanding, with their proofs", async () => {
    const browser = new Browser(LAB);
    await browser.arrive(PROOF);
    await tasks.drain();
    advance(2_592_000_000);
    await contexts.maintain();
    expect(db.prepare("SELECT COUNT(*) AS n FROM browser_contexts").get()).toEqual({ n: 0 });
    expect(arrivals()).toEqual([]);
  });

  it("erasing a customer removes the contexts bound to them", async () => {
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    db.prepare("DELETE FROM customers WHERE id='A'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM browser_contexts").get()).toEqual({ n: 0 });
  });

  it("fails a proof it cannot deliver when no Refref vNext client is configured", async () => {
    build({ withExchange: false });
    const browser = new Browser(PLATFORM, "A");
    await browser.arrive(PROOF);
    await tasks.drain();
    await browser.buy("no-client");
    expect(frozenRequest("no-client").deliveryDegraded).toEqual({ degraded: true, reason: "FAILED" });
    expect(alerts).toContain("ARRIVAL_EXCHANGE_NOT_CONFIGURED");
  });

  it("is off by default and validates cookie lifetimes", () => {
    expect(loadBrowserContextConfig({})).toBeUndefined();
    expect(loadBrowserContextConfig({ BROWSER_CONTEXT_ENABLED: "true" })).toEqual({ maxAgeSeconds: { COURSES: 2_592_000, LAB: 2_592_000 } });
    expect(() => loadBrowserContextConfig({ BROWSER_CONTEXT_ENABLED: "true", BROWSER_CONTEXT_LAB_MAX_AGE_SECONDS: "3600" }))
      .toThrow("BROWSER_CONTEXT_LAB_MAX_AGE_SECONDS_INVALID");
  });

  it("drains after-response work before shutdown", async () => {
    const work = new AfterResponseTasks();
    let done = false;
    work.schedule(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); done = true; });
    expect(done).toBe(false);
    expect(await work.drain(1_000)).toBe(true);
    expect(done).toBe(true);
  });
});

describe("Refref vNext claim client", () => {
  const client = (status: number, body: unknown) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body), { status }));
    return { fetch, exchange: new RefrefArrivalExchange({ apiBaseUrl: "https://api.refref.test/v1-vnext", apiKey: "key", fetch }) };
  };
  const input = { arrivalProof: PROOF, browserContextId: "c".repeat(43), storefrontOrigin: "https://flexperiment.ru" };
  const receipt = { claimId: "00000000-0000-4000-8000-000000000001", browserContextId: input.browserContextId,
    storefrontOrigin: input.storefrontOrigin, claimedAt: "2026-10-19T10:00:00Z", eligibleUntil: "2026-11-18T10:00:00Z" };

  it("posts the closed claim body and reads a committed or replayed receipt", async () => {
    for (const status of [201, 200]) {
      const { fetch, exchange } = client(status, receipt);
      expect(await exchange.claim(input, AbortSignal.timeout(1000))).toEqual({ kind: "CONFIRMED", claimId: receipt.claimId,
        eligibleUntil: receipt.eligibleUntil });
      const [url, init] = fetch.mock.calls[0];
      expect(String(url)).toBe("https://api.refref.test/v1-vnext/integrations/arrival-claims");
      expect(JSON.parse(String(init!.body))).toEqual(input);
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer key");
    }
  });

  it.each([
    [422, { error: { code: "ARRIVAL_PROOF_INVALID" } }, { kind: "REFUSED", code: "ARRIVAL_PROOF_INVALID" }],
    [409, { error: { code: "ARRIVAL_ALREADY_CLAIMED" } }, { kind: "REFUSED", code: "ARRIVAL_ALREADY_CLAIMED" }],
    [409, { error: { code: "CONTEXT_SCOPE_MISMATCH" } }, { kind: "REFUSED", code: "CONTEXT_SCOPE_MISMATCH" }],
    [409, { error: { code: "CONTEXT_CLOSED" } }, { kind: "CONTEXT_CLOSED" }],
    [409, { error: { code: "BROWSER_CONTEXT_IDLE_POLICY_REQUIRED" } }, { kind: "UNKNOWN", code: "BROWSER_CONTEXT_IDLE_POLICY_REQUIRED" }],
    [503, null, { kind: "UNKNOWN", code: "HTTP_503" }],
    [429, { error: { code: "RATE_LIMITED" } }, { kind: "UNKNOWN", code: "RATE_LIMITED" }],
    [201, { ...receipt, browserContextId: "d".repeat(43) }, { kind: "REFUSED", code: "CLAIM_RECEIPT_MISMATCH" }],
  ])("maps HTTP %i %j", async (status, body, outcome) => {
    expect(await client(status, body).exchange.claim(input, AbortSignal.timeout(1000))).toEqual(outcome);
  });

  it("answers UNKNOWN for a transport failure or timeout", async () => {
    const exchange = new RefrefArrivalExchange({ apiBaseUrl: "https://api.refref.test/v1-vnext", apiKey: "key",
      fetch: async () => { throw new TypeError("fetch failed"); } });
    expect(await exchange.claim(input, AbortSignal.timeout(1000))).toEqual({ kind: "UNKNOWN", code: "TRANSPORT" });
  });

  it("closes a context idempotently", async () => {
    const closed = client(200, { browserContextId: input.browserContextId, status: "CLOSED" });
    expect(await closed.exchange.close(input.browserContextId, AbortSignal.timeout(1000))).toBe("CLOSED");
    expect(String(closed.fetch.mock.calls[0][0])).toBe(`https://api.refref.test/v1-vnext/integrations/browser-contexts/${input.browserContextId}/close`);
    expect(await client(409, { error: { code: "CONTEXT_SCOPE_MISMATCH" } }).exchange.close(input.browserContextId, AbortSignal.timeout(1000))).toBe("REFUSED");
    expect(await client(502, null).exchange.close(input.browserContextId, AbortSignal.timeout(1000))).toBe("UNKNOWN");
  });
});
