import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { confirmedCustomerForUser, equalHex, presentedCookie, sha256Hex, validReturnTarget, LMS_SESSION_COOKIE } from "./my-session";

/** FLEX-121 one-time, browser-bound MY → LMS session exchange (contract §6, fixture exchange.json).
 * Commerce owns every row; redemption is one BEGIN IMMEDIATE compare-and-set. Secrets are stored
 * only as SHA-256 and never logged. */
export const EXCHANGE = { seconds: 600, codeSeconds: 60, lmsSessionMaxSeconds: 12 * 3600, maxStates: 3, recentFailureSeconds: 30 } as const;
export const EXCHANGE_STATE_PREFIX = "__Host-flx-lms-x-";
const TX = /^[A-Za-z0-9_-]{22}$/;
const secret = (bytes: number) => randomBytes(bytes).toString("base64url");
const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge))}`;

export class ExchangeRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 429) { super(code); this.name = "ExchangeRefusal"; }
}

type Row = { id: string; status: string; return_path: string; state_sha256: string; code_sha256: string | null; code_expires_at: string | null;
  my_session_id: string | null; customer_id: string | null; expires_at: string; created_at: string; closed_at: string | null };

/** Every `__Host-flx-lms-x-<tx>` cookie the browser presented, in header order. */
export function presentedStates(headers: Headers) {
  const states: Array<{ tx: string; value: string }> = [];
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    const name = separator < 0 ? "" : part.slice(0, separator).trim();
    if (!name.startsWith(EXCHANGE_STATE_PREFIX)) continue;
    const tx = name.slice(EXCHANGE_STATE_PREFIX.length);
    const value = part.slice(separator + 1).trim();
    if (TX.test(tx) && /^[A-Za-z0-9_-]{43}$/.test(value)) states.push({ tx, value });
  }
  return states;
}

export function createSessionExchange(dependencies: { readonly db: Database.Database; readonly now?: () => Date }) {
  const { db } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const iso = (date: Date) => date.toISOString();
  const get = (tx: string) => TX.test(tx) ? db.prepare("SELECT * FROM session_exchanges WHERE id=?").get(tx) as Row | undefined : undefined;
  const fail = (tx: string, code: string, at: string) => db.prepare(`UPDATE session_exchanges SET status='FAILED',failure_code=?,closed_at=?
    WHERE id=? AND status IN ('STARTED','ISSUED')`).run(code, at, tx);

  return {
    /** LMS, buyer's browser. Returns the redirect to my and the cookies the start response sets. */
    start(input: { next: unknown; headers: Headers }) {
      const at = now();
      const presented = presentedStates(input.headers);
      const known = presented.map(state => ({ ...state, row: get(state.tx) }));
      // Anti-loop: a just-failed or cancelled exchange in this browser asks for a manual retry.
      if (known.some(({ row }) => row && ["FAILED", "CANCELED"].includes(row.status) && row.closed_at
        && Date.parse(row.closed_at) > at.getTime() - EXCHANGE.recentFailureSeconds * 1000)) {
        throw new ExchangeRefusal("EXCHANGE_RECENTLY_FAILED", 409);
      }
      const tx = secret(16); const state = secret(32);
      const returnPath = validReturnTarget("LMS", input.next);
      db.prepare(`INSERT INTO session_exchanges(id,audience,return_path,state_sha256,status,created_at,expires_at)
        VALUES (?,'LMS',?,?,'STARTED',?,?)`).run(tx, returnPath, sha256Hex(state), iso(at), iso(new Date(at.getTime() + EXCHANGE.seconds * 1000)));
      const cookies = [cookie(`${EXCHANGE_STATE_PREFIX}${tx}`, state, EXCHANGE.seconds)];
      // Keep at most three states: expire the oldest presented ones (unknown ids first).
      const ordered = [...known].sort((a, b) => (a.row ? Date.parse(a.row.created_at) : -Infinity) - (b.row ? Date.parse(b.row.created_at) : -Infinity));
      for (const evicted of ordered.slice(0, Math.max(0, ordered.length + 1 - EXCHANGE.maxStates))) {
        cookies.push(cookie(`${EXCHANGE_STATE_PREFIX}${evicted.tx}`, "", 0));
      }
      return { tx, cookies };
    },

    /** my: what the continue page may show. Never secrets, never the customer. */
    describe(tx: string) {
      const row = get(tx);
      if (!row) throw new ExchangeRefusal("EXCHANGE_NOT_FOUND", 404);
      const open = ["STARTED", "ISSUED"].includes(row.status) && Date.parse(row.expires_at) > now().getTime();
      return { status: open ? row.status : "CLOSED", target: { surface: "LMS" as const, path: row.return_path } };
    },

    /** my, live MY session: bind (or re-bind after an account switch) and rotate a 60 s code. */
    issue(tx: string, mySession: { sessionId: string; customerId: string }) {
      return db.transaction(() => {
        const at = now();
        const row = get(tx);
        if (!row) throw new ExchangeRefusal("EXCHANGE_NOT_FOUND", 404);
        if (!["STARTED", "ISSUED"].includes(row.status)) throw new ExchangeRefusal("EXCHANGE_CLOSED", 409);
        if (Date.parse(row.expires_at) <= at.getTime()) throw new ExchangeRefusal("EXCHANGE_EXPIRED", 409);
        const code = secret(32);
        db.prepare(`UPDATE session_exchanges SET status='ISSUED',my_session_id=?,customer_id=?,code_sha256=?,code_expires_at=?,issued_at=?
          WHERE id=? AND status IN ('STARTED','ISSUED')`).run(mySession.sessionId, mySession.customerId, sha256Hex(code),
          iso(new Date(at.getTime() + EXCHANGE.codeSeconds * 1000)), iso(at), tx);
        return { code };
      }).immediate();
    },

    cancel(tx: string) {
      const changed = db.prepare(`UPDATE session_exchanges SET status='CANCELED',closed_at=? WHERE id=? AND status IN ('STARTED','ISSUED')`)
        .run(iso(now()), TX.test(tx) ? tx : "").changes;
      if (!changed) throw new ExchangeRefusal("EXCHANGE_CLOSED", 409);
    },

    /** LMS, form POST from my. Missing or wrong browser state never changes the exchange (review item 2);
     * with the right state, a wrong/expired code or an invalid parent burns it. */
    redeem(input: { tx: unknown; code: unknown; headers: Headers }) {
      const tx = typeof input.tx === "string" ? input.tx : "";
      const code = typeof input.code === "string" && /^[A-Za-z0-9_-]{43}$/.test(input.code) ? input.code : "";
      const stateValue = presentedStates(input.headers).find(state => state.tx === tx)?.value;
      const outcome = db.transaction(() => {
        const at = now(); const stamp = iso(at);
        const row = get(tx);
        if (!row) return { refusal: new ExchangeRefusal("EXCHANGE_NOT_FOUND", 404) };
        if (!stateValue) return { refusal: new ExchangeRefusal("EXCHANGE_STATE_MISSING", 403) };
        if (!equalHex(sha256Hex(stateValue), row.state_sha256)) return { refusal: new ExchangeRefusal("EXCHANGE_STATE_MISMATCH", 403) };
        if (row.status !== "ISSUED") return { refusal: new ExchangeRefusal("EXCHANGE_CLOSED", 409) };
        if (Date.parse(row.expires_at) <= at.getTime()) return { refusal: new ExchangeRefusal("EXCHANGE_EXPIRED", 409) };
        const burn = (reason: string, status: 403 | 409) => { fail(tx, reason, stamp); return { refusal: new ExchangeRefusal(reason, status) }; };
        if (!code || !row.code_sha256 || !equalHex(sha256Hex(code), row.code_sha256)) return burn("EXCHANGE_CODE_MISMATCH", 403);
        if (!row.code_expires_at || Date.parse(row.code_expires_at) <= at.getTime()) return burn("EXCHANGE_CODE_EXPIRED", 409);
        const parent = db.prepare(`SELECT id,user_id,expires_at FROM "session" WHERE id=? AND audience='MY' AND expires_at>?`)
          .get(row.my_session_id, stamp) as { id: string; user_id: string; expires_at: string } | undefined;
        if (!parent) return burn("PARENT_SESSION_INVALID", 403);
        if (confirmedCustomerForUser(db, parent.user_id) !== row.customer_id) return burn("ACCOUNT_BINDING_MISMATCH", 403);
        if (db.prepare("UPDATE session_exchanges SET status='REDEEMED',closed_at=? WHERE id=? AND status='ISSUED'").run(stamp, tx).changes !== 1) {
          return { refusal: new ExchangeRefusal("EXCHANGE_CLOSED", 409) };
        }
        // Account switch in this browser: the LMS session it presented is replaced, never reused.
        const previous = presentedCookie(input.headers, LMS_SESSION_COOKIE);
        if (previous) db.prepare("DELETE FROM lms_sessions WHERE token_sha256=?").run(sha256Hex(previous));
        const token = secret(32);
        const expiresAt = Math.min(Date.parse(parent.expires_at), at.getTime() + EXCHANGE.lmsSessionMaxSeconds * 1000);
        db.prepare(`INSERT INTO lms_sessions(id,token_sha256,parent_session_id,customer_id,exchange_id,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), sha256Hex(token), parent.id, row.customer_id, tx, stamp, iso(new Date(expiresAt)));
        return { location: row.return_path, cookies: [cookie(LMS_SESSION_COOKIE, token, (expiresAt - at.getTime()) / 1000),
          cookie(`${EXCHANGE_STATE_PREFIX}${tx}`, "", 0)] };
      }).immediate();
      if ("refusal" in outcome && outcome.refusal) throw outcome.refusal;
      return outcome as { location: string; cookies: string[] };
    },

    /** LMS Navbar "Выйти" (FLEX-121/123 policy): ends the parent MY session; the cascade closes every
     * derived LMS session and open exchange of it. */
    signOutLms(headers: Headers) {
      const token = presentedCookie(headers, LMS_SESSION_COOKIE);
      if (token) {
        db.transaction(() => {
          const row = db.prepare("SELECT parent_session_id FROM lms_sessions WHERE token_sha256=?").get(sha256Hex(token)) as { parent_session_id: string } | undefined;
          if (row) db.prepare('DELETE FROM "session" WHERE id=?').run(row.parent_session_id);
        }).immediate();
      }
      return [cookie(LMS_SESSION_COOKIE, "", 0)];
    },

    /** Isolation qualification / Control Room only: revoke exactly one LMS session. */
    revokeLmsSession(id: string) {
      return db.prepare("DELETE FROM lms_sessions WHERE id=?").run(id).changes === 1;
    },
  };
}
