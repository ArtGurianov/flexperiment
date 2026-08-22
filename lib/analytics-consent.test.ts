import { describe, expect, it } from "vitest";
import {
  ANALYTICS_CONSENT_MAX_AGE_SECONDS,
  analyticsConsentSetCookie,
  analyticsConsentFromCookie,
  parseAnalyticsConsentMarker,
  serializeAnalyticsConsent,
} from "./analytics-consent";
import { storedReferralSlug } from "@/components/referral-marker";

describe("analytics consent marker", () => {
  it("fails closed for absent, malformed, and unknown markers", () => {
    expect(parseAnalyticsConsentMarker(undefined)).toBe("UNDECIDED");
    expect(parseAnalyticsConsentMarker("a1")).toBe("UNDECIDED");
    expect(parseAnalyticsConsentMarker("v2:a1")).toBe("UNDECIDED");
    expect(parseAnalyticsConsentMarker("v1:unknown")).toBe("UNDECIDED");
    expect(analyticsConsentFromCookie("fx_consent=%E0%A4%A")).toBe("UNDECIDED");
  });

  it("parses the two versioned first-party choices only", () => {
    expect(parseAnalyticsConsentMarker("v1:a0")).toBe("DENIED");
    expect(parseAnalyticsConsentMarker("v1:a1")).toBe("ALLOWED");
    expect(analyticsConsentFromCookie("theme=dark; fx_consent=v1%3Aa1")).toBe("ALLOWED");
    expect(serializeAnalyticsConsent("DENIED")).toBe("v1:a0");
    expect(serializeAnalyticsConsent("ALLOWED")).toBe("v1:a1");
    expect(ANALYTICS_CONSENT_MAX_AGE_SECONDS).toBe(365 * 24 * 60 * 60);
    expect(analyticsConsentSetCookie("ALLOWED")).toBe(
      "fx_consent=v1%3Aa1; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
  });

  it("does not interpret or alter the independent functional referral marker", () => {
    for (const consent of ["", "v1%3Aa0", "v1%3Aa1"]) {
      const cookie = `fx_ref=v1%3Aprofessional-promoter${consent ? `; fx_consent=${consent}` : ""}`;
      expect(storedReferralSlug(cookie)).toBe("professional-promoter");
    }
  });
});
