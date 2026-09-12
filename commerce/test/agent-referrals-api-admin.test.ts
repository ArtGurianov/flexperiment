import { randomUUID, scryptSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "../src/provider";
import { activateAgentReferrals, agentReferralsFeatureState } from "../src/agent-referrals-feature-state";
import { fresh, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, finalizedSettlement, acceptedAct } from "./support/agent-referrals-settlement-fixtures";

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

/**
 * `/v1/admin/login` allows 5 attempts per 15 minutes per client-IP bucket,
 * and every login here lands in the single shared `untrusted-ingress` bucket
 * because no X-Forwarded-For is sent - which this file had already filled
 * exactly to the limit. Passing one valid IP literal gives a test its own
 * bucket (see trustedClientIp: exactly one IP, no chain), so a new test does
 * not consume another file's-worth of the shared budget. The limit itself is
 * not raised or reset.
 */
const adminCookie = async (app: ReturnType<typeof createApp>, clientIp?: string) => {
  const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
    method: "POST",
    headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/json", ...(clientIp ? { "X-Forwarded-For": clientIp } : {}) },
    body: JSON.stringify({ password: "correct horse" }),
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

  /**
   * The operator kill switch, against an owner the operator does not hold.
   *
   * Production activates through `activateAgentReferralsIfReady`, which mints
   * the owner from `input.activation_id` - an `agent-referrals-activation-*`
   * id, never an admin session subject. The adapter used to pass `adminId` as
   * `owner_id`, so `transitionInTransaction`'s owner check refused every
   * suspend and every reactivate with OWNER_CONFLICT the moment the feature
   * was ACTIVE: the kill switch was unreachable in exactly the state it
   * exists for. These two tests fail with 409 OWNER_CONFLICT without the
   * adapter fix.
   */
  describe("feature-state operator routes: the actor is the admin, the authority is the row's own owner", () => {
    const ACTIVATION_OWNER = "agent-referrals-activation-ce66d23fdcea5fc84018be43cf428270ea889ee8";

    it("suspends and reactivates a feature owned by the activation contour, preserving that owner throughout", async () => {
      const { db, app } = appFixture();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: ACTIVATION_OWNER, reason: "AGENT_REFERRALS_ACTIVATION_V1" });
      const cookie = await adminCookie(app, "203.0.113.10");
      const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };
      expect(agentReferralsFeatureState(db)).toEqual({ state: "ACTIVE", owner_id: ACTIVATION_OWNER, revision: 2 });

      const suspend = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state/suspend", {
        method: "POST", headers, body: JSON.stringify({ expected_revision: 2, reason: "controlled cutover" }),
      });
      expect(suspend.status).toBe(200);
      expect(await suspend.json()).toEqual({ state: "SUSPENDED", owner_id: ACTIVATION_OWNER, revision: 3 });

      const reactivate = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state/reactivate", {
        method: "POST", headers, body: JSON.stringify({ expected_revision: 3, reason: "cutover complete" }),
      });
      expect(reactivate.status).toBe(200);
      expect(await reactivate.json()).toEqual({ state: "ACTIVE", owner_id: ACTIVATION_OWNER, revision: 4 });

      // The projection is not the evidence. The audit chain must agree with it,
      // and must attribute both transitions to the preserved owner - an event
      // naming the admin would be a second, competing authority record.
      expect(db.prepare("SELECT from_state, to_state, owner_id, revision FROM agent_referrals_feature_state_events ORDER BY revision").all()).toEqual([
        { from_state: "DORMANT", to_state: "ACTIVE", owner_id: ACTIVATION_OWNER, revision: 2 },
        { from_state: "ACTIVE", to_state: "SUSPENDED", owner_id: ACTIVATION_OWNER, revision: 3 },
        { from_state: "SUSPENDED", to_state: "ACTIVE", owner_id: ACTIVATION_OWNER, revision: 4 },
      ]);
    });

    it("still refuses a stale expected_revision, and still refuses an illegal edge out of unowned DORMANT", async () => {
      const { db, app } = appFixture();
      activateAgentReferrals(db, { expected_revision: 1, owner_id: ACTIVATION_OWNER, reason: "AGENT_REFERRALS_ACTIVATION_V1" });
      const cookie = await adminCookie(app, "203.0.113.11");
      const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };

      // Preserving the owner must not soften the CAS: revision 1 is already spent.
      const stale = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state/suspend", {
        method: "POST", headers, body: JSON.stringify({ expected_revision: 1, reason: "stale" }),
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe("AGENT_REFERRALS_FEATURE_REVISION_CONFLICT");
      expect(agentReferralsFeatureState(db)).toEqual({ state: "ACTIVE", owner_id: ACTIVATION_OWNER, revision: 2 });

      // The DORMANT fallback is a fallback, not a new edge: unowned DORMANT
      // passes the owner check by construction and is then refused by
      // LEGAL_EDGES, exactly as before the fix.
      const { app: dormantApp } = appFixture();
      const dormantCookie = await adminCookie(dormantApp, "203.0.113.12");
      const illegal = await dormantApp.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state/suspend", {
        method: "POST", headers: { Origin: ADMIN_ORIGIN, Cookie: dormantCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ expected_revision: 1, reason: "not a legal edge" }),
      });
      expect(illegal.status).toBe(409);
      expect((await illegal.json()).error.code).toBe("AGENT_REFERRALS_FEATURE_ILLEGAL_TRANSITION");
    });
  });

  it("channel policy: admin can set and read it back; the partner realm never reaches this route at all (see agent-referrals-partner-authorization.test.ts)", async () => {
    const { app } = appFixture();
    const cookie = await adminCookie(app);
    const headers = { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" };
    const set = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/channel-policy", {
      // dzen carries no policy row yet, so the command is authored against 0.
      method: "POST", headers, body: JSON.stringify({ channel_key: "dzen", status: "ALLOWED", effective_from: "2020-01-01T00:00:00.000Z", reason: "reviewed", expected_policy_revision: 0 }),
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

  it("round-3 fix: the engagement detail response includes the act/payment chain (act, act_acceptance, act_dispute, payment_attempts, paid_invoice) - previously only reachable via a second /settlements/:id round trip", async () => {
    const { db, domain, app } = appFixture();
    const p1 = readyPartner(db, "OTHER");
    const occ = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ, nearTermTerms(1000, "PERCENT", 5000));
    const code = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ, code.code, "customer@example.test", `idem-${randomUUID()}`);
    const settlement = finalizedSettlement(db, domain, occ, engagementId);
    const act = acceptedAct(db, p1.partner, settlement);

    const cookie = await adminCookie(app);
    const detail = await app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/engagements/${engagementId}`, { headers: { Origin: ADMIN_ORIGIN, Cookie: cookie } });
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.act.id).toBe(act.id);
    expect(body.act_acceptance.accepted_amount_kopecks).toBe(act.amount_kopecks);
    expect(body.act_dispute).toBeNull();
    expect(body.payment_attempts).toEqual([]);
    expect(body.paid_invoice).toBeNull();
  });
});
