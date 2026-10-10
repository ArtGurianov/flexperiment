import { describe, expect, it, vi } from "vitest";
import { startFoundation } from "../src/foundation";

// Every rejected configuration must stop before opening a database or server.
vi.mock("../src/db", async (load) => ({ ...await load<typeof import("../src/db")>(), openV2Database: vi.fn(() => { throw new Error("DATABASE_MUST_NOT_OPEN"); }) }));
vi.mock("../src/build-identity", () => ({ readBuildIdentity: vi.fn(() => ({ schema: "flexperiment.build-identity/1", service: "commerce-v2", sourceCommit: "a".repeat(40) })) }));
vi.mock("@hono/node-server", () => ({ serve: vi.fn(() => { throw new Error("SERVER_MUST_NOT_START"); }) }));
import { openV2Database } from "../src/db";
import { serve } from "@hono/node-server";

const approved = {
  COMMERCE_V2_FOUNDATION_MODE: "true", COMMERCE_V2_ENVIRONMENT: "production", DEPLOY_ENV: "production",
  PAYMENT_MODE: "disabled", MARKETING_BROADCASTS_ENABLED: "false", PLATFORM_SERVICE_TOKEN: "x".repeat(43),
  COMMERCE_V2_DATABASE_PATH: "/var/lib/flexperiment-v2/commerce.sqlite", BUILD_IDENTITY_FILE: "/app/.identity/identity.json",
  REFREF_READINESS_URL: "https://ops.refref.ru/readyz", MERCHANT_PROMOTION_PREFIX: "FX-", KINESCOPE_DELIVERY_MODE: "open",
};

describe("foundation startup fail-closed configuration", () => {
  it.each([
    ["COMMERCE_V2_FOUNDATION_MODE", undefined, "FOUNDATION_MODE_REQUIRED"],
    ["DEPLOY_ENV", "local", "FOUNDATION_DEPLOY_ENV_REQUIRED"],
    ["PAYMENT_MODE", "mock", "FOUNDATION_PAYMENTS_MUST_BE_DISABLED"],
    ["PAYMENT_MODE", undefined, "FOUNDATION_PAYMENTS_MUST_BE_DISABLED"],
    ["MARKETING_BROADCASTS_ENABLED", "true", "FOUNDATION_MARKETING_MUST_BE_DISABLED"],
    ["PLATFORM_SERVICE_TOKEN", undefined, "PLATFORM_SERVICE_TOKEN_REQUIRED"],
    ["PLATFORM_SERVICE_TOKEN", "short", "PLATFORM_SERVICE_TOKEN_REQUIRED"],
    ["REFREF_READINESS_URL", undefined, "REFREF_READINESS_URL_REQUIRED"],
    ["REFREF_READINESS_URL", "https://foreign.invalid", "REFREF_READINESS_URL_NOT_ALLOWED"],
    ["COMMERCE_V2_DATABASE_PATH", "/var/lib/flexperiment/commerce.sqlite", "FOUNDATION_DATABASE_PATH_REQUIRED"],
    ["COMMERCE_V2_ENVIRONMENT", undefined, "FOUNDATION_ENVIRONMENT_REQUIRED"],
    ["COMMERCE_V2_ENVIRONMENT", "canary", "FOUNDATION_ENVIRONMENT_MISMATCH"],
    ["BUILD_IDENTITY_FILE", undefined, "FOUNDATION_BAKED_IDENTITY_REQUIRED"],
    ["BUILD_IDENTITY_FILE", "/mutable/identity.json", "FOUNDATION_BAKED_IDENTITY_REQUIRED"],
  ])("rejects %s=%s before side effects", (key, value, code) => {
    expect(() => startFoundation({ ...approved, [key!]: value })).toThrow(code);
    expect(openV2Database).not.toHaveBeenCalled(); expect(serve).not.toHaveBeenCalled();
  });
});
