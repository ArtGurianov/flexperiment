import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { bindVerifiedAuthUser, customerIdForAuthUser, getOrCreateCustomer, recordAccountConsents, type ConsentInput } from "./customers";
import { currentLegalRelease } from "./legal-control";
import { loadCommerceOrigins, storefrontOrigin, type Storefront } from "./origins";

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export type MagicLinkEmail = { readonly email: string; readonly url: string };
export type AuthRuntimeDependencies = {
  readonly db: Database.Database;
  readonly sendMagicLinkEmail: (message: MagicLinkEmail) => Promise<void>;
  readonly environment?: AuthEnvironment;
};

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
  const trustedOrigins = [origins.platform, origins.lab, origins.api];
  const key = encryptionKey(environment, secret);

  const auth = betterAuth({
    appName: "Flexperiment",
    baseURL,
    basePath: "/v1/auth",
    secret,
    trustedOrigins,
    database: dependencies.db,
    user: { fields: { createdAt: "created_at", updatedAt: "updated_at", emailVerified: "email_verified" } },
    session: {
      fields: {
        expiresAt: "expires_at", createdAt: "created_at", updatedAt: "updated_at",
        ipAddress: "ip_address", userAgent: "user_agent", userId: "user_id",
      },
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
    plugins: [magicLink({
      expiresIn: 10 * 60,
      rateLimit: { window: 60, max: 5 },
      storeToken: "hashed",
      sendMagicLink: async ({ email, url, metadata }) => {
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
          await dependencies.sendMagicLinkEmail(payload);
          dependencies.db.prepare(`UPDATE auth_email_outbox SET state='SENT',attempt_count=1,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
        } catch (error) {
          dependencies.db.prepare(`UPDATE auth_email_outbox SET state='FAILED',attempt_count=1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(error instanceof Error ? error.message.slice(0, 240) : "EMAIL_SEND_FAILED", id);
          throw error;
        }
      },
    })],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => { bindVerifiedAuthUser(dependencies.db, user); },
        },
      },
    },
  });

  return {
    auth,
    prepareMagicLinkInitiation(input: {
      email: string;
      storefront: Storefront;
      personalDataConsent: boolean;
      personalDataVersion: string;
      personalDataSha256: string;
      accountTermsVersion: string;
      accountTermsSha256: string;
      marketingConsent?: boolean;
      marketingDocumentVersion: string;
      marketingDocumentSha256: string;
    }) {
      if (input.personalDataConsent !== true) throw new Error("PERSONAL_DATA_CONSENT_REQUIRED");
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
        source: "MAGIC_LINK_INITIATION",
      };
      recordAccountConsents(dependencies.db, customer.id, consent);
    },
    async authenticateCustomer(headers: Headers) {
      const session = await auth.api.getSession({ headers });
      if (!session?.user.id) return null;
      return customerIdForAuthUser(dependencies.db, session.user.id);
    },
    outboxKey: key,
  };
}
