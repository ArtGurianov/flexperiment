import { describe, expect, it } from "vitest";
import { InMemoryCertificationCapabilityStore, issueCapability, type TrustedCheckoutFacts } from "../../src/certification/capability";
import {
  InMemoryCertificationCheckoutAuthority, InMemoryCertificationOrderLedger, isReplay,
} from "../../src/certification/checkout-authority";
import { InMemoryCertificationRunStore, type CertificationRun } from "../../src/certification/run";

const now = new Date("2026-09-19T00:00:00.000Z");
const sha = "a".repeat(40);
const facts: TrustedCheckoutFacts = { deploymentSessionId: "deploy", runtimeReleaseSha: sha, actualAmountKopecks: 100, checkoutOccurrenceId: "occ" };

const setup = (over: Partial<CertificationRun> = {}) => {
  const capabilities = new InMemoryCertificationCapabilityStore();
  const runs = new InMemoryCertificationRunStore();
  const orders = new InMemoryCertificationOrderLedger();
  runs.create({
    runId: "run", revision: 1, releaseSha: sha, phase: "CHECKOUT_SUBMITTING", direction: "FINANCIAL_EFFECT_POSSIBLE",
    startedAt: now.toISOString(), occurrenceId: "occ", quoteId: "quote", ...over,
  });
  const capability = issueCapability(capabilities, { runId: "run", deploymentSessionId: "deploy", releaseSha: sha, maxAmountKopecks: 100, ttlMs: 300_000 }, now);
  const authority = new InMemoryCertificationCheckoutAuthority(capabilities, runs, orders);
  const claim = { capabilityId: capability.id, runId: "run", nonce: capability.nonce };
  const created = { orderId: "order", statusId: "status" };
  return { capabilities, capability, runs, orders, authority, claim, created };
};

describe("admitting a certification checkout", () => {
  it("spends the capability and creates the order in one act", () => {
    const { authority, capabilities, capability, claim, created, orders } = setup();

    const result = authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => created);

    expect(result).toBe(created);
    expect(capabilities.get(capability.id)?.consumedAt).toBe(now.toISOString());
    expect(orders.find("key")?.certificationRunId).toBe("run");
  });

  it("leaves the capability unspent when the order is not created", () => {
    // Spend, crash, no order is the sequence that matters most: the run could
    // then never finish and the fence could never be passed again, with
    // nothing in the record explaining why.
    const { authority, capabilities, capability, claim, orders } = setup();

    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => { throw new Error("INSERT failed"); }))
      .toThrow("INSERT failed");

    expect(capabilities.get(capability.id)?.consumedAt).toBeNull();
    expect(orders.find("key")).toBeUndefined();
  });

  it("resolves idempotency before anything else, so a retry costs nothing", () => {
    // A dropped response is the ordinary case. Authorizing first and
    // deduplicating afterwards would burn a one-shot permission on a request
    // that created nothing.
    const { authority, capabilities, capability, claim, created } = setup();
    authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => created);
    const spentAt = capabilities.get(capability.id)?.consumedAt;

    const replay = authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => { throw new Error("must not be called"); });

    expect(isReplay(replay) && replay.order.orderId).toBe("order");
    expect(capabilities.get(capability.id)?.consumedAt).toBe(spentAt);
  });

  it("will not hand one run the order another run's key created", () => {
    const { authority, claim, created } = setup();
    authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => created);
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim: { ...claim, runId: "another-run" }, facts, now }, () => created))
      .toThrow("CERTIFICATION_CHECKOUT_KEY_FOREIGN_RUN");
  });

  it.each([
    ["a runtime on another release", { runtimeReleaseSha: "b".repeat(40) }, "CERTIFICATION_CAPABILITY_RELEASE_MISMATCH"],
    ["another deployment session", { deploymentSessionId: "another" }, "CERTIFICATION_CAPABILITY_SESSION_MISMATCH"],
    ["a different occurrence", { checkoutOccurrenceId: "a-real-event" }, "CERTIFICATION_CAPABILITY_SESSION_MISMATCH"],
    ["a price above the ceiling", { actualAmountKopecks: 350_000 }, "CERTIFICATION_CAPABILITY_AMOUNT_EXCEEDED"],
  ])("refuses %s without spending anything", (_label, override, code) => {
    // Each of these is a fact the server established. A leaked capability
    // cannot be redirected at a real event, a real price or another release.
    const { authority, capabilities, capability, claim, orders } = setup();

    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts: { ...facts, ...override }, now }, () => ({ orderId: "order", statusId: "status" })))
      .toThrow(code);

    expect(capabilities.get(capability.id)?.consumedAt).toBeNull();
    expect(orders.find("key")).toBeUndefined();
  });

  it("refuses a run that has not recorded that money may exist", () => {
    // A checkout admitted before that record is a payment nobody wrote down
    // first.
    const { authority, claim } = setup({ direction: "NORMAL" });
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => ({ orderId: "o", statusId: "s" })))
      .toThrow("CERTIFICATION_RUN_FINANCIAL_EFFECT_NOT_ARMED");
  });

  it("refuses a run that has turned to cleanup", () => {
    const { authority, claim } = setup({ direction: "CLEANUP_STARTED" });
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => ({ orderId: "o", statusId: "s" })))
      .toThrow("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN");
  });
});
