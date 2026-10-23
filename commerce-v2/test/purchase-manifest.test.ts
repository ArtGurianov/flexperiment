import { describe, expect, it } from "vitest";
import producers from "./fixtures/purchase-manifest/producers.json";
import policy from "./fixtures/purchase-manifest/claim-policy.json";
import { merchantPurchase, consumePurchaseQuote, acceptPurchase, consumePurchaseQualification, purchaseRefundAllocation } from "../src/purchase-manifest";
import { resolvePurchaseV2, assertClaimAdmission, claimRewardEffect, assertCompatibleCampaigns,
  type PurchaseInputV1, type FrozenTerms, type PurchaseAcceptance, type BankFullPayment,
  type CancellationClaimV1, type ClaimDecisionSnapshot, type RefundBreakdown } from "../src/refref-contract/purchase-manifest-v1";

const fixtures = policy.producers.map(vector => {
  const base = producers.fixtures.find(f => f.name === vector.base)!;
  const input = base.input as PurchaseInputV1;
  const terms = { ...base.terms, ...("reward" in vector ? { reward: vector.reward } : {}) } as FrozenTerms;
  const payable = resolvePurchaseV2(input, terms, base.quote, policy.claimPolicy);
  const envelope = { schema: "refref.purchase-quote/2" as const, payable, payableHash: vector.payableHash };
  const frozen = merchantPurchase(input.businessId, input.purchaseRef, input.lines);
  const acceptance = { ...base.acceptance, payableHash: envelope.payableHash } as PurchaseAcceptance;
  const payment = { ...base.payment, payableHash: envelope.payableHash } as BankFullPayment;
  return { name: vector.name, vector, frozen, envelope, acceptance, payment, at: base.qualification.purchaseQualifiedAt };
});

describe("ART-398 published payable/2 producer/consumer vectors", () => {
  it.each(fixtures)("$name preserves exact hashes, eligibility, reward and initial anchors", f => {
    const saved = consumePurchaseQuote(f.frozen, f.envelope);
    expect(saved.payable.rewardKopecks).toBe(f.vector.rewardKopecks);
    expect(saved.payable.eligibleAfterDiscountKopecks).toBe(f.vector.eligibleAfterDiscountKopecks);
    const acceptance = acceptPurchase(f.frozen, saved, f.acceptance.acceptedAt);
    expect(acceptance).toEqual(f.acceptance);
    const qualified = consumePurchaseQualification(f.frozen, saved, acceptance, f.payment, f.at);
    if (f.name === "eligible-course-noneligible-future-ticket") expect(qualified.purchaseAnchorAt).toBe(f.at);
    const replay = consumePurchaseQuote(f.frozen, JSON.parse(JSON.stringify(saved)));
    expect(replay).toEqual(saved);
    expect(f.frozen.input.lines.some(l => l.quantity > 1)).toBe(f.name === "mikluha-three-travellers" || f.name === "fixed-reward-once" || f.name === "fixed-reward-above-eligible-price" || f.name === "mixed-date-tour-lab-lms");
  });

  it.each(policy.scenarios)("D1.2 $name", scenario => {
    const f = fixtures.find(f => f.name === scenario.producer)!;
    const qualified = consumePurchaseQualification(f.frozen, f.envelope, f.acceptance, f.payment, f.at);
    const claim = scenario.claim as CancellationClaimV1;
    const decision = scenario.decision as ClaimDecisionSnapshot;
    const prior = scenario.priorRefunds as RefundBreakdown[];
    const admission = () => assertClaimAdmission(f.envelope.payable, qualified, claim, decision.admission.receivedAt, prior);
    if (scenario.expected.admission !== "ACCEPTED") expect(admission).toThrow(scenario.expected.admission);
    else {
      expect(admission).not.toThrow();
      const effect = () => claimRewardEffect(f.envelope.payable, qualified, claim, decision, prior);
      const expected = "effect" in scenario.expected ? scenario.expected.effect : 0;
      if (typeof expected === "string") expect(effect).toThrow(expected);
      else expect(effect()).toBe(expected);
    }
  });

  it("refuses unknown fields/PII and a cross-Business or tampered payable before payment", () => {
    const f = fixtures.find(f => f.name === "immediate-lms")!;
    for (const mutate of [
      (v: Record<string, unknown>) => { v.customerEmail = "private@example.test"; },
      (v: Record<string, unknown>) => { v.businessId = "foreign"; },
      (v: Record<string, unknown>) => { v.totalKopecks = 1; },
      (v: Record<string, unknown>) => { v.claimPolicy = "mutable-global-default"; },
    ]) {
      const bad = structuredClone(f.envelope); mutate(bad.payable as unknown as Record<string, unknown>);
      expect(() => consumePurchaseQuote(f.frozen, bad)).toThrow();
    }
    expect(() => assertCompatibleCampaigns([f.envelope.payable.terms, { ...f.envelope.payable.terms, campaignId: "other" }])).toThrow("MULTI_CAMPAIGN_CART_REQUIRES_SPLIT");
  });

  it("refuses missing LAB end/timezone/provenance and delayed LMS; fiscal tags are not profile inputs", () => {
    const f = fixtures.find(f => f.name === "lab-occurrence")!;
    for (const key of ["serviceEndsAt", "timeZone", "provenance"]) {
      const bad = structuredClone(f.frozen.input); delete (bad.lines[0].service as unknown as Record<string, unknown>)[key];
      expect(() => merchantPurchase(bad.businessId, bad.purchaseRef, bad.lines)).toThrow();
    }
    const lms = fixtures.find(f => f.name === "immediate-lms")!;
    const bad = structuredClone(lms.frozen.input);
    if (bad.lines[0].service.kind === "LMS") bad.lines[0].service.accessProfile = "DELAYED";
    expect(() => resolvePurchaseV2(bad, lms.envelope.payable.terms, lms.envelope.payable.quote, policy.claimPolicy)).toThrow("DELAYED_LMS_PROFILE_NOT_QUALIFIED");
    expect(JSON.stringify(f.frozen)).not.toContain("paymentMethod");
  });

  it("keeps reward on a customer refund and requires the immutable breakdown to equal the bank amount", () => {
    const scenario = policy.scenarios.find(s => s.name === "all-three-cancelled-costs-retained")!;
    const f = fixtures.find(f => f.name === scenario.producer)!;
    const refund = scenario.claim.refunds[0] as RefundBreakdown;
    expect(purchaseRefundAllocation(f.envelope, refund).rewardKopecks).toBe(f.envelope.payable.rewardKopecks);
    expect(() => purchaseRefundAllocation(f.envelope, { ...refund, amountKopecks: refund.amountKopecks + 1 })).toThrow("PURCHASE_REFUND_ALLOCATION_INVALID");
    expect(() => consumePurchaseQualification(f.frozen, f.envelope, f.acceptance, { ...f.payment, kind: "FISCAL_OFFSET" } as unknown as BankFullPayment, f.at)).toThrow("PURCHASE_SCHEMA_INVALID:bankFullPayment");
  });
});

describe("second review: canonical acceptance times", () => {
  it.each([
    ["2026-10-21T01:00:00.000Z", true],
    ["2026-10-21T01:14:59.999Z", true],
    ["2026-10-21T00:59:59.999Z", false],
    ["2026-10-21T01:15:00.000Z", false],
    ["2026-10-21T01:15:00.001Z", false],
  ])("checks the actual quote window for %s (valid=%s)", (acceptedAt, valid) => {
    const f = fixtures.find(f => f.name === "immediate-lms")!;
    const accept = () => acceptPurchase(f.frozen, f.envelope, acceptedAt);
    if (valid) expect(accept().acceptedAt).toBe(acceptedAt);
    else expect(accept).toThrow("ACCEPTANCE_OUTSIDE_QUOTE_WINDOW");
  });
  it.each(["2026-10-21T03:10:00+02:00", "2026-10-21T00:10:00-01:00", "2026-10-21T01:10:00Z", "2026-10-21T01:10:00.0000Z"])("preserves the pinned schema's rejection of noncanonical %s", acceptedAt => {
    const f = fixtures.find(f => f.name === "immediate-lms")!;
    expect(() => acceptPurchase(f.frozen, f.envelope, acceptedAt)).toThrow("PURCHASE_SCHEMA_INVALID:acceptance");
  });
});
