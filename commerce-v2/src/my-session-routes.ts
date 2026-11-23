import { accountSessionScope, type AccountSessionScope } from "./shared-account-routes";
import type Database from "better-sqlite3";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticatedConsentStatus, authenticatedMarketingChoice, hasRequiredAccountConsents, recordAuthenticatedConsents } from "./authenticated-consents";
import { legalManifestHash } from "./legal-control";
import { clientIpOf, maskEmail, sessionAudienceGuard, surfaceForRequest, validReturnTarget, type MyIdentityConfig, type ResolvedSession } from "./my-session";
import { IpWindowLimiter, MyOtpRefusal, type createMyOtp } from "./my-session-otp";
import { ExchangeRefusal, type createSessionExchange } from "./session-exchange";

/** FLEX-120 MY routes (contract §4, fixture route-audience.json). Registered by app.ts in one block,
 * before the public /v1/auth router so the audience guard runs first. */
const noStore = { "Cache-Control": "no-store" };
const json8k = bodyLimit({ maxSize: 8192, onError: (context) => context.json({ code: "REQUEST_TOO_LARGE" }, 413, noStore) });

export function registerMySessionRoutes(app: Hono, dependencies: {
  readonly db: Database.Database;
  readonly config: MyIdentityConfig;
  readonly otp?: ReturnType<typeof createMyOtp>;
  readonly resolveSession?: (headers: Headers, scope?: AccountSessionScope) => Promise<ResolvedSession | null>;
  readonly signOut?: (headers: Headers) => Promise<Response>;
  readonly exchange?: ReturnType<typeof createSessionExchange>;
}) {
  const { db, config } = dependencies;
  app.use("/v1/*", sessionAudienceGuard(config));
  if (config.mode !== "on" || !config.origins.my) return;
  const myOrigin = config.origins.my;
  const exchange = config.sharedCookie ? undefined : dependencies.exchange;
  const sameOrigin = (context: Context) => {
    const origin = context.req.header("origin");
    if (!origin) return context.json({ code: "ORIGIN_REQUIRED" }, 403, noStore);
    if (origin !== myOrigin) return context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    return null;
  };
  const body = async (context: Context) => {
    try {
      const value = await context.req.json() as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch { return null; }
  };
  const mySession = async (context: Context) => {
    const resolved = await dependencies.resolveSession?.(context.req.raw.headers, accountSessionScope(context)).catch(() => null);
    return resolved?.surface === "MY" && resolved.kind === "MY" ? resolved : null;
  };
  const refusal = (context: Context, error: unknown) => error instanceof MyOtpRefusal
    ? context.json({ code: error.code }, error.status, noStore)
    : context.json({ code: "MY_OTP_UNAVAILABLE" }, 503, noStore);

  app.post("/v1/my/otp/send", json8k, async (context) => {
    const refused = sameOrigin(context); if (refused) return refused;
    const input = await body(context); if (!input) return context.json({ code: "REQUEST_INVALID" }, 400, noStore);
    if (!dependencies.otp) return context.json({ code: "MY_OTP_UNAVAILABLE" }, 503, noStore);
    try { return context.json(await dependencies.otp.send(input, clientIpOf(context.req.raw.headers)), 202, noStore); }
    catch (error) { return refusal(context, error); }
  });

  app.post("/v1/my/otp/verify", json8k, async (context) => {
    const refused = sameOrigin(context); if (refused) return refused;
    const input = await body(context); if (!input) return context.json({ code: "REQUEST_INVALID" }, 400, noStore);
    if (!dependencies.otp) return context.json({ code: "MY_OTP_UNAVAILABLE" }, 503, noStore);
    try {
      const result = await dependencies.otp.verify(input, context.req.raw.headers, clientIpOf(context.req.raw.headers));
      for (const cookie of result.cookies) context.header("Set-Cookie", cookie, { append: true });
      return context.json({ accountCreated: result.accountCreated, next: validReturnTarget("MY", input.next) }, 200, noStore);
    } catch (error) { return refusal(context, error); }
  });

  app.get("/v1/my/legal", (context) => {
    const release = dependencies.otp?.accountRelease();
    return release ? context.json({ ...release, manifestSha256: legalManifestHash(release.manifest) }, 200, noStore)
      : context.json({ code: "LEGAL_RELEASE_NOT_FOUND" }, 404, noStore);
  });

  // The account consent action itself (contract §4): the user's exact, separate choices are recorded
  // as authenticated evidence against the governing edition; a UI flag never substitutes for it.
  const consentRequired = (customerId: string) => {
    const storefront = dependencies.otp?.accountLegalStorefront;
    return storefront ? !authenticatedConsentStatus(db, customerId, storefront).requiredChoicesConfirmed : !hasRequiredAccountConsents(db, customerId);
  };
  app.get("/v1/my/consents", async (context) => {
    const session = await mySession(context);
    if (!session) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    const storefront = dependencies.otp?.accountLegalStorefront;
    if (!storefront) return context.json({ code: "LEGAL_RELEASE_NOT_FOUND" }, 404, noStore);
    const actionKey = context.req.query("actionKey");
    try { return context.json(authenticatedConsentStatus(db, session.customerId, storefront, actionKey), 200, noStore); }
    catch { return context.json({ code: "CONSENT_ACTION_KEY_INVALID" }, 422, noStore); }
  });
  app.post("/v1/my/consents", json8k, async (context) => {
    const refused = sameOrigin(context); if (refused) return refused;
    const session = await mySession(context);
    if (!session) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    const storefront = dependencies.otp?.accountLegalStorefront;
    if (!storefront) return context.json({ code: "LEGAL_RELEASE_NOT_FOUND" }, 409, noStore);
    const input = await body(context); if (!input) return context.json({ code: "AUTHENTICATED_CONSENT_INPUT_INVALID" }, 422, noStore);
    if (!Number.isSafeInteger(input.expectedActionSequence) || (input.expectedActionSequence as number) < 0) {
      return context.json({ code: "CONSENT_PRECONDITION_REQUIRED" }, 422, noStore);
    }
    try {
      return context.json(recordAuthenticatedConsents(db, session.customerId, { storefront,
        releaseVersion: input.releaseVersion as string, manifestSha256: input.manifestSha256 as string, actionKey: input.actionKey as string,
        personalDataConsent: input.personalDataConsent as boolean, accountTermsAccepted: input.accountTermsAccepted as boolean,
        marketingConsent: input.marketingConsent as boolean, expectedActionSequence: input.expectedActionSequence as number }), 200, noStore);
    } catch (error) {
      const allowed = ["VERIFIED_ACCOUNT_REQUIRED", "LEGAL_RELEASE_NOT_FOUND", "LEGAL_RELEASE_INCOMPLETE", "LEGAL_RELEASE_STALE",
        "AUTHENTICATED_CONSENT_INPUT_INVALID", "CONSENT_ACTION_KEY_CONFLICT", "CONSENT_STATE_STALE"];
      return context.json({ code: error instanceof Error && allowed.includes(error.message) ? error.message : "CONSENT_WRITE_UNCONFIRMED" }, 409, noStore);
    }
  });

  // Navbar/background read: never redirects, never an error for a signed-out browser.
  app.get("/v1/my/session", async (context) => {
    const session = await mySession(context);
    if (!session) return context.json({ signedIn: false }, 200, noStore);
    const email = db.prepare("SELECT email_normalized FROM customers WHERE id=?").pluck().get(session.customerId) as string;
    return context.json({ signedIn: true, emailMasked: maskEmail(email), consentRequired: consentRequired(session.customerId) }, 200, noStore);
  });

  app.get("/v1/my/profile", async (context) => {
    if (config.sharedCookie && context.req.header("origin") && context.req.header("origin") !== myOrigin) {
      return context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    }
    const session = await mySession(context);
    if (!session) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    const customer = db.prepare("SELECT email_normalized AS email,display_name AS displayName,created_at AS createdAt FROM customers WHERE id=?")
      .get(session.customerId) as { email: string; displayName: string | null; createdAt: string };
    return context.json({ ...customer, consentRequired: consentRequired(session.customerId),
      marketing: authenticatedMarketingChoice(db, session.customerId) === true }, 200,
      { "Cache-Control": "private, no-store" });
  });

  // ---- FLEX-121 exchange (contract §6). ----
  const platformOrigin = config.origins.platform;
  const redeemLimiter = new IpWindowLimiter(20, 60_000);
  const exchangeRefusal = (context: Context, error: unknown) => {
    if (!(error instanceof ExchangeRefusal)) return context.json({ code: "EXCHANGE_UNAVAILABLE" }, 503, noStore);
    // Code only: never the exchange id, state, code, cookie or customer.
    if (["EXCHANGE_STATE_MISSING", "EXCHANGE_STATE_MISMATCH"].includes(error.code)) {
      try { console.warn(JSON.stringify({ event: "LMS_EXCHANGE_REFUSED", code: error.code })); } catch { /* diagnostics only */ }
    }
    return context.json({ code: error.code }, error.status, noStore);
  };
  const lmsSurface = (context: Context) => surfaceForRequest(config.origins, context.req.raw.headers) === "LMS";

  app.get("/v1/my/exchange/:tx", async (context) => {
    if (!exchange) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    try {
      const signedIn = !!await mySession(context);
      return context.json({ ...exchange.describe(context.req.param("tx")), signedIn }, 200, noStore);
    } catch (error) { return exchangeRefusal(context, error); }
  });
  app.post("/v1/my/exchange/:tx/issue", async (context) => {
    const refused = sameOrigin(context); if (refused) return refused;
    if (!exchange) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    const session = await mySession(context);
    if (!session) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    try {
      const { code } = exchange.issue(context.req.param("tx"), session);
      return context.json({ code, redeemUrl: new URL("/auth/lms/redeem", platformOrigin).toString() }, 200, noStore);
    } catch (error) { return exchangeRefusal(context, error); }
  });
  app.post("/v1/my/exchange/:tx/cancel", (context) => {
    const refused = sameOrigin(context); if (refused) return refused;
    if (!exchange) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    try { exchange.cancel(context.req.param("tx")); return context.body(null, 204, noStore); }
    catch (error) { return exchangeRefusal(context, error); }
  });

  // Called server-to-server by the platform `/auth/lms/start` handler (no browser Origin; §7 exception).
  app.post("/v1/lms/exchange/start", json8k, async (context) => {
    if (!lmsSurface(context) || !exchange) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    const input = await body(context) ?? {};
    try {
      const { tx, cookies } = exchange.start({ next: input.next, headers: context.req.raw.headers });
      for (const cookie of cookies) context.header("Set-Cookie", cookie, { append: true });
      return context.json({ location: `${myOrigin}/continue?tx=${tx}` }, 200, noStore);
    } catch (error) { return exchangeRefusal(context, error); }
  });
  // The auto-submitting form on my posts here through the platform `/auth/lms/redeem` handler.
  app.post("/v1/lms/exchange/redeem", json8k, async (context) => {
    if (!lmsSurface(context) || !exchange) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    const origin = context.req.header("origin");
    if (!origin) return context.json({ code: "ORIGIN_REQUIRED" }, 403, noStore);
    if (origin !== myOrigin) return context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    if (!redeemLimiter.consume(clientIpOf(context.req.raw.headers), Date.now())) return context.json({ code: "RATE_LIMITED" }, 429, noStore);
    const input = await body(context) ?? {};
    try {
      const { location, cookies } = exchange.redeem({ tx: input.tx, code: input.code, headers: context.req.raw.headers });
      for (const cookie of cookies) context.header("Set-Cookie", cookie, { append: true });
      return context.json({ location }, 200, noStore);
    } catch (error) { return exchangeRefusal(context, error); }
  });
  const navbarProfile = (session: ResolvedSession | null | undefined) => {
    if (!session) return { signedIn: false };
    const profile = db.prepare("SELECT email_normalized,display_name FROM customers WHERE id=?").get(session.customerId) as
      { email_normalized: string; display_name: string | null } | undefined;
    if (!profile) return { signedIn: false };
    const name = profile.display_name?.trim();
    const displayName = name && name.length <= 80 && !name.includes("@") ? name : null;
    return { signedIn: true, displayName, emailMasked: maskEmail(profile.email_normalized) };
  };
  app.get("/v1/lms/session", async (context) => {
    if (!lmsSurface(context)) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    const session = await dependencies.resolveSession?.(context.req.raw.headers, accountSessionScope(context));
    return context.json(navbarProfile(session?.surface === "LMS" && session.kind === (config.sharedCookie ? "MY" : "LMS") ? session : null),
      200, noStore);
  });

  app.post("/v1/lms/sign-out", (context) => {
    if (!lmsSurface(context) || !exchange) return context.json({ code: "NOT_FOUND" }, 404, noStore);
    const origin = context.req.header("origin");
    if (!origin) return context.json({ code: "ORIGIN_REQUIRED" }, 403, noStore);
    if (origin !== platformOrigin) return context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
    for (const cookie of exchange.signOutLms(context.req.raw.headers)) context.header("Set-Cookie", cookie, { append: true });
    return context.body(null, 204, noStore);
  });

  const revokeMySession = async (context: Context) => {
    const session = await mySession(context);
    if (!session) return context.body(null, 204, noStore);
    const response = await dependencies.signOut?.(context.req.raw.headers).catch(() => null);
    // Server-side revocation remains authoritative if the library could not clear the browser cookie.
    db.prepare('DELETE FROM "session" WHERE id=?').run(session.sessionId);
    for (const cookie of response?.headers.getSetCookie() ?? []) context.header("Set-Cookie", cookie, { append: true });
    await response?.body?.cancel();
    return context.body(null, 204, noStore);
  };
  app.post("/v1/my/sign-out", async (context) => sameOrigin(context) ?? await revokeMySession(context));

  if (config.sharedCookie) {
    const fromStorefront = (context: Context) => {
      const origin = context.req.header("origin");
      return origin === config.origins.platform || origin === config.origins.lab;
    };
    // Only the MY proxy supplies CORS and only for these two routes. Commerce independently checks the origin.
    app.get("/v1/my/storefront-session", async (context) => fromStorefront(context)
      ? context.json(navbarProfile(await mySession(context)), 200, noStore)
      : context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore));
    app.post("/v1/my/storefront-sign-out", async (context) => {
      if (!fromStorefront(context) || context.req.header("x-flex-navbar") !== "1") {
        return context.json({ code: "ORIGIN_FORBIDDEN" }, 403, noStore);
      }
      return revokeMySession(context);
    });
  }
}
