import { describe, expect, it } from "vitest";
import { referralSlugFromMarker, referralTouchFromLocation, storedReferralSlug } from "./referral-marker";

describe("functional referral marker", () => {
  it("accepts only versioned professional-promoter slugs", () => {
    expect(referralSlugFromMarker("v1:professional-promoter")).toBe("professional-promoter");
    expect(referralSlugFromMarker("professional-promoter")).toBeNull();
    expect(referralSlugFromMarker("v2:professional-promoter")).toBeNull();
  });

  it("reads the marker from a landing URL and first-party cookie", () => {
    expect(referralTouchFromLocation("?fx_ref=v1%3Aprofessional-promoter")).toBe("professional-promoter");
    expect(storedReferralSlug("theme=dark; fx_ref=v1%3Aprofessional-promoter")).toBe("professional-promoter");
  });
});
