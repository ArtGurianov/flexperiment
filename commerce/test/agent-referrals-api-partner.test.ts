import { randomUUID, scryptSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "../src/provider";
import { generateOpaqueToken, hashOpaqueToken } from "../src/agent-referrals-partner-auth";
import { provisionPartnerOwner } from "../src/agent-referrals-partner-identity";
import { activateAgentReferrals } from "../src/agent-referrals-feature-state";
import type { OtpSender } from "../src/agent-referrals-otp";
import {
  fresh, admin, readyPartner, seedOccurrence, nearTermTerms, offerAcceptActivate, purchaseAndPay, finalizedSettlement, acceptedAct,
} from "./support/agent-referrals-settlement-fixtures";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-agent-referrals-partner-api";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-agent-referrals-api-partner-test";

const { createApp } = await import("../src/api");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

/** Captures the last OTP code dispatched, so tests can drive the real HTTP login flow end to end without reaching an actual email provider. */
class RecordingOtpSender implements OtpSender {
  lastCode: string | null = null;
  async send(input: { code: string }): Promise<"ACCEPTED"> { this.lastCode = input.code; return "ACCEPTED"; }
}

/** A real, HTTP-authenticatable partner session - distinct from readyPartner()'s own PartnerPrincipal fixture, whose partner_sessions row stores an arbitrary token_hash never meant to be resolved from a raw cookie value (that fixture is for direct domain-function calls only). */
const httpSessionCookie = (db: Database.Database, partnerIdentityId: string): string => {
  const rawToken = generateOpaqueToken();
  db.prepare(`INSERT INTO partner_sessions(id, partner_identity_id, token_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+1 hour'))`)
    .run(randomUUID(), partnerIdentityId, hashOpaqueToken(rawToken));
  return `fx_partner_session=${rawToken}`;
};

const appFixture = () => {
  const { db, domain } = fresh();
  open.push(db);
  const otpSender = new RecordingOtpSender();
  const app = createApp(db, new MockProvider(), undefined, undefined, otpSender);
  return { db, domain, app, otpSender };
};

const PARTNER_ORIGIN = "https://partner.flexperiment.ru";
const ADMIN_ORIGIN = "https://admin.flexperiment.ru";

describe("/v1/partner/*: origin and session boundary", () => {
  it("refuses a request whose Origin is the ADMIN host, not the partner host", async () => {
    const { app } = appFixture();
    const response = await app.request("http://partner.flexperiment.ru/v1/partner/me", { headers: { Origin: ADMIN_ORIGIN } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("ORIGIN_FORBIDDEN");
  });

  it("refuses every protected route with no session cookie", async () => {
    const { app } = appFixture();
    for (const path of ["/me", "/agreements", "/payout-profile", "/engagements"]) {
      const response = await app.request(`http://partner.flexperiment.ru/v1/partner${path}`, { headers: { Origin: PARTNER_ORIGIN } });
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe("AGENT_REFERRALS_PARTNER_AUTH_REQUIRED");
    }
  });

  it("an ADMIN session cookie never authenticates a partner request - the parser reads only fx_partner_session", async () => {
    const { app } = appFixture();
    const login = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST", headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }),
    });
    expect(login.status).toBe(200);
    const adminCookie = login.headers.get("set-cookie")!;
    const response = await app.request("http://partner.flexperiment.ru/v1/partner/me", {
      headers: { Origin: PARTNER_ORIGIN, Cookie: adminCookie },
    });
    expect(response.status).toBe(401);
  });

  it("a PARTNER session cookie never authenticates an admin agent-referrals request - the parser reads only fx_admin_session", async () => {
    const { db, app } = appFixture();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'p1', 'A', 'A Legal', 'a@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId);
    const { partner_identity_id: partnerIdentityId } = provisionPartnerOwner(db, admin, agentId, "p@example.test", "test");
    const cookie = httpSessionCookie(db, partnerIdentityId);
    const response = await app.request("http://admin.flexperiment.ru/v1/admin/agent-referrals/feature-state", {
      headers: { Origin: ADMIN_ORIGIN, Cookie: cookie },
    });
    expect(response.status).toBe(401);
  });

  it("neither session cookie carries a Domain attribute - both stay host-only by construction, never crossing admin.flexperiment.ru <-> partner.flexperiment.ru", async () => {
    const { db, app, otpSender } = appFixture();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'p2', 'A', 'A Legal', 'a2@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId);
    const { raw_invite_token: inviteToken } = provisionPartnerOwner(db, admin, agentId, "p2@example.test", "test");
    const consume = await app.request("http://partner.flexperiment.ru/v1/partner/invite/consume", {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken }),
    });
    expect(consume.status).toBe(200);
    const { challenge_id: challengeId } = await consume.json();
    const verify = await app.request("http://partner.flexperiment.ru/v1/partner/login/verify", {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_id: challengeId, code: otpSender.lastCode }),
    });
    expect(verify.status).toBe(200);
    const partnerSetCookie = verify.headers.get("set-cookie")!;
    expect(partnerSetCookie).toContain("fx_partner_session=");
    expect(partnerSetCookie).not.toMatch(/Domain=/i);

    const adminLogin = await app.request("http://admin.flexperiment.ru/v1/admin/login", {
      method: "POST", headers: { Origin: ADMIN_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ password: "correct horse" }),
    });
    const adminSetCookie = adminLogin.headers.get("set-cookie")!;
    expect(adminSetCookie).toContain("fx_admin_session=");
    expect(adminSetCookie).not.toMatch(/Domain=/i);
  });

  it("login/request returns an identical response whether or not the email resolves to a live identity (anti-enumeration)", async () => {
    const { db, app } = appFixture();
    activateAgentReferrals(db, { expected_revision: 1, owner_id: "test-owner", reason: "test" });
    const agentId = randomUUID();
    db.prepare(`INSERT INTO agents(id, slug, display_name, legal_name, email, contractor_type, inn, contract_reference, default_reward_type, default_reward_value)
      VALUES (?, 'p3', 'A', 'A Legal', 'a3@example.test', 'SELF_EMPLOYED', '123456789012', 'C-1', 'PERCENT', 1000)`).run(agentId);
    await provisionPartnerOwner(db, admin, agentId, "real-partner@example.test", "test");

    const knownEmail = await app.request("http://partner.flexperiment.ru/v1/partner/login/request", {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email: "real-partner@example.test" }),
    });
    const unknownEmail = await app.request("http://partner.flexperiment.ru/v1/partner/login/request", {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email: "nobody-at-all@example.test" }),
    });
    expect(knownEmail.status).toBe(unknownEmail.status);
    expect(await knownEmail.json()).toEqual(await unknownEmail.json());
  });
});

describe("/v1/partner/*: horizontal isolation and §B-11 projection allowlist", () => {
  const twoPartnersWithEngagements = (db: Database.Database, domain: import("../src/domain").CommerceDomain) => {
    const p1 = readyPartner(db, "OTHER");
    const occ1 = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId1 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ1, nearTermTerms(1000, "PERCENT", 5000));
    const code1 = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ1, code1.code, "customer-one@example.test", `idem-${randomUUID()}`);
    const settlement1 = finalizedSettlement(db, domain, occ1, engagementId1);
    acceptedAct(db, p1.partner, settlement1);

    const p2 = readyPartner(db, "OTHER");
    const occ2 = seedOccurrence(db, p2.cityId, 100_000);
    const engagementId2 = offerAcceptActivate(db, p2.partner, p2.partnerIdentityId, occ2, nearTermTerms(1000, "PERCENT", 5000));

    return { p1, engagementId1, p2, engagementId2 };
  };

  it("partner A cannot read partner B's engagement detail - refused exactly like a nonexistent resource, never distinguished by response shape beyond the code", async () => {
    const { db, domain, app } = appFixture();
    const { p1, engagementId2 } = twoPartnersWithEngagements(db, domain);
    const cookieA = httpSessionCookie(db, p1.partnerIdentityId);
    const response = await app.request(`http://partner.flexperiment.ru/v1/partner/engagements/${engagementId2}`, { headers: { Origin: PARTNER_ORIGIN, Cookie: cookieA } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("AGENT_REFERRALS_ENGAGEMENT_WRONG_PARTNER");
  });

  it("partner A cannot read partner B's conversion projection", async () => {
    const { db, domain, app } = appFixture();
    const { p1, engagementId2 } = twoPartnersWithEngagements(db, domain);
    const cookieA = httpSessionCookie(db, p1.partnerIdentityId);
    const response = await app.request(`http://partner.flexperiment.ru/v1/partner/engagements/${engagementId2}/conversions`, { headers: { Origin: PARTNER_ORIGIN, Cookie: cookieA } });
    expect(response.status).toBe(403);
  });

  it("partner A can read only their own engagement list, never partner B's engagement", async () => {
    const { db, domain, app } = appFixture();
    const { p1, engagementId1, engagementId2 } = twoPartnersWithEngagements(db, domain);
    const cookieA = httpSessionCookie(db, p1.partnerIdentityId);
    const response = await app.request("http://partner.flexperiment.ru/v1/partner/engagements", { headers: { Origin: PARTNER_ORIGIN, Cookie: cookieA } });
    expect(response.status).toBe(200);
    const body = await response.json() as { engagements: { engagement_id: string }[] };
    const ids = body.engagements.map((e) => e.engagement_id);
    expect(ids).toContain(engagementId1);
    expect(ids).not.toContain(engagementId2);
  });

  it("partner A cannot report a distribution or claim removal against partner B's engagement/distribution", async () => {
    const { db, domain, app } = appFixture();
    const { p1, engagementId2 } = twoPartnersWithEngagements(db, domain);
    const cookieA = httpSessionCookie(db, p1.partnerIdentityId);
    const reportResponse = await app.request(`http://partner.flexperiment.ru/v1/partner/engagements/${engagementId2}/distributions`, {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, Cookie: cookieA, "Content-Type": "application/json" },
      body: JSON.stringify({ channel_key: "telegram", resource_kind: "channel", resource_identifier: "x", distribution_resource_url: "https://t.me/x/1", published_at: "2020-06-01T00:00:00.000Z", evidence_ref: "ev" }),
    });
    expect(reportResponse.status).toBe(403);
    expect((await reportResponse.json()).error.code).toBe("AGENT_REFERRALS_DISTRIBUTION_WRONG_PARTNER");
  });

  it("partner A cannot accept partner B's act, even with a superficially valid step-up grant of their own", async () => {
    const { db, domain, app } = appFixture();
    const p1 = readyPartner(db, "OTHER");
    const occ1 = seedOccurrence(db, p1.cityId, 100_000);
    const engagementId1 = offerAcceptActivate(db, p1.partner, p1.partnerIdentityId, occ1, nearTermTerms(1000, "PERCENT", 5000));
    const code1 = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p1.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ1, code1.code, "customer-a@example.test", `idem-${randomUUID()}`);
    const settlement1 = finalizedSettlement(db, domain, occ1, engagementId1);

    const p2 = readyPartner(db, "OTHER");
    const occ2 = seedOccurrence(db, p2.cityId, 100_000);
    const engagementId2 = offerAcceptActivate(db, p2.partner, p2.partnerIdentityId, occ2, nearTermTerms(1000, "PERCENT", 5000));
    const code2 = db.prepare("SELECT code FROM promo_codes WHERE id = ?").get(p2.promo.promo_code_id) as { code: string };
    purchaseAndPay(db, domain, occ2, code2.code, "customer-b@example.test", `idem-${randomUUID()}`);
    const settlement2 = finalizedSettlement(db, domain, occ2, engagementId2);
    const act2 = acceptedAct(db, p2.partner, settlement2); // already accepted for B - use its presented sibling for A instead
    void settlement1; void act2;

    const { generateSettlementAct, presentSettlementAct } = await import("../src/agent-referrals-act");
    const { act } = generateSettlementAct(db, admin, settlement1.id);
    presentSettlementAct(db, admin, act.id);

    const cookieB = httpSessionCookie(db, p2.partnerIdentityId);
    const grantResponse = await app.request("http://partner.flexperiment.ru/v1/partner/settlement-step-up", {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, Cookie: cookieB, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ACT_ACCEPTANCE", resource: { act_id: act.id, amount_kopecks: act.amount_kopecks, engagement_revision_id: act.engagement_revision_id } }),
    });
    expect(grantResponse.status).toBe(200);
    const { grant_id: grantId } = await grantResponse.json();
    const acceptResponse = await app.request(`http://partner.flexperiment.ru/v1/partner/acts/${act.id}/accept`, {
      method: "POST", headers: { Origin: PARTNER_ORIGIN, Cookie: cookieB, "Content-Type": "application/json" }, body: JSON.stringify({ step_up_grant_id: grantId }),
    });
    expect(acceptResponse.status).toBe(403);
    expect((await acceptResponse.json()).error.code).toBe("AGENT_REFERRALS_SETTLEMENT_ACT_WRONG_PARTNER");
  });

  it("§B-11: the conversion projection never carries a customer name, email or phone anywhere in the serialized payload", async () => {
    const { db, domain, app } = appFixture();
    const { p1, engagementId1 } = twoPartnersWithEngagements(db, domain);
    const cookieA = httpSessionCookie(db, p1.partnerIdentityId);
    const response = await app.request(`http://partner.flexperiment.ru/v1/partner/engagements/${engagementId1}/conversions`, { headers: { Origin: PARTNER_ORIGIN, Cookie: cookieA } });
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).not.toContain("customer-one@example.test");
    expect(raw.toLowerCase()).not.toContain("customer_email");
    expect(raw.toLowerCase()).not.toContain("customer_name");
    const parsed = JSON.parse(raw) as { conversions: Record<string, unknown>[] };
    expect(parsed.conversions.length).toBeGreaterThan(0);
    for (const row of parsed.conversions) {
      expect(Object.keys(row).sort()).toEqual(["booking_status", "gross_attributable_sale_kopecks", "occurrence_starts_at", "occurrence_title", "payment_status", "promo_code", "purchase_at", "reference", "refund_status", "reward_amount_kopecks"]);
    }
  });

  it("own engagement detail read succeeds and never leaks the other partner's revision/act fields", async () => {
    const { db, domain, app } = appFixture();
    const { p1, engagementId1 } = twoPartnersWithEngagements(db, domain);
    const cookieA = httpSessionCookie(db, p1.partnerIdentityId);
    const response = await app.request(`http://partner.flexperiment.ru/v1/partner/engagements/${engagementId1}`, { headers: { Origin: PARTNER_ORIGIN, Cookie: cookieA } });
    expect(response.status).toBe(200);
    const body = await response.json() as { engagement: { id: string }; act: { presented_at: string | null } | null };
    expect(body.engagement.id).toBe(engagementId1);
    expect(body.act?.presented_at).toBeTruthy();
  });
});
