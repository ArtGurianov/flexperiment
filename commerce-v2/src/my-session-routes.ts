import type Database from "better-sqlite3";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authenticatedConsentStatus, authenticatedMarketingChoice, hasRequiredAccountConsents, recordAuthenticatedConsents } from "./authenticated-consents";
import { legalManifestHash } from "./legal-control";
import { clientIpOf, maskEmail, sessionAudienceGuard, validReturnTarget, type MyIdentityConfig, type ResolvedSession } from "./my-session";
import { MyOtpRefusal, type createMyOtp } from "./my-session-otp";

/** FLEX-120 MY routes (contract §4, fixture route-audience.json). Registered by app.ts in one block,
 * before the public /v1/auth router so the audience guard runs first. */
const noStore = { "Cache-Control": "no-store" };
const json8k = bodyLimit({ maxSize: 8192, onError: (context) => context.json({ code: "REQUEST_TOO_LARGE" }, 413, noStore) });

export function registerMySessionRoutes(app: Hono, dependencies: {
  readonly db: Database.Database;
  readonly config: MyIdentityConfig;
  readonly otp?: ReturnType<typeof createMyOtp>;
  readonly resolveSession?: (headers: Headers) => Promise<ResolvedSession | null>;
  readonly signOut?: (headers: Headers) => Promise<Response>;
}) {
  const { db, config } = dependencies;
  app.use("/v1/*", sessionAudienceGuard(config));
  if (config.mode !== "on" || !config.origins.my) return;
  const myOrigin = config.origins.my;
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
    const resolved = await dependencies.resolveSession?.(context.req.raw.headers).catch(() => null);
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
    const session = await mySession(context);
    if (!session) return context.json({ code: "SIGN_IN_REQUIRED" }, 401, noStore);
    const customer = db.prepare("SELECT email_normalized AS email,display_name AS displayName,created_at AS createdAt FROM customers WHERE id=?")
      .get(session.customerId) as { email: string; displayName: string | null; createdAt: string };
    return context.json({ ...customer, consentRequired: consentRequired(session.customerId),
      marketing: authenticatedMarketingChoice(db, session.customerId) === true }, 200,
      { "Cache-Control": "private, no-store" });
  });

  app.post("/v1/my/sign-out", async (context) => {
    const refused = sameOrigin(context); if (refused) return refused;
    const session = await mySession(context);
    if (!session) return context.body(null, 204, noStore);
    const response = await dependencies.signOut?.(context.req.raw.headers).catch(() => null);
    // Server-side revocation is authoritative even if Better Auth's own sign-out failed.
    db.prepare('DELETE FROM "session" WHERE id=?').run(session.sessionId);
    for (const cookie of response?.headers.getSetCookie() ?? []) context.header("Set-Cookie", cookie, { append: true });
    await response?.body?.cancel();
    return context.body(null, 204, noStore);
  });
}
