import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type Database from "better-sqlite3";
import type { DeliveryDegraded } from "./checkout";
import { storefrontOrigin, type CommerceOrigins, type Storefront } from "./origins";
import type { ArrivalExchange } from "./refref-arrival-exchange";

/**
 * Merchant browser contexts and arrival proofs (ART-378, refref docs/29 §2, §4, §6).
 *
 * Each storefront origin keeps its own host-scoped, server-only context cookie. The arrival endpoint
 * captures Refref's proof into the context and redirects to a clean URL with no Refref call on the
 * critical path; the claim runs after the response and again on later same-context requests while
 * the 30-minute claim window lasts. Buy spends at most 1,500 ms on the exchange and then freezes
 * what it knows as `deliveryDegraded`. The LMS context is rotated on logout and on account switch;
 * pending proof never moves to the new context. LAB has no account boundary.
 */

export const BROWSER_CONTEXT_COOKIES: Readonly<Record<Storefront, string>> = {
  COURSES: "__Host-flx-ctx-lms",
  LAB: "__Host-flx-ctx-lab",
};
export const ARRIVAL_PROOF_PARAM = "arrival";
export const ARRIVAL_RETURN_PARAM = "to";
/**
 * Merchant-local limit for retrying a claim and for keeping the raw proof, counted from capture.
 * Refref's authoritative deadline is issuer `issuedAt` + 30 minutes, which the proof does not carry:
 * capture is never earlier than `issuedAt`, so this window ends at or after Refref's. A late-delivered
 * proof can therefore be retried after Refref stopped accepting it; Refref answers that with the
 * single non-oracle 422, recorded as FAILED (refref docs/openapi-vnext.yaml `claimArrival`).
 * (`claim_deadline_at` in migration 0034 holds this merchant limit.)
 */
export const CLAIM_WINDOW_MS = 30 * 60_000;
export const ATTEMPT_CEILING_MS = 500;
export const BUY_BUDGET_MS = 1_500;
/** Background attempts for one proof are at least this far apart (rate limit of the later-request retry). */
export const RETRY_INTERVAL_MS = 2_000;
const MIN_MAX_AGE_SECONDS = 86_400;
const MAX_MAX_AGE_SECONDS = 400 * 86_400;
const DEFAULT_MAX_AGE_SECONDS = 30 * 86_400;

const CONTEXT_ID = /^[A-Za-z0-9_-]{32,128}$/;
/** Opaque to the merchant (`ar1.` + base64url today); only its envelope is checked here. */
const ARRIVAL_PROOF = /^[A-Za-z0-9._~-]{32,512}$/;

export type BrowserContextConfig = {
  /** Cookie Max-Age per storefront: at least the longest attribution window of campaigns landing there. */
  maxAgeSeconds: Readonly<Record<Storefront, number>>;
  attemptCeilingMs?: number;
  buyBudgetMs?: number;
  retryIntervalMs?: number;
};

type Environment = Readonly<Record<string, string | undefined>>;

/** `undefined` when the feature is off: the arrival endpoint still redirects cleanly but captures nothing. */
export function loadBrowserContextConfig(environment: Environment = process.env): BrowserContextConfig | undefined {
  if (environment.BROWSER_CONTEXT_ENABLED !== "true") return undefined;
  const maxAge = (name: string) => {
    const raw = environment[name]?.trim();
    const value = raw ? Number(raw) : DEFAULT_MAX_AGE_SECONDS;
    if (!Number.isSafeInteger(value) || value < MIN_MAX_AGE_SECONDS || value > MAX_MAX_AGE_SECONDS) throw new Error(`${name}_INVALID`);
    return value;
  };
  return { maxAgeSeconds: {
    COURSES: maxAge("BROWSER_CONTEXT_COURSES_MAX_AGE_SECONDS"),
    LAB: maxAge("BROWSER_CONTEXT_LAB_MAX_AGE_SECONDS"),
  } };
}

/** The storefront whose public host forwarded this request; never a buyer-supplied parameter. */
export function storefrontForRequest(origins: CommerceOrigins, headers: Headers): Storefront | undefined {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host"))?.split(",")[0]?.trim().toLowerCase();
  if (!host) return undefined;
  return (["COURSES", "LAB"] as const).find((storefront) => new URL(storefrontOrigin(origins, storefront)).host === host);
}

export function presentedContextId(headers: Headers, storefront: Storefront) {
  const name = BROWSER_CONTEXT_COOKIES[storefront];
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (CONTEXT_ID.test(value)) return value;
  }
  return undefined;
}

/**
 * The clean first-party target of an arrival: a path on the same storefront, never another origin,
 * the arrival endpoint itself or the API. The proof parameter never survives into it.
 */
export function cleanArrivalTarget(origins: CommerceOrigins, storefront: Storefront, to: string | null) {
  const origin = storefrontOrigin(origins, storefront);
  const fallback = new URL("/", origin);
  if (!to || to.length > 2048 || !to.startsWith("/") || to.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(to)) return fallback.toString();
  let target: URL;
  try { target = new URL(to, origin); } catch { return fallback.toString(); }
  if (target.origin !== origin || target.pathname === "/arrive" || target.pathname.startsWith("/arrive/")
    || target.pathname === "/v1" || target.pathname.startsWith("/v1/")) return fallback.toString();
  target.searchParams.delete(ARRIVAL_PROOF_PARAM);
  target.hash = "";
  return target.toString();
}

type ContextRow = {
  id: string; storefront: Storefront; storefront_origin: string; status: "ACTIVE" | "ROTATED" | "CLOSED";
  bound_customer_id: string | null; successor_id: string | null; created_at: string; expires_at: string;
  retire_reason: string | null; close_state: string | null;
};
type ArrivalRow = {
  id: string; browser_context_id: string; arrival_proof: string | null; state: string;
  claim_deadline_at: string; last_attempt_at: string | null;
};
export type AdmittedContext = { id: string; setCookie?: string };
/** What an LMS request knows of the signed-in account. `undefined`: not checked, so no binding change. */
type Account = { customerId: string | null } | undefined;

export type BrowserContextDependencies = {
  db: Database.Database;
  origins: CommerceOrigins;
  config: BrowserContextConfig;
  exchange?: ArrivalExchange;
  now: () => Date;
  /** Runs work after the response under the process lifecycle (`AfterResponseTasks.schedule`). */
  schedule: (task: () => Promise<void>) => void;
  /** Operator signal: a code and never a proof, context ID, customer or URL. */
  alert?: (code: string) => void;
};

export class BrowserContexts {
  private readonly flights = new Map<string, Promise<void>>();
  private readonly attemptCeilingMs: number;
  private readonly buyBudgetMs: number;
  private readonly retryIntervalMs: number;

  constructor(private readonly deps: BrowserContextDependencies) {
    this.attemptCeilingMs = deps.config.attemptCeilingMs ?? ATTEMPT_CEILING_MS;
    this.buyBudgetMs = deps.config.buyBudgetMs ?? BUY_BUDGET_MS;
    this.retryIntervalMs = deps.config.retryIntervalMs ?? RETRY_INTERVAL_MS;
  }

  private nowIso() { return this.deps.now().toISOString(); }
  /** Work that must not delay the response, under the same lifecycle as the exchange attempts. */
  after(task: () => Promise<void>) { this.deps.schedule(task); }
  private alert(code: string) {
    try { this.deps.alert?.(code); } catch { /* diagnostics never change the buyer's path */ }
  }
  private row(id: string) {
    return this.deps.db.prepare(`SELECT id,storefront,storefront_origin,status,bound_customer_id,successor_id,created_at,expires_at,
      retire_reason,close_state FROM browser_contexts WHERE id=?`).get(id) as ContextRow | undefined;
  }

  cookie(storefront: Storefront, id: string, expiresAt: string) {
    const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - this.deps.now().getTime()) / 1000));
    // Host-scoped (`__Host-`: Secure, Path=/, no Domain), server-only and sent on top-level navigation.
    return `${BROWSER_CONTEXT_COOKIES[storefront]}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  }

  /** The ACTIVE context a presented ID stands for: a Refref-closed context is followed to its re-homed successor. */
  private live(storefront: Storefront, presented: string | undefined) {
    let row = presented ? this.row(presented) : undefined;
    for (let hops = 0; row && row.status === "CLOSED" && row.retire_reason === "REFREF_CLOSED" && row.successor_id && hops < 4; hops++) {
      row = this.row(row.successor_id);
    }
    if (!row || row.storefront !== storefront || row.status !== "ACTIVE" || row.expires_at <= this.nowIso()) return undefined;
    return row;
  }

  private create(storefront: Storefront, customerId: string | null, expiresAt?: string) {
    const created = this.deps.now();
    const id = randomBytes(32).toString("base64url");
    const expires = expiresAt ?? new Date(created.getTime() + this.deps.config.maxAgeSeconds[storefront] * 1000).toISOString();
    this.deps.db.prepare(`INSERT INTO browser_contexts(id,storefront,storefront_origin,bound_customer_id,created_at,expires_at)
      VALUES (?,?,?,?,?,?)`).run(id, storefront, storefrontOrigin(this.deps.origins, storefront),
      storefront === "COURSES" ? customerId : null, created.toISOString(), expires);
    return this.row(id)!;
  }

  /** Retires an LMS context at an account boundary. Its pending proof is abandoned, never migrated. */
  private retire(id: string, reason: "LOGOUT" | "ACCOUNT_SWITCH") {
    const at = this.nowIso();
    const retired = this.deps.db.transaction(() => {
      const changed = this.deps.db.prepare(`UPDATE browser_contexts SET status='ROTATED',retired_at=?,retire_reason=?,close_state='PENDING'
        WHERE id=? AND status='ACTIVE'`).run(at, reason, id).changes;
      this.deps.db.prepare(`UPDATE browser_context_arrivals SET state='ABANDONED',arrival_proof=NULL,settled_at=?
        WHERE browser_context_id=? AND state='PENDING'`).run(at, id);
      return changed > 0;
    }).immediate();
    if (retired) this.deps.schedule(() => this.close(id));
  }

  /**
   * The context this request uses, created only when `create` asks for it or a rotation needs a new ID.
   * For LMS with a known account: an anonymous context is bound at the first sign-in (anonymous click
   * → login → Buy keeps its Arrival); a context bound to another account, or seen signed out, rotates.
   */
  admit(storefront: Storefront, presented: string | undefined, options: { account?: Account; create: boolean }): AdmittedContext | undefined {
    const { account } = options;
    let row = this.live(storefront, presented);
    let rotated = false;
    if (row && storefront === "COURSES" && account) {
      if (row.bound_customer_id === null && account.customerId) {
        const bound = this.deps.db.prepare(`UPDATE browser_contexts SET bound_customer_id=? WHERE id=? AND status='ACTIVE'
          AND bound_customer_id IS NULL`).run(account.customerId, row.id).changes;
        row = bound ? this.row(row.id) : this.live(storefront, row.id);
      }
      if (row && row.bound_customer_id !== null && row.bound_customer_id !== account.customerId) {
        this.retire(row.id, account.customerId ? "ACCOUNT_SWITCH" : "LOGOUT");
        row = undefined;
        rotated = true;
      }
    }
    if (!row && (options.create || rotated)) row = this.create(storefront, storefront === "COURSES" ? account?.customerId ?? null : null);
    if (!row) return undefined;
    return { id: row.id, ...(row.id === presented ? {} : { setCookie: this.cookie(storefront, row.id, row.expires_at) }) };
  }

  /** LMS sign-out: always a new context, whether or not the old one was ever bound. */
  rotateOnLogout(storefront: Storefront, presented: string | undefined): AdmittedContext | undefined {
    if (storefront !== "COURSES") return undefined;
    const row = this.live(storefront, presented);
    if (!row) return undefined;
    this.retire(row.id, "LOGOUT");
    const next = this.create(storefront, null);
    return { id: next.id, setCookie: this.cookie(storefront, next.id, next.expires_at) };
  }

  /** Stores the proof server-side, tied to this context. A repeated landing of the same proof is a no-op. */
  capture(contextId: string, proof: string) {
    if (!ARRIVAL_PROOF.test(proof)) return false;
    const now = this.deps.now();
    return this.deps.db.prepare(`INSERT INTO browser_context_arrivals(id,browser_context_id,proof_sha256,arrival_proof,captured_at,claim_deadline_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(proof_sha256) DO NOTHING`).run(randomUUID(), contextId,
      createHash("sha256").update(proof).digest("hex"), proof, now.toISOString(),
      new Date(now.getTime() + CLAIM_WINDOW_MS).toISOString()).changes > 0;
  }

  /** The cookie that names `id`, for a response whose context changed during the request. */
  cookieFor(storefront: Storefront, id: string) {
    const row = this.row(id);
    return row ? this.cookie(storefront, row.id, row.expires_at) : undefined;
  }

  hasPending(storefront: Storefront, presented: string | undefined) {
    const row = this.live(storefront, presented);
    return row ? this.pending(row.id).length > 0 : false;
  }

  /** The bound LMS account of a live context, so a background retry can skip a context awaiting rotation. */
  boundCustomer(storefront: Storefront, presented: string | undefined) {
    return this.live(storefront, presented)?.bound_customer_id ?? null;
  }

  /** Pending proofs past their window become EXPIRED; their raw proof is cleared. */
  private expireDue(contextId?: string) {
    const at = this.nowIso();
    this.deps.db.prepare(`UPDATE browser_context_arrivals SET state='EXPIRED',arrival_proof=NULL,settled_at=?
      WHERE state='PENDING' AND claim_deadline_at<=? ${contextId ? "AND browser_context_id=?" : ""}`)
      .run(...[at, at, ...(contextId ? [contextId] : [])]);
  }

  private pending(contextId: string) {
    this.expireDue(contextId);
    return this.deps.db.prepare(`SELECT id,browser_context_id,arrival_proof,state,claim_deadline_at,last_attempt_at
      FROM browser_context_arrivals WHERE browser_context_id=? AND state='PENDING' ORDER BY captured_at`).all(contextId) as ArrivalRow[];
  }

  /**
   * One bounded after-response attempt for each due proof of a live context (single-flight per
   * proof, rate-limited). Used by the arrival endpoint and by every later same-context request.
   */
  scheduleExchange(storefront: Storefront, presented: string | undefined) {
    const row = this.live(storefront, presented);
    if (!row) return;
    const due = new Date(this.deps.now().getTime() - this.retryIntervalMs).toISOString();
    for (const arrival of this.pending(row.id)) {
      if (arrival.last_attempt_at && arrival.last_attempt_at > due) continue;
      this.deps.schedule(() => this.attempt(arrival.id, this.attemptCeilingMs, true));
    }
  }

  /** `background`: a later-request retry, skipped when another attempt ran within the retry interval. Buy never skips. */
  private attempt(arrivalId: string, timeoutMs: number, background = false) {
    const running = this.flights.get(arrivalId);
    if (running) return running;
    const flight = this.claim(arrivalId, timeoutMs, background).finally(() => { this.flights.delete(arrivalId); });
    this.flights.set(arrivalId, flight);
    return flight;
  }

  private settle(arrivalId: string, state: "CONFIRMED" | "FAILED", fields: { claimId?: string; eligibleUntil?: string; failureCode?: string }) {
    this.deps.db.prepare(`UPDATE browser_context_arrivals SET state=?,arrival_proof=NULL,claim_id=?,eligible_until=?,failure_code=?,settled_at=?
      WHERE id=? AND state='PENDING'`).run(state, fields.claimId ?? null, fields.eligibleUntil ?? null, fields.failureCode ?? null,
      this.nowIso(), arrivalId);
  }

  private async claim(arrivalId: string, timeoutMs: number, background: boolean) {
    const arrival = this.deps.db.prepare(`SELECT arrival.id,arrival.browser_context_id,arrival.arrival_proof,arrival.state,arrival.claim_deadline_at,
      arrival.last_attempt_at,context.status,context.storefront_origin FROM browser_context_arrivals arrival
      JOIN browser_contexts context ON context.id=arrival.browser_context_id WHERE arrival.id=?`)
      .get(arrivalId) as (ArrivalRow & { status: string; storefront_origin: string }) | undefined;
    if (!arrival || arrival.state !== "PENDING" || arrival.status !== "ACTIVE" || !arrival.arrival_proof) return;
    if (arrival.claim_deadline_at <= this.nowIso()) { this.expireDue(arrival.browser_context_id); return; }
    if (background && arrival.last_attempt_at
      && arrival.last_attempt_at > new Date(this.deps.now().getTime() - this.retryIntervalMs).toISOString()) return;
    if (!this.deps.exchange) {
      this.settle(arrivalId, "FAILED", { failureCode: "EXCHANGE_NOT_CONFIGURED" });
      this.alert("ARRIVAL_EXCHANGE_NOT_CONFIGURED");
      return;
    }
    this.deps.db.prepare("UPDATE browser_context_arrivals SET attempts=attempts+1,last_attempt_at=? WHERE id=? AND state='PENDING'")
      .run(this.nowIso(), arrivalId);
    let outcome: Awaited<ReturnType<ArrivalExchange["claim"]>>;
    try {
      outcome = await this.deps.exchange.claim({ arrivalProof: arrival.arrival_proof, browserContextId: arrival.browser_context_id,
        storefrontOrigin: arrival.storefront_origin }, AbortSignal.timeout(Math.max(1, timeoutMs)));
    } catch { outcome = { kind: "UNKNOWN", code: "TRANSPORT" }; }
    if (outcome.kind === "CONFIRMED") this.settle(arrivalId, "CONFIRMED", { claimId: outcome.claimId, eligibleUntil: outcome.eligibleUntil });
    else if (outcome.kind === "REFUSED") {
      this.settle(arrivalId, "FAILED", { failureCode: outcome.code });
      this.alert("ARRIVAL_CLAIM_REFUSED");
    } else if (outcome.kind === "CONTEXT_CLOSED") this.rehome(arrival.browser_context_id, arrivalId);
    else if (outcome.code === "BROWSER_CONTEXT_IDLE_POLICY_REQUIRED") this.alert("ARRIVAL_IDLE_POLICY_REQUIRED");
  }

  /**
   * Refref closed the context (idle expiry): it is never presented again, and this browser continues
   * in a successor with the same account binding. No account boundary is crossed, so the unclaimed
   * proofs move with it; a successor that is itself refused ends the proof as FAILED.
   */
  private rehome(contextId: string, arrivalId: string) {
    const at = this.nowIso();
    this.deps.db.transaction(() => {
      const old = this.row(contextId);
      if (!old || old.status !== "ACTIVE") return;
      if (this.deps.db.prepare("SELECT 1 FROM browser_contexts WHERE successor_id=?").get(contextId)) {
        this.settle(arrivalId, "FAILED", { failureCode: "CONTEXT_CLOSED" });
        this.alert("ARRIVAL_CONTEXT_CLOSED");
        return;
      }
      const successor = this.create(old.storefront, old.bound_customer_id);
      this.deps.db.prepare(`UPDATE browser_contexts SET status='CLOSED',retired_at=?,retire_reason='REFREF_CLOSED',successor_id=?,
        close_state='ACKNOWLEDGED',close_settled_at=? WHERE id=? AND status='ACTIVE'`).run(at, successor.id, at, contextId);
      this.deps.db.prepare(`UPDATE browser_context_arrivals SET browser_context_id=? WHERE browser_context_id=?
        AND state IN ('PENDING','FAILED','EXPIRED')`).run(successor.id, contextId);
    }).immediate();
  }

  /**
   * Buy: exchange/readback of every pending proof within one wall-clock budget, then the frozen
   * delivery state. Uncertainty marks degradation; it is never proof that no click happened.
   */
  async deliveryForBuy(storefront: Storefront, contextId: string): Promise<{ browserContextId: string; deliveryDegraded: DeliveryDegraded }> {
    const deadline = performance.now() + this.buyBudgetMs;
    let id = contextId;
    for (;;) {
      id = this.live(storefront, id)?.id ?? id;
      const pending = this.pending(id);
      const remaining = deadline - performance.now();
      if (!pending.length || remaining <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled(pending.map((arrival) => this.attempt(arrival.id, Math.min(this.attemptCeilingMs, remaining)))),
        new Promise((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      clearTimeout(timer);
      const left = deadline - performance.now();
      if (left <= 0) break;
      if (this.pending(this.live(storefront, id)?.id ?? id).length) await pause(Math.min(100, left));
    }
    id = this.live(storefront, id)?.id ?? id;
    const deliveryDegraded = this.degradation(id);
    if (deliveryDegraded.degraded) this.alert(`ARRIVAL_DELIVERY_DEGRADED_${deliveryDegraded.reason}`);
    return { browserContextId: id, deliveryDegraded };
  }

  private degradation(contextId: string): DeliveryDegraded {
    this.expireDue(contextId);
    const states = new Set((this.deps.db.prepare(`SELECT DISTINCT state FROM browser_context_arrivals
      WHERE browser_context_id=? AND state IN ('PENDING','FAILED','EXPIRED')`).all(contextId) as Array<{ state: string }>).map(({ state }) => state));
    if (states.has("FAILED")) return { degraded: true, reason: "FAILED" };
    if (states.has("EXPIRED")) return { degraded: true, reason: "EXPIRED" };
    if (states.has("PENDING")) return { degraded: true, reason: "TIMEOUT" };
    return { degraded: false };
  }

  /** Idempotent close of a rotated context, repeated until Refref acknowledges it. Defence in depth only. */
  close(contextId: string) {
    const key = `close:${contextId}`;
    const running = this.flights.get(key);
    if (running) return running;
    const flight = (async () => {
      const row = this.row(contextId);
      if (!row || row.close_state !== "PENDING" || !this.deps.exchange) return;
      let outcome: Awaited<ReturnType<ArrivalExchange["close"]>>;
      try { outcome = await this.deps.exchange.close(contextId, AbortSignal.timeout(this.attemptCeilingMs)); }
      catch { outcome = "UNKNOWN"; }
      const at = this.nowIso();
      if (outcome === "UNKNOWN") {
        this.deps.db.prepare("UPDATE browser_contexts SET close_attempts=close_attempts+1 WHERE id=? AND close_state='PENDING'").run(contextId);
        return;
      }
      this.deps.db.prepare(`UPDATE browser_contexts SET close_state=?,close_attempts=close_attempts+1,close_settled_at=?
        WHERE id=? AND close_state='PENDING'`).run(outcome === "CLOSED" ? "ACKNOWLEDGED" : "REFUSED", at, contextId);
      if (outcome === "REFUSED") this.alert("BROWSER_CONTEXT_CLOSE_REFUSED");
    })().finally(() => { this.flights.delete(key); });
    this.flights.set(key, flight);
    return flight;
  }

  /** Sweep: retry unacknowledged closes, expire raw proof and drop contexts past their cookie lifetime. */
  async maintain(limit = 50) {
    const due = this.deps.db.prepare(`SELECT id FROM browser_contexts WHERE close_state='PENDING' ORDER BY retired_at LIMIT ?`)
      .all(limit) as Array<{ id: string }>;
    for (const { id } of due) await this.close(id);
    this.expireDue();
    this.deps.db.prepare(`DELETE FROM browser_contexts WHERE expires_at<=? AND (close_state IS NULL OR close_state<>'PENDING')`)
      .run(this.nowIso());
  }
}
