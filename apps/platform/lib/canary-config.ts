type Environment = Readonly<Record<string, string | undefined>>;

export const canaryOrigins = {
  PLATFORM_ORIGIN: "https://canary-platform.flexperiment.ru",
  LAB_ORIGIN: "https://canary-lab.flexperiment.ru",
  ADMIN_ORIGIN: "https://canary-admin.flexperiment.ru",
  API_ORIGIN: "https://canary-api.flexperiment.ru",
} as const;

/** Admit only the reviewed Payload-free closed canary configuration. */
export function validatePlatformCanary(env: Environment = process.env) {
  if (env.PLATFORM_V2_CANARY === undefined || env.PLATFORM_V2_CANARY === "false") return false;
  if (env.PLATFORM_V2_CANARY !== "true") throw new Error("PLATFORM_CANARY_CONFIG_INVALID");
  const valid = Object.entries(canaryOrigins).every(([key, value]) => env[key] === value)
    && /^http:\/\/xzuy7pk5y6ywjr9kh6nsk5ap(?:-\d{8}T\d{6})?:3002$/.test(env.COMMERCE_INTERNAL_ORIGIN ?? "")
    && env.DEPLOY_ENV === "staging"
    && env.PAYMENT_MODE === "disabled"
    && env.MARKETING_BROADCASTS_ENABLED === "false"
    && env.BUILD_IDENTITY_FILE === "/app/.identity/identity.json"
    && /^[a-f0-9]{40}$/.test(env.PLATFORM_EXPECTED_COMMERCE_SHA ?? "")
    && !env.S3_BUCKET
    && !env.PAYLOAD_DATABASE_URL && !env.PAYLOAD_SECRET && !env.PAYLOAD_JOBS_ENABLED;
  if (!valid) throw new Error("PLATFORM_CANARY_CONFIG_INVALID");
  return true;
}
