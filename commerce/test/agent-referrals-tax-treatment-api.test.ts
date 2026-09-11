import { randomUUID, scryptSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "../src/provider";
import { fresh, readyPartner } from "./support/agent-referrals-settlement-fixtures";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-agent-referrals-tax-treatment-api";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-agent-referrals-tax-treatment-api-test";

const { createApp } = await import("../src/api");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const ADMIN_ORIGIN = "https://admin.flexperiment.ru";

/**
 * PR-F review round 3: the tax-treatment HTTP route's own Idempotency-Key
 * wiring - a separate file (not agent-referrals-api-admin.test.ts) purely
 * so this file's own admin-login rate-limit bucket (5 per 15 minutes,
 * shared per test FILE process - see rate-limit.ts) has room for its own
 * login, without pushing that other file over its own budget.
 */
describe("/v1/admin/agent-referrals/partners/:id/tax-treatment", () => {
  it("requires an Idempotency-Key header, and the SAME key replays the SAME row through the real HTTP route", async () => {
    const { db } = fresh();
    open.push(db);
    const app = createApp(db, new MockProvider());
    const p1 = readyPartner(db, "OTHER");

    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST", headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };
    const body = { tax_system: "USN", vat_treatment: "NO_VAT", no_vat_basis: "USN_EXEMPT", effective_from: "2026-01-01", evidence_ref: "ev.pdf", reason: "usn exempt" };

    const missingKey = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/partners/${p1.partnerIdentityId}/tax-treatment`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");

    const key = randomUUID();
    const withKey = { ...headers, "Idempotency-Key": key };
    const first = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/partners/${p1.partnerIdentityId}/tax-treatment`, {
      method: "POST", headers: withKey, body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstJson = await first.json();

    const replay = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/partners/${p1.partnerIdentityId}/tax-treatment`, {
      method: "POST", headers: withKey, body: JSON.stringify(body),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstJson);

    const conflict = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/partners/${p1.partnerIdentityId}/tax-treatment`, {
      method: "POST", headers: withKey, body: JSON.stringify({ ...body, reason: "a genuinely different reason" }),
    });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
