import { AsyncLocalStorage } from "node:async_hooks";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { emailOTP, magicLink } from "better-auth/plugins";
import type { MyOtpEmail } from "./auth-email-delivery";
import { createSessionResolver, loadMyIdentityConfig, type BetterAuthSession, type MyIdentityConfig } from "./my-session";
import { bindVerifiedAuthUser, customerIdForAuthUser, getOrCreateCustomer, recordUnverifiedAccountIntent, type ConsentInput } from "./customers";
import { currentLegalRelease } from "./legal-control";
import { loadCommerceOrigins, storefrontOrigin, type Storefront } from "./origins";
import { assertRegistrationChoices } from "./registration-choices";
import type { ErasureRuntimeFence } from "./erasure-fence";

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export type MagicLinkEmail = { readonly email: string; readonly url: string };
export type AuthRuntimeDependencies = {
  readonly db: Database.Database;
  readonly sendMagicLinkEmail: (message: MagicLinkEmail) => Promise<void>;
  readonly environment?: AuthEnvironment;
  readonly erasureFence?: ErasureRuntimeFence;
  /** FLEX-120: MY sign-in code transport. Without it MY OTP sending fails closed. */
  readonly sendMyOtpEmail?: (message: MyOtpEmail) => Promise<void>;
  /** FLEX-120: defaults to `MY_IDENTITY_MODE` / `MY_ORIGIN` from the environment (mode `off`). */
  readonly myIdentity?: MyIdentityConfig;
};

/** Set only by the MY OTP verify wrapper; the session-create hook stamps `audience='MY'` from it. */
export const myAuthScope = new AsyncLocalStorage<{ readonly surface: "MY" }>();
export const MY_OTP = { length: 6, expiresInSeconds: 600, allowedAttempts: 5 } as const;

const required = (environment: AuthEnvironment, name: string) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

const encryptionKey = (environment: AuthEnvironment, secret: string) => {
  const encoded = environment.AUTH_EMAIL_OUTBOX_KEY;
  if (!encoded) {
    if (environment.NODE_ENV === "production") throw new Error("AUTH_EMAIL_OUTBOX_KEY_REQUIRED");
    return createHash("sha256").update(secret).digest();
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("AUTH_EMAIL_OUTBOX_KEY_INVALID");
  return key;
};

const encrypt = (payload: unknown, key: Buffer) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
};

export const decryptAuthEmailPayload = (encrypted: string, key: Buffer) => {
  const [iv, tag, ciphertext] = encrypted.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) throw new Error("AUTH_EMAIL_PAYLOAD_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")) as MagicLinkEmail;
};

export function createAuthRuntime(dependencies: AuthRuntimeDependencies) {
  const environment = dependencies.environment ?? process.env;
  const production = environment.NODE_ENV === "production" || environment.DEPLOY_ENV === "production";
  const secret = production ? required(environment, "BETTER_AUTH_SECRET") : environment.BETTER_AUTH_SECRET ?? "development-better-auth-secret-change-me";
  const origins = loadCommerceOrigins(environment);
  const baseURL = origins.api;
  const myIdentity = dependencies.myIdentity ?? loadMyIdentityConfig(environment, origins);
  const trustedOrigins = [origins.platform, origins.lab, origins.api, ...(origins.my ? [origins.my] : [])];
  const key = encryptionKey(environment, secret);

  const auth = betterAuth({
    appName: "Flexperiment",
    baseURL,
    basePath: "/v1/auth",
    secret,
    trustedOrigins,
    ...(myIdentity.sharedCookie ? { advanced: {
      useSecureCookies: true,
      cookies: { session_token: {
        name: myIdentity.sharedCookie.name,
        attributes: { domain: myIdentity.sharedCookie.domain },
      } },
    } } : {}),
    database: dependencies.db,
    user: { fields: { createdAt: "created_at", updatedAt: "updated_at", emailVerified: "email_verified" } },
    session: {
      // Ordinary account reads do not forward Better Auth's Set-Cookie. Keep the UTC expiry
      // consistent across the signed browser credential and SQLite by using a fixed lifetime.
      ...(myIdentity.sharedCookie ? { expiresIn: 7 * 24 * 60 * 60, disableSessionRefresh: true } : {}),
      fields: {
        expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at",
        ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id",
      },
      // FLEX-120: written only by the session-create hook below; never client input.
      additionalFields: { audience: { type: "string", required: false, input: false } },
    },
    account: {
      fields: {
        accountId: "account_id", providerId: "provider_id", userId: "user_id", accessToken: "access_token",
        refreshToken: "refresh_token", idToken: "id_token", accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at", createdAt: "created_at", updatedAt: "updated_at",
      },
    },
    verification: { fields: { expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at" } },
    rateLimit: { enabled: true, window: 60, max: 100 },
    plugins: [emailOTP({
      // FLEX-120: called only server-side by my-session-otp.ts; the public /v1/auth router refuses its paths.
      otpLength: MY_OTP.length, expiresIn: MY_OTP.expiresInSeconds, allowedAttempts: MY_OTP.allowedAttempts,
      storeOTP: "hashed", resendStrategy: "rotate", disableSignUp: false,
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") throw new Error("MY_OTP_TYPE_REFUSED");
        const normalized = email.trim().toLocaleLowerCase("en-US");
        dependencies.erasureFence?.assertIdentity({ email: normalized }, "AUTH_MAIL");
        const id = randomUUID();
        dependencies.db.prepare("INSERT INTO my_otp_outbox(id,recipient_normalized,state) VALUES (?,?,'PENDING')").run(id, normalized);
        try {
          if (!dependencies.sendMyOtpEmail) throw new Error("AUTH_EMAIL_NOT_CONFIGURED");
          const send = dependencies.sendMyOtpEmail;
          if (dependencies.erasureFence) await dependencies.erasureFence.send(normalized, () => send({ email: normalized, code: otp }), "AUTH_MAIL");
          else await send({ email: normalized, code: otp });
          dependencies.db.prepare("UPDATE my_otp_outbox SET state='SENT',attempt_count=1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
        } catch (error) {
          dependencies.db.prepare("UPDATE my_otp_outbox SET state='FAILED',attempt_count=1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
            .run(dependencies.erasureFence ? "ERASURE_FENCED_EMAIL_FAILED" : error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message) ? error.message : "EMAIL_SEND_FAILED", id);
          throw error;
        }
      },
    }), magicLink({
      expiresIn: 10 * 60,
      rateLimit: { window: 60, max: 5 },
      storeToken: "hashed",
      sendMagicLink: async ({ email, url, metadata }) => {
        dependencies.erasureFence?.assertIdentity({email},"AUTH_MAIL");
        const storefront = (metadata as { storefront?: unknown } | undefined)?.storefront;
        if (storefront !== "COURSES" && storefront !== "LAB") throw new Error("AUTH_STOREFRONT_REQUIRED");
        const target = new URL(url);
        const publicOrigin = new URL(storefrontOrigin(origins, storefront));
        target.protocol = publicOrigin.protocol;
        target.host = publicOrigin.host;
        const id = randomUUID();
        const normalized = email.trim().toLocaleLowerCase("en-US");
        const payload = { email: normalized, url: target.toString() };
        const serialized = JSON.stringify(payload);
        dependencies.db.prepare(`INSERT INTO auth_email_outbox
          (id,recipient_normalized,kind,encrypted_payload,payload_sha256,state)
          VALUES (?,?, 'MAGIC_LINK', ?, ?, 'PENDING')`)
          .run(id, normalized, encrypt(payload, key), createHash("sha256").update(serialized).digest("hex"));
        try {
          if(dependencies.erasureFence) await dependencies.erasureFence.send(normalized,()=>dependencies.sendMagicLinkEmail(payload),"AUTH_MAIL");
          else await dependencies.sendMagicLinkEmail(payload);
          dependencies.db.prepare(`UPDATE auth_email_outbox SET state='SENT',attempt_count=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
        } catch (error) {
          dependencies.db.prepare(`UPDATE auth_email_outbox SET state='FAILED',attempt_count=1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(dependencies.erasureFence ? "ERASURE_FENCED_EMAIL_FAILED" : error instanceof Error ? error.message.slice(0, 240) : "EMAIL_SEND_FAILED", id);
          throw error;
        }
      },
    })],
    databaseHooks: {
      user: {
        create: {
          before: async user=>{dependencies.erasureFence?.assertIdentity({email:user.email,userId:user.id},"ACCOUNT");},
          after: async (user) => { bindVerifiedAuthUser(dependencies.db, user); },
        },
      },
      session: {create: {before: async session=>{
        dependencies.erasureFence?.assertIdentity({userId:session.userId},"ACCOUNT");
        // FLEX-120: only the MY OTP verify wrapper creates MY sessions; everything else stays LEGACY.
        if (myIdentity.mode === "on" && myAuthScope.getStore()?.surface === "MY") return { data: { ...session, audience: "MY" } };
      }}},
    },
  });

  // Exactly today's resolution; mode `off` uses it verbatim (equivalence is tested route by route).
  async function legacyAuthenticateCustomer(headers: Headers) {
    const session = await auth.api.getSession({ headers });
    if (!session?.user.id) return null;
    dependencies.erasureFence?.assertIdentity({email:session.user.email,userId:session.user.id},"ACCOUNT");
    return customerIdForAuthUser(dependencies.db, session.user.id);
  }
  const resolver = createSessionResolver({
    db: dependencies.db, config: myIdentity, legacyAuthenticate: legacyAuthenticateCustomer,
    getSession: async (headers) => await auth.api.getSession({ headers }) as BetterAuthSession | null,
    assertIdentity: (identity) => dependencies.erasureFence?.assertIdentity(identity, "ACCOUNT"),
  });

  return {
    auth,
    prepareMagicLinkInitiation(input: {
      email: string;
      storefront: Storefront;
      personalDataConsent: boolean;
      accountTermsAccepted: boolean;
      personalDataVersion: string;
      personalDataSha256: string;
      accountTermsVersion: string;
      accountTermsSha256: string;
      marketingConsent?: boolean;
      marketingDocumentVersion: string;
      marketingDocumentSha256: string;
    }) {
      dependencies.erasureFence?.assertIdentity({email:input.email},"ACCOUNT");
      assertRegistrationChoices(input);
      const release = currentLegalRelease(dependencies.db, input.storefront);
      if (!release) throw new Error("LEGAL_RELEASE_NOT_FOUND");
      const document = (kind: string) => release.manifest.documents.find((candidate) => candidate.kind === kind);
      const personalData = document("personal_data");
      const accountTerms = document("account_terms");
      const marketing = document("marketing_consent");
      if (!personalData || !accountTerms || !marketing) throw new Error("LEGAL_RELEASE_INCOMPLETE");
      if (personalData.version !== input.personalDataVersion || personalData.sha256 !== input.personalDataSha256
        || accountTerms.version !== input.accountTermsVersion || accountTerms.sha256 !== input.accountTermsSha256
        || marketing.version !== input.marketingDocumentVersion || marketing.sha256 !== input.marketingDocumentSha256) {
        throw new Error("LEGAL_RELEASE_STALE");
      }
      const customer = getOrCreateCustomer(dependencies.db, input.email);
      const consent: ConsentInput = {
        personalDataVersion: input.personalDataVersion,
        personalDataSha256: input.personalDataSha256,
        accountTermsVersion: input.accountTermsVersion,
        accountTermsSha256: input.accountTermsSha256,
        marketingConsent: input.marketingConsent === true,
        marketingDocumentVersion: input.marketingDocumentVersion,
        marketingDocumentSha256: input.marketingDocumentSha256,
      };
      recordUnverifiedAccountIntent(dependencies.db, customer.id, consent);
    },
    authenticateCustomer: resolver.authenticateCustomer,
    resolveSession: resolver.resolve,
    legacyAuthenticateCustomer,
    myIdentity,
    outboxKey: key,
  };
}
