import { scryptSync } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider } from "../src/provider";
import { fresh, readyPartner } from "./support/agent-referrals-settlement-fixtures";

process.env.COMMERCE_SESSION_SECRET ??= "test-session-secret-agent-referrals-legal-profile-supersession-api";
process.env.COMMERCE_ADMIN_PASSWORD_SCRYPT ??= `salt:${scryptSync("correct horse", "salt", 64).toString("base64url")}`;
process.env.COMMERCE_AGENT_REFERRALS_OTP_PEPPER ??= "test-otp-pepper-for-agent-referrals-legal-profile-supersession-api";

const { createApp } = await import("../src/api");

const open: Database.Database[] = [];
afterEach(() => { while (open.length) open.pop()!.close(); });

const ADMIN_ORIGIN = "https://admin.flexperiment.ru";

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

/**
 * P1 review fix: submitLegalProfileSupersession did not run the shared
 * legal-profile-matrix validator before its INSERT, so an invalid (or
 * merely out-of-union, via the route's own `as LegalForm` cast) pairing
 * reached 0051's CHECK constraint as a raw SqliteError - which the global
 * error handler (commerce/src/api.ts) does not recognize (no `.status`),
 * surfacing as INTERNAL_ERROR/500 for what is actually a 422. This drives
 * the REAL HTTP route, the one place the unsafe cast actually lives -
 * calling submitLegalProfileSupersession directly would not have caught it.
 */
describe("POST /v1/admin/agent-referrals/partners/:id/legal-profile/change: invalid combinations are a typed 422, never a raw 500", () => {
  const post = async (app: ReturnType<typeof createApp>, cookie: string, partnerIdentityId: string, body: Record<string, unknown>) =>
    app.request(`http://admin.flexperiment.ru/v1/admin/agent-referrals/partners/${partnerIdentityId}/legal-profile/change`, {
      method: "POST", headers: { Origin: ADMIN_ORIGIN, Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

  // full_name/inn are present but deliberately arbitrary here: the
  // combination check (resolveProjectedContractorType) runs BEFORE any
  // requisites-shape validation in normalizeAndValidateLegalProfile, so
  // these values never need to match the (invalid) legal_form's own matrix
  // for REJECTED_COMBINATION to fire first - only their presence matters,
  // since the wire-level legalRequisitesFromBody() requires them unconditionally.
  it.each([
    ["a legal_form outside the LegalForm union entirely (an unchecked cast at the route boundary)", { legal_form: "ALIEN_CORPORATION", tax_mode: "OTHER", reason: "x", full_name: "x", inn: "123456789012" }],
    ["a tax_mode outside the TaxMode union entirely", { legal_form: "LEGAL_ENTITY", tax_mode: "QUANTUM", reason: "x", full_name: "x", inn: "1234567890" }],
    ["a legitimate-enum but rejected pairing: INDIVIDUAL + OTHER", { legal_form: "INDIVIDUAL", tax_mode: "OTHER", reason: "x", full_name: "x", inn: "123456789012" }],
    ["a legitimate-enum but rejected pairing: LEGAL_ENTITY + NPD", { legal_form: "LEGAL_ENTITY", tax_mode: "NPD", reason: "x", full_name: "x", inn: "1234567890" }],
  ])("%s -> 422, no candidate row, no event", async (_label, body) => {
    const { db, app } = appFixture();
    const cookie = await adminCookie(app);
    const p1 = readyPartner(db);

    const before = db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_change_requests").get();
    const response = await post(app, cookie, p1.partnerIdentityId, body);

    expect(response.status).toBe(422);
    const payload = await response.json();
    expect(payload.error.code).toBe("AGENT_REFERRALS_LEGAL_PROFILE_REJECTED_COMBINATION");
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_referrals_legal_profile_change_requests").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM partner_identity_events WHERE event_kind LIKE 'LEGAL_PROFILE_CHANGE%'").get()).toEqual({ n: 0 });
  });

  it("a valid pairing still succeeds through the same route, proving the validator does not over-refuse", async () => {
    const { db, app } = appFixture();
    const cookie = await adminCookie(app);
    const p1 = readyPartner(db);

    const response = await post(app, cookie, p1.partnerIdentityId, {
      legal_form: "LEGAL_ENTITY", tax_mode: "OTHER", reason: "became org", evidence_ref: "egrul.pdf",
      opf: "OOO", full_name: "Romashka LLC", inn: "1234567890", kpp: "123456789", registration_number: "1234567890123", legal_address: "Moscow",
    });
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.state).toBe("PENDING");
  });
});
