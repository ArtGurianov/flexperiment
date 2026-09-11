import { describe, expect, it } from "vitest";
import { ALL_PARTNER_MUTATIONS, partnerInvalidationKeysFor } from "./partner-invalidation";
import { ALL_ADMIN_MUTATIONS, invalidationKeysFor } from "./invalidation";
import { partnerKeys } from "./query-keys";

describe("partnerInvalidationKeysFor", () => {
  it("has a table row for every PartnerMutation", () => {
    for (const mutation of ALL_PARTNER_MUTATIONS) {
      expect(partnerInvalidationKeysFor(mutation, { engagementId: "e1" }).length, mutation).toBeGreaterThan(0);
    }
  });

  it("never uses an all() prefix, so a command cannot nuke every partner query at once", () => {
    for (const mutation of ALL_PARTNER_MUTATIONS) {
      const keys = partnerInvalidationKeysFor(mutation, { engagementId: "e1" });
      for (const key of keys) expect(key.length, `${mutation} used an all()-width key: ${JSON.stringify(key)}`).toBeGreaterThanOrEqual(2);
    }
  });

  it("omits the engagement leaf when no id is in context, rather than guessing", () => {
    expect(partnerInvalidationKeysFor("partner.actAccept", {})).not.toContainEqual(["partner", "engagement", undefined]);
    expect(partnerInvalidationKeysFor("partner.actAccept", {})).toContainEqual(partnerKeys.engagements());
  });

  it("leaves conversions alone - proven by PREFIX matching, which is what invalidateQueries actually does", () => {
    // Asserting "the conversions key is not in the array" proves nothing:
    // invalidateQueries({queryKey: K}) matches every query whose key STARTS
    // WITH K, so a key that is a prefix of the conversions key invalidates it
    // just as surely as naming it. That is precisely how the first version of
    // this table did invalidate conversions while claiming not to, back when
    // they lived under ["partner","engagement",id,"conversions"].
    const invalidates = (declared: readonly unknown[], target: readonly unknown[]) =>
      declared.length <= target.length && declared.every((segment, index) => target[index] === segment);
    const conversions = partnerKeys.conversions("e1");
    for (const mutation of ALL_PARTNER_MUTATIONS) {
      for (const key of partnerInvalidationKeysFor(mutation, { engagementId: "e1" })) {
        expect(invalidates(key as readonly unknown[], conversions), `${mutation} invalidates conversions via ${JSON.stringify(key)}`).toBe(false);
      }
    }
    // ...and the engagement detail IS still reached, so the test above is not
    // passing merely because nothing is invalidated at all.
    const acceptKeys = partnerInvalidationKeysFor("partner.actAccept", { engagementId: "e1" });
    expect(acceptKeys.some((key) => invalidates(key as readonly unknown[], partnerKeys.engagement("e1")))).toBe(true);
  });

  it("keeps the two realms disjoint: neither table can reach into the other's cache", () => {
    // Realm separation is a hard boundary in this system; sharing a key
    // prefix would quietly make it a soft one.
    const partnerPrefixes = new Set(ALL_PARTNER_MUTATIONS.flatMap((mutation) =>
      partnerInvalidationKeysFor(mutation, { engagementId: "e1" }).map((key) => String((key as unknown[])[0]))));
    const adminPrefixes = new Set(ALL_ADMIN_MUTATIONS.flatMap((mutation) =>
      invalidationKeysFor(mutation, { engagementId: "e1", partnerIdentityId: "p1", channelKey: "vk" }).map((key) => String((key as unknown[])[0]))));
    for (const prefix of partnerPrefixes) expect(adminPrefixes.has(prefix), `shared root segment: ${prefix}`).toBe(false);
  });
});
