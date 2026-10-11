import type Database from "better-sqlite3";
import { z } from "zod";
import { erasureSubject, ErasureLedgerError, type ErasureKeys, type ErasureSubject } from "./erasure-ledger";

const issued = new WeakSet<VerifiedErasureRequest>();
const authority = Object.freeze({});
const inputSchema = z.object({ requestId: z.string().uuid() }).strict();
const normalize = (value: string) => value.trim().toLocaleLowerCase("en-US");
export type ErasureSession = { user: { id: string; email: string; emailVerified: boolean };
  session: { id: string; userId: string; expiresAt: Date } };
function fail(code: string): never { throw new ErasureLedgerError(code); }
const expires = (value: string) => /^\d{12,13}(?:\.0)?$/.test(value) ? Number(value) : Date.parse(value);

/** Server-derived identity only. An email/support request is NOT this capability.
 * The trusted getSession adapter must use Better Auth, not caller supplied JSON.
 * Neither required-content consent nor marketing is required to request erasure. */
export class VerifiedErasureRequest {
  readonly #sessionId: string;
  readonly #userId: string;
  readonly #customerId: string;
  readonly #email: string;
  private constructor(readonly requestId: string, readonly scope: "canary" | "production",
    readonly subject: ErasureSubject, readonly verifiedAt: number,
    binding: { sessionId: string; userId: string; customerId: string; email: string }, token: object) {
    if (token !== authority) fail("ERASURE_REQUEST_UNVERIFIED");
    this.#sessionId = binding.sessionId; this.#userId = binding.userId;
    this.#customerId = binding.customerId; this.#email = binding.email;
    issued.add(this); Object.freeze(subject); Object.freeze(this);
  }
  static async fromSession(input: { db: Database.Database; headers: Headers; body: unknown;
    scope: "canary" | "production"; keys: ErasureKeys; subjectKeyId: string;
    allowedOrigins: readonly string[]; getSession: (headers: Headers) => Promise<ErasureSession | null>;
    now?: () => Date }) {
    const request = inputSchema.safeParse(input.body);
    const origin = input.headers.get("origin");
    if (!request.success || !origin || !input.allowedOrigins.includes(origin)) fail("ERASURE_REQUEST_INVALID");
    let session: ErasureSession | null;
    try { session = await input.getSession(input.headers); } catch { return fail("ERASURE_REQUEST_UNVERIFIED"); }
    const time = (input.now?.() ?? new Date()).getTime();
    if (!Number.isFinite(time) || !session?.user || !session.session || session.user.emailVerified !== true
      || session.session.userId !== session.user.id || !(session.session.expiresAt instanceof Date)
      || !Number.isFinite(session.session.expiresAt.getTime()) || session.session.expiresAt.getTime() <= time) {
      return fail("ERASURE_REQUEST_UNVERIFIED");
    }
    const binding = input.db.prepare(`SELECT c.id AS customerId,c.email_normalized AS email,u.id AS userId,
      s.id AS sessionId,s.expires_at AS expiresAt,u.email AS userEmail,u.email_verified AS verified
      FROM customers c JOIN "user" u ON u.id=c.auth_user_id JOIN "session" s ON s.user_id=u.id
      WHERE u.id=? AND s.id=?`).get(session.user.id, session.session.id) as
      { customerId: string; email: string; userId: string; sessionId: string; expiresAt: string; userEmail: string; verified: number } | undefined;
    if (!binding || binding.verified !== 1 || !Number.isFinite(expires(binding.expiresAt)) || expires(binding.expiresAt) <= time
      || binding.email !== normalize(binding.userEmail) || binding.email !== normalize(session.user.email)) fail("ERASURE_REQUEST_UNVERIFIED");
    return new VerifiedErasureRequest(request.data.requestId, input.scope,
      erasureSubject(input.keys, input.subjectKeyId, input.scope, { email: binding.email, customerId: binding.customerId, userId: binding.userId }),
      time, binding, authority);
  }
  assertCurrent(db: Database.Database, now = new Date()) {
    VerifiedErasureRequest.assertVerified(this);
    const age = now.getTime() - this.verifiedAt;
    if (!issued.has(this) || !Number.isFinite(age) || age < 0 || age > 60_000) fail("ERASURE_REQUEST_UNVERIFIED");
    const row = db.prepare(`SELECT u.email,u.email_verified,s.expires_at,c.email_normalized FROM "session" s
      JOIN "user" u ON u.id=s.user_id JOIN customers c ON c.auth_user_id=u.id
      WHERE s.id=? AND u.id=? AND c.id=?`).get(this.#sessionId, this.#userId, this.#customerId) as
      { email: string; email_verified: number; expires_at: string; email_normalized: string } | undefined;
    if (!row || row.email_verified !== 1 || normalize(row.email) !== this.#email || row.email_normalized !== this.#email
      || !Number.isFinite(expires(row.expires_at)) || expires(row.expires_at) <= now.getTime()) fail("ERASURE_REQUEST_UNVERIFIED");
  }
  static assertVerified(request: VerifiedErasureRequest) {
    if (!issued.has(request)) fail("ERASURE_REQUEST_UNVERIFIED");
  }
  static assertCurrent(request: VerifiedErasureRequest, db: Database.Database, now = new Date()) {
    VerifiedErasureRequest.assertVerified(request);
    VerifiedErasureRequest.prototype.assertCurrent.call(request, db, now);
  }
  /** Safe serialization never exports auth headers, email, session token or raw IDs. */
  toJSON() { return { requestId: this.requestId, scope: this.scope, subject: this.subject }; }
}

/** Unverified email to art@flexperiment.ru is a case awaiting authenticated proof.
 * There is deliberately no sender-email-to-account deletion API. */
export function pendingManualErasureCase(caseId: string) {
  if (!z.string().uuid().safeParse(caseId).success) fail("ERASURE_REQUEST_INVALID");
  return Object.freeze({ caseId, state: "PENDING_IDENTITY_VERIFICATION" as const });
}
