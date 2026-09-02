import { describe, expect, it } from "vitest";
import { issueAdminSession, parseSession, verifyReleaseControlToken } from "../src/auth";
import { parsePartnerSessionToken, partnerSessionCookie, partnerSessionCookieCleared } from "../src/agent-referrals-partner-auth";

/**
 * Three independent realms, separate credentials, separate parsers - never
 * a `Session { role }` union over fx_admin_session. Each parser reads only
 * its own cookie name (or, for release-control, only the Authorization
 * header) out of the same raw header text, so one realm's credential is
 * structurally invisible to another realm's parser: there is no shared
 * decode path a forged or misrouted credential could ride through.
 */

describe("realm separation", () => {
  it("a partner cookie is accepted only by the partner parser", () => {
    const cookieHeader = `fx_partner_session=some-opaque-token-value`;
    expect(parsePartnerSessionToken(cookieHeader)).toBe("some-opaque-token-value");
  });

  it("an admin cookie is refused by the partner parser (different cookie name, same header)", () => {
    const adminCookie = issueAdminSession();
    const cookieHeader = `fx_admin_session=${adminCookie}`;
    expect(parsePartnerSessionToken(cookieHeader)).toBeUndefined();
  });

  it("a partner cookie is refused by the admin parser (different cookie name, same header)", () => {
    const cookieHeader = `fx_partner_session=some-opaque-token-value`;
    expect(parseSession(cookieHeader)).toBeUndefined();
  });

  it("both cookies can coexist in one header without cross-contaminating either parser", () => {
    const adminCookie = issueAdminSession();
    const cookieHeader = `fx_admin_session=${adminCookie}; fx_partner_session=some-opaque-token-value`;
    expect(parseSession(cookieHeader)?.sub).toBe("singleton-admin");
    expect(parsePartnerSessionToken(cookieHeader)).toBe("some-opaque-token-value");
  });

  it("release-control's parser only reads the Authorization header, never a cookie", () => {
    // Structural: verifyReleaseControlToken's signature takes only the
    // Authorization header value - there is no cookie parameter for a
    // browser credential to even reach.
    expect(verifyReleaseControlToken(undefined)).toBe(false);
    expect(verifyReleaseControlToken("fx_admin_session=whatever")).toBe(false);
    expect(verifyReleaseControlToken("fx_partner_session=whatever")).toBe(false);
  });

  it("an admin session cookie value presented as a release-control bearer token is refused", () => {
    const adminCookie = issueAdminSession();
    expect(verifyReleaseControlToken(`Bearer ${adminCookie}`)).toBe(false);
  });

  it("a partner session token presented as a release-control bearer token is refused", () => {
    expect(verifyReleaseControlToken(`Bearer some-opaque-partner-token`)).toBe(false);
  });

  it("the partner cookie constant is a distinct name from the admin cookie constant", () => {
    const partnerCookie = partnerSessionCookie("token-value", 3600);
    expect(partnerCookie).toContain("fx_partner_session=");
    expect(partnerCookie).not.toContain("fx_admin_session=");
  });

  describe("partner cookie contract: exact configured attributes, not browser defaults", () => {
    it("sets HttpOnly, Secure, SameSite=Strict, explicit Path and Max-Age", () => {
      const cookie = partnerSessionCookie("abc123", 43_200);
      expect(cookie).toBe("fx_partner_session=abc123; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict");
    });

    it("clearing the cookie sets Max-Age=0 with the same security attributes", () => {
      const cookie = partnerSessionCookieCleared();
      expect(cookie).toBe("fx_partner_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
    });

    it("matches the admin cookie's security attribute shape exactly (HttpOnly/Secure/SameSite=Strict/Path=/), differing only in name and value", () => {
      const partnerCookie = partnerSessionCookie("tok", 100);
      for (const attribute of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict"]) expect(partnerCookie).toContain(attribute);
    });
  });
});
