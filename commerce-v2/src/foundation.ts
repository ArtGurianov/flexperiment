import { serve } from "@hono/node-server";
import { createCommerceV2App } from "./app";
import { readBuildIdentity } from "./build-identity";
import { openV2Database, migrateV2 } from "./db";
import { loadCommerceRuntimeConfig } from "./payment-mode";
import { createRefrefReadinessProbe } from "./readiness";

/** Restricted start of the actual app: no customer/auth/payment routes or external workers. */
export function startFoundation(environment = process.env) {
  if (environment.COMMERCE_V2_FOUNDATION_MODE !== "true") throw new Error("FOUNDATION_MODE_REQUIRED");
  if (!["staging", "production"].includes(environment.DEPLOY_ENV ?? "")) throw new Error("FOUNDATION_DEPLOY_ENV_REQUIRED");
  if (environment.PAYMENT_MODE !== "disabled") throw new Error("FOUNDATION_PAYMENTS_MUST_BE_DISABLED");
  if (environment.MARKETING_BROADCASTS_ENABLED !== "false") throw new Error("FOUNDATION_MARKETING_MUST_BE_DISABLED");
  const serviceToken = environment.PLATFORM_SERVICE_TOKEN;
  if (!serviceToken || serviceToken.length < 32) throw new Error("PLATFORM_SERVICE_TOKEN_REQUIRED");
  const probe = createRefrefReadinessProbe(environment);
  if (environment.COMMERCE_V2_DATABASE_PATH !== "/var/lib/flexperiment-v2/commerce.sqlite") throw new Error("FOUNDATION_DATABASE_PATH_REQUIRED");
  if (!/^(canary|production)$/.test(environment.COMMERCE_V2_ENVIRONMENT ?? "")) throw new Error("FOUNDATION_ENVIRONMENT_REQUIRED");
  if ((environment.COMMERCE_V2_ENVIRONMENT === "production") !== (environment.DEPLOY_ENV === "production")) throw new Error("FOUNDATION_ENVIRONMENT_MISMATCH");
  const identity = readBuildIdentity("commerce-v2", environment);
  if (environment.BUILD_IDENTITY_FILE !== "/app/.identity/identity.json") throw new Error("FOUNDATION_BAKED_IDENTITY_REQUIRED");
  if (!/^[0-9a-f]{40}$/.test(identity.sourceCommit)) throw new Error("SOURCE_COMMIT_REQUIRED");
  const config = loadCommerceRuntimeConfig(environment);
  const db = openV2Database(environment.COMMERCE_V2_DATABASE_PATH);
  migrateV2(db);
  const app = createCommerceV2App({ db, config, sourceCommit: identity.sourceCommit, serviceToken,
    foundationMode: true, probeRefref: probe,
  });
  return serve({ fetch: app.fetch, port: Number(environment.PORT ?? 3002) });
}
