import { describe, expect, it } from "vitest";
import { ALL_ADMIN_MUTATIONS, invalidationKeysFor } from "./invalidation";
import { agentReferralsKeys, dashboardKeys } from "./query-keys";

describe("invalidationKeysFor", () => {
  it("has a table row for every AdminMutation", () => {
    for (const mutation of ALL_ADMIN_MUTATIONS) {
      expect(invalidationKeysFor(mutation, { orderId: "o1", occurrenceId: "occ1", settlementId: "s1", cityId: "c1" }).length).toBeGreaterThan(0);
    }
  });

  it("invalidates dashboardKeys.summary() for every mutation (A4)", () => {
    for (const mutation of ALL_ADMIN_MUTATIONS) {
      const keys = invalidationKeysFor(mutation, { orderId: "o1", occurrenceId: "occ1", settlementId: "s1", cityId: "c1" });
      expect(keys).toContainEqual(dashboardKeys.summary());
    }
  });

  it("never uses an all() prefix where lists()/leaf suffices, so invalidation stays narrow", () => {
    // all() keys are exactly length 1 (["orders"], ["refunds"], ...); every
    // legitimate entry in the table is either a lists() key (length 2) or a
    // scoped leaf key (length >= 3). A length-1 key here would mean the
    // mutation is nuking every query for that resource, including open
    // evidence/detail panels the plan explicitly says must survive.
    for (const mutation of ALL_ADMIN_MUTATIONS) {
      const keys = invalidationKeysFor(mutation, { orderId: "o1", occurrenceId: "occ1", settlementId: "s1", cityId: "c1" });
      for (const key of keys) expect(key.length, `${mutation} used an all()-width key: ${JSON.stringify(key)}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("targets order.refund at the exact A1 fix: order lists, order evidence, and refund lists", () => {
    const keys = invalidationKeysFor("order.refund", { orderId: "order-1" });
    expect(keys).toContainEqual(["orders", "list"]);
    expect(keys).toContainEqual(["orders", "evidence", "order-1"]);
    expect(keys).toContainEqual(["refunds", "list"]);
  });

  it("targets occurrence.cancel at the exact A2 fix: occurrence lists and this occurrence's cancellation financials", () => {
    const keys = invalidationKeysFor("occurrence.cancel", { occurrenceId: "occ-1" });
    expect(keys).toContainEqual(["occurrences", "list"]);
    expect(keys).toContainEqual(["occurrences", "cancellationFinancials", "occ-1"]);
  });

  // PR-C review: an engagement command cannot know which partner filter the
  // operator currently has typed into the list, so it must refresh the list
  // FAMILY. Scoping to the command's own partner left the open list stale for
  // every other filter value - including "" (the default).
  it("refreshes the whole engagement list family, whatever filter the open list uses", () => {
    const familyKey = agentReferralsKeys.engagementLists();
    for (const mutation of ["agentReferrals.engagementOffer", "agentReferrals.engagementCommand"] as const) {
      expect(invalidationKeysFor(mutation, { engagementId: "e1", partnerIdentityId: "p1" })).toContainEqual(familyKey);
    }
    // Still narrow: the family prefix must not reach an engagement DETAIL key.
    const detail = agentReferralsKeys.engagement("e1") as readonly unknown[];
    expect(familyKey.every((segment, index) => detail[index] === segment)).toBe(false);
  });

  it("refreshes the ORD registration list on a creative command, which lives outside the engagement key space", () => {
    const keys = invalidationKeysFor("agentReferrals.creativeRegistrationCommand", { engagementId: "e1", creativeRevisionId: "cr1" });
    expect(keys).toContainEqual(agentReferralsKeys.creativeRegistrations("cr1"));
    expect(keys).toContainEqual(agentReferralsKeys.engagement("e1"));
  });

  it("omits a scoped leaf key when its id is not in context, rather than guessing", () => {
    expect(invalidationKeysFor("order.refund", {})).not.toContainEqual(["orders", "evidence", undefined]);
  });
});
