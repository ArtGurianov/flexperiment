import type Database from "better-sqlite3";
import { getOrCreateCustomer, normalizeEmail, recordUnverifiedAccountIntent, type ConsentInput } from "./customers";
import { currentLegalRelease } from "./legal-control";
import { myAuthScope } from "./auth";
import { assertRegistrationChoices } from "./registration-choices";
import type { Storefront } from "./origins";
import type { ErasureRuntimeFence } from "./erasure-fence";

/** FLEX-120 OTP sign-in on my. Contract §4. Every refusal code is a closed enum; no e-mail,
 * code or token ever reaches a log line or a response other than the caller's own cookie. */
export const MY_OTP_LIMITS = {
  resendCooldownSeconds: 60, perEmail15Min: 3, perEmail24h: 10, sendPerIpPerMinute: 5, verifyPerIpPerMinute: 10,
} as const;
export const OTP_SENT = { status: "CODE_SENT_IF_ALLOWED", resendAfterSeconds: MY_OTP_LIMITS.resendCooldownSeconds } as const;

export class MyOtpRefusal extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 422 | 429 | 503) { super(code); this.name = "MyOtpRefusal"; }
}

/** In-process per-IP windows. Invariant: exactly one Commerce instance per environment (contract §4). */
export class IpWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  consume(key: string | undefined, now: number) {
    const bucket = key ?? "unknown";
    const recent = (this.hits.get(bucket) ?? []).filter(at => at > now - this.windowMs);
    if (recent.length >= this.max) { this.hits.set(bucket, recent); return false; }
    recent.push(now); this.hits.set(bucket, recent);
    if (this.hits.size > 50_000) for (const [entry, times] of this.hits) if (!times.some(at => at > now - this.windowMs)) this.hits.delete(entry);
    return true;
  }
}

export type MyOtpSendInput = {
  email?: unknown; captchaToken?: unknown;
  personalDataConsent?: unknown; accountTermsAccepted?: unknown; marketingConsent?: unknown;
  personalDataVersion?: unknown; personalDataSha256?: unknown; accountTermsVersion?: unknown; accountTermsSha256?: unknown;
  marketingDocumentVersion?: unknown; marketingDocumentSha256?: unknown;
};
type AuthApi = {
  sendVerificationOTP(input: { body: { email: string; type: "sign-in" }; headers?: Headers }): Promise<unknown>;
  signInEmailOTP(input: { body: { email: string; otp: string }; headers: Headers; asResponse: true }): Promise<Response>;
  getSession(input: { headers: Headers }): Promise<{ session: { id: string; token: string; audience?: string | null } } | null>;
};
const text = (value: unknown, max = 256) => typeof value === "string" && value.length <= max ? value : "";

export function createMyOtp(dependencies: {
  readonly db: Database.Database;
  readonly api: AuthApi;
  /** The legal storefront whose account documents govern my (FLEX-125). Unset ⇒ send is refused. */
  readonly accountLegalStorefront?: Storefront;
  readonly verifyCaptcha?: (token: string, ip?: string) => Promise<boolean>;
  readonly erasureFence?: ErasureRuntimeFence;
  readonly now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());
  const sendLimiter = new IpWindowLimiter(MY_OTP_LIMITS.sendPerIpPerMinute, 60_000);
  const verifyLimiter = new IpWindowLimiter(MY_OTP_LIMITS.verifyPerIpPerMinute, 60_000);
  const { db } = dependencies;

  const throttled = (email: string) => {
    const at = now().getTime();
    const since = (seconds: number) => new Date(at - seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
    const count = (seconds: number) => (db.prepare(`SELECT COUNT(*) n FROM my_otp_outbox
      WHERE recipient_normalized=? AND datetime(created_at)>datetime(?)`).get(email, since(seconds)) as { n: number }).n;
    return count(MY_OTP_LIMITS.resendCooldownSeconds) > 0 || count(15 * 60) >= MY_OTP_LIMITS.perEmail15Min
      || count(24 * 3600) >= MY_OTP_LIMITS.perEmail24h;
  };

  return {
    /** Always resolves to the generic answer once the request itself is valid (no enumeration). */
    async send(input: MyOtpSendInput, clientIp: string | undefined): Promise<typeof OTP_SENT> {
      try { assertRegistrationChoices(input); }
      catch (error) { throw new MyOtpRefusal((error as Error).message, 422); }
      const email = normalizeEmail(text(input.email, 254));
      if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new MyOtpRefusal("EMAIL_INVALID", 422);
      if (dependencies.verifyCaptcha && !await dependencies.verifyCaptcha(text(input.captchaToken, 4096), clientIp)) {
        throw new MyOtpRefusal("SMARTCAPTCHA_REJECTED", 422);
      }
      if (!sendLimiter.consume(clientIp, now().getTime())) throw new MyOtpRefusal("RATE_LIMITED", 429);
      const storefront = dependencies.accountLegalStorefront;
      const release = storefront ? currentLegalRelease(db, storefront) : null;
      if (!release) throw new MyOtpRefusal("LEGAL_RELEASE_NOT_FOUND", 503);
      const document = (kind: string) => release.manifest.documents.find(candidate => candidate.kind === kind);
      const personalData = document("personal_data"); const accountTerms = document("account_terms"); const marketing = document("marketing_consent");
      if (!personalData || !accountTerms || !marketing) throw new MyOtpRefusal("LEGAL_RELEASE_INCOMPLETE", 503);
      if (personalData.version !== input.personalDataVersion || personalData.sha256 !== input.personalDataSha256
        || accountTerms.version !== input.accountTermsVersion || accountTerms.sha256 !== input.accountTermsSha256
        || marketing.version !== input.marketingDocumentVersion || marketing.sha256 !== input.marketingDocumentSha256) {
        throw new MyOtpRefusal("LEGAL_RELEASE_STALE", 422);
      }
      try { dependencies.erasureFence?.assertIdentity({ email }, "ACCOUNT"); }
      catch { return OTP_SENT; }
      if (throttled(email)) return OTP_SENT;
      const customer = getOrCreateCustomer(db, email);
      const consent: ConsentInput = {
        personalDataVersion: personalData.version, personalDataSha256: personalData.sha256,
        accountTermsVersion: accountTerms.version, accountTermsSha256: accountTerms.sha256,
        marketingConsent: input.marketingConsent === true,
        marketingDocumentVersion: marketing.version, marketingDocumentSha256: marketing.sha256,
      };
      recordUnverifiedAccountIntent(db, customer.id, consent, now().toISOString());
      // A send failure is recorded in my_otp_outbox; the answer stays generic.
      try { await dependencies.api.sendVerificationOTP({ body: { email, type: "sign-in" } }); } catch { /* generic */ }
      return OTP_SENT;
    },

    /** On success returns the MY Set-Cookie header(s) only — the plugin's JSON body (with the
     * session token) never reaches the browser. The previously presented MY session is revoked. */
    async verify(input: { email?: unknown; otp?: unknown }, headers: Headers, clientIp: string | undefined) {
      if (!verifyLimiter.consume(clientIp, now().getTime())) throw new MyOtpRefusal("RATE_LIMITED", 429);
      const email = normalizeEmail(text(input.email, 254));
      const otp = text(input.otp, 16);
      if (!email || !/^\d{6}$/.test(otp)) throw new MyOtpRefusal("OTP_INVALID_OR_EXPIRED", 400);
      const previous = await dependencies.api.getSession({ headers }).catch(() => null);
      const existed = !!db.prepare('SELECT 1 FROM "user" WHERE lower(trim(email))=?').get(email);
      const response = await myAuthScope.run({ surface: "MY" }, () =>
        dependencies.api.signInEmailOTP({ body: { email, otp }, headers, asResponse: true })).catch(() => null);
      if (!response?.ok) {
        const body = await response?.json().catch(() => null) as { code?: string } | null;
        if (body?.code === "TOO_MANY_ATTEMPTS") throw new MyOtpRefusal("TOO_MANY_ATTEMPTS", 403);
        throw new MyOtpRefusal("OTP_INVALID_OR_EXPIRED", 400);
      }
      const cookies = response.headers.getSetCookie();
      await response.body?.cancel();
      // Another account (or a fresh sign-in) in this browser revokes the earlier MY session; the
      // FK cascade removes its exchanges and derived LMS sessions (contract §8).
      if (previous?.session.id) db.prepare('DELETE FROM "session" WHERE id=?').run(previous.session.id);
      return { cookies, accountCreated: !existed };
    },
  };
}

/** FLEX-125 is open: until the owner names the governing account edition, MY OTP send stays refused. */
export function myAccountLegalStorefront(value: string | undefined): Storefront | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "COURSES" && value !== "LAB") throw new Error("MY_ACCOUNT_LEGAL_STOREFRONT_INVALID");
  return value;
}
