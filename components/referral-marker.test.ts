import { describe, expect, it } from "vitest";
import { createReferralCaptureCoordinator } from "./referral-capture-state";
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

  it("captures an eligible initial landing touch", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "";
    await expect(coordinator.capture("?fx_ref=v1%3Anew-promoter", async (slug) => slug === "new-promoter", (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; })).resolves.toBe(true);
    expect(storedReferralSlug(cookie)).toBe("new-promoter");
  });

  it("replaces the established marker on a later eligible client-side navigation", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Aold-promoter";
    await coordinator.capture("?fx_ref=v1%3Anew-promoter", async (slug) => slug === "new-promoter", (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    expect(storedReferralSlug(cookie)).toBe("new-promoter");
  });

  it("does not erase an established marker when a later navigation touch is ineligible", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Aeligible-promoter";
    await expect(coordinator.capture("?fx_ref=v1%3Adisabled-promoter", async () => false, (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; })).resolves.toBe(false);
    expect(storedReferralSlug(cookie)).toBe("eligible-promoter");
  });

  it("makes checkout wait for an in-flight eligible landing capture before reading the marker", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Astale-promoter";
    let resolveEligibility!: (eligible: boolean) => void;
    const eligibility = new Promise<boolean>((resolve) => { resolveEligibility = resolve; });
    const capture = coordinator.capture("?fx_ref=v1%3Afresh-promoter", async () => eligibility, (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    let checkoutObserved: string | null | undefined;
    const checkout = coordinator.waitForCurrentCapture().then(() => { checkoutObserved = storedReferralSlug(cookie); });

    await Promise.resolve();
    expect(checkoutObserved).toBeUndefined();
    resolveEligibility(true);
    await Promise.all([capture, checkout]);
    expect(checkoutObserved).toBe("fresh-promoter");
  });
});
