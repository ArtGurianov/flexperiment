import { randomBytes, scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHash = process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
const originalSecret = process.env.COMMERCE_SESSION_SECRET;

afterEach(() => {
  vi.resetModules();
  if (originalHash === undefined) delete process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT;
  else process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = originalHash;
  if (originalSecret === undefined) delete process.env.COMMERCE_SESSION_SECRET;
  else process.env.COMMERCE_SESSION_SECRET = originalSecret;
});

describe("Admin password verification", () => {
  it("accepts the versioned binary-salt format emitted by the generator", async () => {
    const password = "correct horse battery staple";
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url");
    process.env.COMMERCE_SESSION_SECRET = "test-session-secret";
    process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = `scrypt:v1:16384:8:1:${salt.toString("base64url")}:${hash}`;
    const { verifyAdminPassword } = await import("../src/auth");
    expect(verifyAdminPassword(password)).toBe(true);
    expect(verifyAdminPassword("wrong password")).toBe(false);
  });

  it("accepts the previously documented base64url-salt compatibility form", async () => {
    const password = "correct horse battery staple";
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url");
    process.env.COMMERCE_SESSION_SECRET = "test-session-secret";
    process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT = `${salt.toString("base64url")}:${hash}`;
    const { verifyAdminPassword } = await import("../src/auth");
    expect(verifyAdminPassword(password)).toBe(true);
  });
});
