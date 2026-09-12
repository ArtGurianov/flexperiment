import { scryptSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockProvider } from "../src/provider";
import { fresh } from "./support/agent-referrals-settlement-fixtures";
import { DomainError } from "../src/domain";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-server-fault-observability";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-server-fault-observability";

const { createApp } = await import("../src/api");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); vi.restoreAllMocks(); });

/**
 * A 500 from this API is a corruption signal - AGENT_REFERRALS_LEGAL_PROFILE_
 * POINTER_DIVERGED, AGENT_REFERRALS_ACTIVATION_BINDING_CORRUPTED and the
 * other D2 invariants fail closed into one rather than repairing themselves.
 *
 * A 503 is NOT: this API uses it for ordinary temporary unavailability
 * (SALES_TEMPORARILY_PAUSED, CAPTCHA_UNAVAILABLE, the unconfigured-webhook
 * pair, and more). The first version of this suite used `>= 500` and would
 * have emitted a fault line on every request while sales were paused -
 * burying the signal at exactly the moment it matters.
 *
 * Production has nothing else that would notice: the Traefik in front runs
 * with no --accesslog and no --metrics.prometheus, no APM is configured in
 * the commerce container's environment, and this app installs no
 * request-logging middleware. Both typed branches of onError returned BEFORE
 * its console.error, so such a 500 reached the client and left no trace
 * anywhere - and the container stays healthy, so an uptime check stays green.
 *
 * These cases pin the one property that makes those invariants observable at
 * all, and the boundary that keeps the signal readable.
 */
describe("server faults are recorded; refusals are not", () => {
  const appWithRoute = (error: unknown) => {
    const { db } = fresh();
    open.push(db);
    const app = createApp(db, new MockProvider());
    app.get("/v1/public/__fault", () => { throw error; });
    return app;
  };

  /** The shape every agent-referrals module's own Error subclass has, which onError matches structurally rather than by class. */
  class DuckTypedModuleError extends Error {
    constructor(readonly code: string, readonly status: number) { super(code); }
  }

  it.each([
    ["a DomainError 500", new DomainError("AGENT_REFERRALS_CONTRACTOR_TYPE_PROJECTION_DIVERGED", 500)],
    ["a duck-typed module 500", new DuckTypedModuleError("AGENT_REFERRALS_LEGAL_PROFILE_POINTER_DIVERGED", 500)],
  ])("%s is logged, with its code and status and nothing else", async (_label, error) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await appWithRoute(error).request("http://localhost/v1/public/__fault");

    expect(response.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(["commerce server fault", (error as { code: string }).code, 500]);
  });

  it.each([
    ["a 409 refusal", new DuckTypedModuleError("AGENT_REFERRALS_INVITE_CAPABILITY_STALE", 409)],
    ["a 422 refusal", new DomainError("AGENT_REFERRALS_LEGAL_PROFILE_REJECTED_COMBINATION", 422)],
    ["a 404", new DomainError("PARTNER_IDENTITY_NOT_FOUND", 404)],
    // 503 is this API's ordinary "temporarily unavailable", not corruption.
    // SALES_TEMPORARILY_PAUSED is the case that matters most: it would emit
    // a fault line on EVERY request for as long as sales are paused, burying
    // the signal this channel exists for at the worst possible moment.
    ["a paused-sales 503", new DomainError("SALES_TEMPORARILY_PAUSED", 503)],
    ["an unavailable-provider 503", new DomainError("PROVIDER_RECONCILIATION_UNAVAILABLE", 503)],
    ["an unavailable-captcha 503", new DuckTypedModuleError("CAPTCHA_UNAVAILABLE", 503)],
  ])("%s is NOT logged - only a 500 is a corruption signal", async (_label, error) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await appWithRoute(error).request("http://localhost/v1/public/__fault");

    expect(response.status).not.toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an untyped throw still reaches the pre-existing catch-all", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await appWithRoute(new Error("boom")).request("http://localhost/v1/public/__fault");

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: "INTERNAL_ERROR" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  /**
   * A demonstration, not the proof. The real guarantee is structural: the
   * production helper's signature is (code, status), so it never receives
   * the error or any request context and has nothing to leak. This case
   * would not catch a future helper that took the error again - a reviewer
   * reading the signature would.
   */
  it("the logged line carries no request content - only the code and the status", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await appWithRoute(new DuckTypedModuleError("AGENT_REFERRALS_ACTIVATION_BINDING_CORRUPTED", 500))
      .request("http://localhost/v1/public/__fault?partner=pi-secret-1");

    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("pi-secret-1");
    expect(logged).toContain("AGENT_REFERRALS_ACTIVATION_BINDING_CORRUPTED");
  });
});
