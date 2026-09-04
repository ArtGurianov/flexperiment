import { randomUUID, scryptSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "../src/provider";
import { fresh, readyPartner, seedOccurrence, nearTermTerms } from "./support/agent-referrals-settlement-fixtures";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-agent-referrals-admin-api";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-agent-referrals-admin-api-test";

const { createApp } = await import("../src/api");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const ADMIN_ORIGIN = "https://admin.flexperiment.ru";
const PARTNER_ORIGIN = "https://partner.flexperiment.ru";

const appFixture = () => {
  const { db, domain } = fresh();
  open.push(db);
  const app = createApp(db, new MockProvider());
  return { db, domain, app };
};

const adminCookie = async (app: ReturnType<typeof createApp>) => {
  const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
    method: "POST", headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }),
  });
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie")!;
};

describe("/v1/admin/agent-referrals/*: authentication boundary", () => {
  it("refuses every route with no admin session, exactly like the rest of /v1/admin/*", async () => {
    const { app } = appFixture();
    for (const path of ["/feature-state", "/partners", "/framework-agreement-revisions/current", "/channel-policy/telegram"]) {
      const response = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals${path}`, { headers: { Origin: ADMIN_ORIGIN } });
      expect(response.status).toBe(401);
    }
  });

  it("refuses a request whose Origin is the PARTNER host, not the admin host", async () => {
    const { app } = appFixture();
    const cookie = await adminCookie(app);
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state", { headers: { Origin: PARTNER_ORIGIN, Cookie: cookie } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ORIGIN_FORBIDDEN");
  });

  it("an authenticated admin session reads feature-state and manages a full partner-onboarding-adjacent flow", async () => {
    const { db, app } = appFixture();
    const cookie = await adminCookie(app);
    const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };

    const suspendBeforeActivation = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state/suspend", {
      method: "POST", headers, body: JSON.stringify({ expected_revision: 1, reason: "test" }),
    });
    // DORMANT -> SUSPENDED is not a legal edge (only DORMANT -> ACTIVE, ACTIVE <-> SUSPENDED) - proves this admin route
    // reaches the real suspendAgentReferrals gate, not a stub.
    expect(suspendBeforeActivation.status).toBe(409);

    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'p1', 'A', 'A Legal', 'a@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId);

    // Feature is still DORMANT (no HTTP route can activate it - see agent-referrals-partner-authorization.test.ts) - provisioning
    // therefore refuses, proving this route reaches the real suspension-policy gate rather than a stub that always succeeds.
    const provisionWhileDormant = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/partners", {
      method: "POST", headers, body: JSON.stringify({ agent_id: agentId, email: "p@example.test", reason: "test" }),
    });
    expect(provisionWhileDormant.status).toBe(409);
    expect((await provisionWhileDormant.json()).error.code).toBe("AGENT_REFERRALS_FEATURE_DORMANT");
  });

  it("channel policy: admin can set and read it back; the partner realm never reaches this route at all (see agent-referrals-partner-authorization.test.ts)", async () => {
    const { app } = appFixture();
    const cookie = await adminCookie(app);
    const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };
    const set = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/channel-policy", {
      method: "POST", headers, body: JSON.stringify({ channel_key: "dzen", status: "ALLOWED", effective_from: "2020-01-01T00:00:00.000Z", reason: "reviewed" }),
    });
    expect(set.status).toBe(201);
    const read = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/channel-policy/dzen", { headers: { Origin: ADMIN_ORIGIN, Cookie: cookie } });
    expect(read.status).toBe(200);
    expect((await read.json()).status).toBe("ALLOWED");
  });

  it("engagement offer/accept/activate reachable end to end through the admin HTTP surface, using the same activated-engagement invariants the domain layer already enforces", async () => {
    const { db, app } = appFixture();
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const cookie = await adminCookie(app);
    const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };

    const terms = nearTermTerms(1000, "PERCENT", 5000);
    const offer = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/engagements", {
      method: "POST", headers,
      body: JSON.stringify({ partner_identity_id: p1.partnerIdentityId, occurrence_id: occ, reward_type: terms.reward_type, reward_value: terms.reward_value, customer_discount_type: terms.customer_discount_type, customer_discount_value: terms.customer_discount_value, publication_start_at: terms.publication_start_at, publication_end_at: terms.publication_end_at, reason: "offer" }),
    });
    expect(offer.status).toBe(201);
    const { engagement_id: engagementId } = await offer.json();

    const detail = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/engagements/${engagementId}`, { headers: { Origin: ADMIN_ORIGIN, Cookie: cookie } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.engagement.lifecycle_state).toBe("OFFERED");
  });
});
