import { describe, expect, it } from "vitest";
import type { TrustedCheckoutFacts } from "../../src/certification/capability";
import { isReplay } from "../../src/certification/checkout-authority";
import type { CertificationRun } from "../../src/certification/run";
import { certificationCheckoutAuthorities, SESSION, SHA, type AuthorityFixture } from "../support/certification-checkout-authorities";

const now = new Date("2026-09-19T00:00:00.000Z");
const facts: TrustedCheckoutFacts = { deploymentSessionId: SESSION, runtimeReleaseSha: SHA, actualAmountKopecks: 100, checkoutOccurrenceId: "occ" };

describe.each(certificationCheckoutAuthorities)("admitting a certification checkout (%s)", (_name, make) => {
  const setup = (over: Partial<CertificationRun> = {}) => {
    const fixture: AuthorityFixture = make(over, now);
    return { ...fixture, claim: { capabilityId: fixture.capability.id, runId: "run", nonce: fixture.nonce } };
  };

  it("spends the capability and creates the order in one act", () => {
    const { authority, capability, capabilityConsumedAt, claim, create, orders } = setup();

    const result = authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key", "run"));

    expect(result).toMatchObject({ orderId: expect.stringContaining("order") as unknown as string });
    expect(capabilityConsumedAt(capability.id)).toBe(now.toISOString());
    expect(orders.find("key")?.certificationRunId).toBe("run");
  });

  it("leaves the capability unspent when the order is not created", () => {
    // Spend, crash, no order is the sequence that matters most: the run could
    // then never finish and the fence could never be passed again, with
    // nothing in the record explaining why. The reference restores by hand;
    // production gets it from the transaction, and this proves they agree.
    const { authority, capability, capabilityConsumedAt, claim, orders } = setup();

    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => { throw new Error("INSERT failed"); }))
      .toThrow("INSERT failed");

    expect(capabilityConsumedAt(capability.id)).toBeNull();
    expect(orders.find("key")).toBeUndefined();
  });

  it("resolves idempotency before anything else, so a retry costs nothing", () => {
    // A dropped response is the ordinary case. Authorizing first and
    // deduplicating afterwards would burn a one-shot permission on a request
    // that created nothing.
    const { authority, capability, capabilityConsumedAt, claim, create } = setup();
    const first = authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key", "run"));
    const spentAt = capabilityConsumedAt(capability.id);

    const replay = authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => { throw new Error("must not be called"); });

    expect(isReplay(replay) && replay.order.orderId).toBe((first as { orderId: string }).orderId);
    expect(capabilityConsumedAt(capability.id)).toBe(spentAt);
  });

  it("will not hand one run the order another run's key created", () => {
    const { authority, claim, create } = setup();
    authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key", "run"));
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim: { ...claim, runId: "another-run" }, facts, now }, () => create("key", "run")))
      .toThrow("CERTIFICATION_CHECKOUT_KEY_FOREIGN_RUN");
  });

  it("will not let a certification collect an ordinary customer's order", () => {
    // An ordinary order carries no run. Reading its absence as "belongs to this
    // run" would hand a real purchase to a certification as its own.
    const { authority, claim, create, plantOrdinaryOrder } = setup();
    plantOrdinaryOrder("key");
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key2", "run")))
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
    const { authority, capability, capabilityConsumedAt, claim, create, orders } = setup();

    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts: { ...facts, ...override }, now }, () => create("key", "run")))
      .toThrow(code);

    expect(capabilityConsumedAt(capability.id)).toBeNull();
    expect(orders.find("key")).toBeUndefined();
  });

  it("refuses a run that has not recorded that money may exist", () => {
    // A checkout admitted before that record is a payment nobody wrote down
    // first.
    const { authority, claim, create } = setup({ direction: "NORMAL" });
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key", "run")))
      .toThrow("CERTIFICATION_RUN_FINANCIAL_EFFECT_NOT_ARMED");
  });

  it("refuses a run that has turned to cleanup", () => {
    const { authority, claim, create } = setup({ direction: "CLEANUP_STARTED" });
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key", "run")))
      .toThrow("CERTIFICATION_CATALOGUE_REOPEN_FORBIDDEN");
  });

  it("refuses a run that is not at the checkout step", () => {
    const { authority, claim, create } = setup({ phase: "OCCURRENCE_OPEN" });
    expect(() => authority.createOrReplay({ idempotencyKey: "key", claim, facts, now }, () => create("key", "run")))
      .toThrow("CERTIFICATION_RUN_NOT_CHECKING_OUT");
  });
});
