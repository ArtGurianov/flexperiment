import { afterEach, expect, it, vi } from "vitest";
import { canaryOrigins, validatePlatformCanary } from "../lib/canary-config";
import { assertCommerceReady } from "../lib/canary-readiness";
const env = { ...canaryOrigins, PLATFORM_V2_CANARY: "true", COMMERCE_INTERNAL_ORIGIN: "http://xzuy7pk5y6ywjr9kh6nsk5ap:3002",
  DEPLOY_ENV: "staging", PAYMENT_MODE: "refref", MARKETING_BROADCASTS_ENABLED: "false", BUILD_IDENTITY_FILE: "/app/.identity/identity.json",
  PLATFORM_EXPECTED_COMMERCE_SHA: "a".repeat(40), CLOSED_PAID_TEST_PROFILE: "art39-test-course-rub1-v1", CLOSED_PAID_TEST_REFREF_SOURCE: "b".repeat(40),
  CLOSED_PAID_TEST_LEGAL_VERSION: "synthetic-paid", CLOSED_PAID_TEST_LEGAL_SHA256: "c".repeat(64),
  REFREF_API_BASE_URL: "https://api.refref.ru/v1-rc", REFREF_CHECKOUT_ORIGIN: "https://checkout.refref.ru", REFREF_READINESS_URL: "https://ops.refref.ru/readyz" };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("admits the bound profile and refuses a bare payment flip/foreign dependency", () => {
  expect(validatePlatformCanary(env)).toBe(true);
  expect(() => validatePlatformCanary({ ...env, CLOSED_PAID_TEST_PROFILE: undefined })).toThrow();
  expect(() => validatePlatformCanary({ ...env, REFREF_READINESS_URL: "https://canary-ops.refref.ru/readyz" })).toThrow();
});
it("requires upstream profile identity in addition to healthy matching source/payment mode", async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const ready = { ok: true, service: "commerce-v2", sourceCommit: env.PLATFORM_EXPECTED_COMMERCE_SHA, foundationMode: false,
    core: { database: "ok", paymentMode: "refref", closedPaidTestProfile: env.CLOSED_PAID_TEST_PROFILE,
      closedPaidTestLegalSha256: env.CLOSED_PAID_TEST_LEGAL_SHA256, closedPaidTestRefrefSource: env.CLOSED_PAID_TEST_REFREF_SOURCE }, capabilities: { refref: "ready" } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(ready))
    .mockResolvedValueOnce(Response.json({ ...ready, core: { database: "ok", paymentMode: "refref" } })));
  await expect(assertCommerceReady()).resolves.toBeUndefined();
  await expect(assertCommerceReady()).rejects.toThrow("CANARY_COMMERCE_UNAVAILABLE");
});
