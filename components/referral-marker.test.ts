import { describe, expect, it } from "vitest";
import { captureReferralLanding, referralSlugFromMarker, referralTouchFromLocation, storedReferralSlug } from "./referral-marker";

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

  it("captures an eligible landing touch before checkout and checkout sees it after navigation", async () => {
    let cookie = "fx_ref=v1%3Aold-promoter";
    const captured = await captureReferralLanding("?fx_ref=v1%3Anew-promoter", async (slug) => slug === "new-promoter", (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    expect(captured).toBe(true);
    const checkoutReferralSlug = storedReferralSlug(cookie);
    expect(checkoutReferralSlug).toBe("new-promoter");
    expect(storedReferralSlug(cookie)).toBe("new-promoter");
  });

  it("does not erase an established marker when the landing touch is ineligible", async () => {
    let cookie = "fx_ref=v1%3Aeligible-promoter";
    const captured = await captureReferralLanding("?fx_ref=v1%3Adisabled-promoter", async () => false, (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    expect(captured).toBe(false);
    expect(storedReferralSlug(cookie)).toBe("eligible-promoter");
  });
});
