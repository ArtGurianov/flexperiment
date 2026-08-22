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
    await expect(coordinator.ensure("?fx_ref=v1%3Anew-promoter", async (slug) => slug === "new-promoter", (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; })).resolves.toBe(true);
    expect(storedReferralSlug(cookie)).toBe("new-promoter");
  });

  it("replaces the established marker on a later eligible client-side navigation", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Aold-promoter";
    await coordinator.ensure("?fx_ref=v1%3Anew-promoter", async (slug) => slug === "new-promoter", (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    expect(storedReferralSlug(cookie)).toBe("new-promoter");
  });

  it("does not erase an established marker when a later navigation touch is ineligible", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Aeligible-promoter";
    await expect(coordinator.ensure("?fx_ref=v1%3Adisabled-promoter", async () => false, (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; })).resolves.toBe(false);
    expect(storedReferralSlug(cookie)).toBe("eligible-promoter");
  });

  it("makes checkout wait for an in-flight eligible landing capture before reading the marker", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Astale-promoter";
    let resolveEligibility!: (eligible: boolean) => void;
    const eligibility = new Promise<boolean>((resolve) => { resolveEligibility = resolve; });
    const capture = coordinator.ensure("?fx_ref=v1%3Afresh-promoter", async () => eligibility, (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    let checkoutObserved: string | null | undefined;
    const checkout = coordinator.waitForCurrentCapture().then(() => { checkoutObserved = storedReferralSlug(cookie); });

    await Promise.resolve();
    expect(checkoutObserved).toBeUndefined();
    resolveEligibility(true);
    await Promise.all([capture, checkout]);
    expect(checkoutObserved).toBe("fresh-promoter");
  });

  it("deduplicates global capture and checkout for the same navigation observation", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let calls = 0;
    let resolveEligibility!: (eligible: boolean) => void;
    const eligibility = new Promise<boolean>((resolve) => { resolveEligibility = resolve; });
    const first = coordinator.ensure("?fx_ref=v1%3Afresh-promoter", async () => { calls += 1; return eligibility; }, () => undefined);
    const second = coordinator.ensure("?fx_ref=v1%3Afresh-promoter", async () => { calls += 1; return true; }, () => undefined);

    expect(second).toBe(first);
    expect(calls).toBe(0);
    resolveEligibility(true);
    await expect(first).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("does not revalidate or rewrite the marker after the current touch has settled", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let eligibilityCalls = 0;
    let markerWrites = 0;
    const write = () => { markerWrites += 1; };
    const global = coordinator.ensure("?fx_ref=v1%3Aa-promoter", async () => { eligibilityCalls += 1; return true; }, write, "/city?fx_ref=v1%3Aa-promoter");
    await expect(global).resolves.toBe(true);
    const checkout = coordinator.ensure("?fx_ref=v1%3Aa-promoter", async () => { eligibilityCalls += 1; return true; }, write, "/city?fx_ref=v1%3Aa-promoter");

    expect(checkout).toBe(global);
    await expect(checkout).resolves.toBe(true);
    expect(eligibilityCalls).toBe(1);
    expect(markerWrites).toBe(1);
  });

  it("keeps the final marker from the last eligible A navigation when A1, B, and A2 overlap", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "";
    let resolveA1!: (eligible: boolean) => void;
    let resolveB!: (eligible: boolean) => void;
    let resolveA2!: (eligible: boolean) => void;
    const a1 = new Promise<boolean>((resolve) => { resolveA1 = resolve; });
    const b = new Promise<boolean>((resolve) => { resolveB = resolve; });
    const a2 = new Promise<boolean>((resolve) => { resolveA2 = resolve; });
    const write = (marker: string) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; };

    const firstA = coordinator.ensure("?fx_ref=v1%3Aa-promoter", async () => a1, write);
    const touchB = coordinator.ensure("?fx_ref=v1%3Ab-promoter", async () => b, write);
    const secondA = coordinator.ensure("?fx_ref=v1%3Aa-promoter", async () => a2, write);

    resolveB(true);
    await touchB;
    expect(storedReferralSlug(cookie)).toBe("b-promoter");
    resolveA1(true);
    await firstA;
    expect(storedReferralSlug(cookie)).toBe("b-promoter");
    resolveA2(true);
    await secondA;
    expect(storedReferralSlug(cookie)).toBe("a-promoter");
  });

  it("treats A after an intervening no-ref navigation as a new touch", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let calls = 0;
    let resolveA1!: (eligible: boolean) => void;
    let resolveA2!: (eligible: boolean) => void;
    const a1 = new Promise<boolean>((resolve) => { resolveA1 = resolve; });
    const a2 = new Promise<boolean>((resolve) => { resolveA2 = resolve; });
    const firstA = coordinator.ensure("?fx_ref=v1%3Aa-promoter", async () => { calls += 1; return a1; }, () => undefined, "/first?fx_ref=v1%3Aa-promoter");
    await coordinator.ensure("", async () => { throw new Error("no-ref must not call eligibility"); }, () => undefined, "/between");
    const secondA = coordinator.ensure("?fx_ref=v1%3Aa-promoter", async () => { calls += 1; return a2; }, () => undefined, "/return?fx_ref=v1%3Aa-promoter");

    expect(secondA).not.toBe(firstA);
    await Promise.resolve();
    expect(calls).toBe(2);
    resolveA1(true);
    resolveA2(true);
    await Promise.all([firstA, secondA]);
  });

  it("starts the current touch from checkout when global capture has not mounted", async () => {
    const coordinator = createReferralCaptureCoordinator();
    let cookie = "fx_ref=v1%3Aold-promoter";
    let checkoutObserved: string | null = null;
    await coordinator.ensure("?fx_ref=v1%3Afresh-promoter", async (slug) => slug === "fresh-promoter", (marker) => { cookie = `fx_ref=${encodeURIComponent(marker)}`; });
    await coordinator.waitForCurrentCapture();
    checkoutObserved = storedReferralSlug(cookie);
    expect(checkoutObserved).toBe("fresh-promoter");
  });
});
