import { describe, expect, it } from "vitest";
import { issueCheckoutHandoffState, verifyCheckoutHandoffState } from "../src/checkout-handoff";

describe("Refref browser handoff state", () => {
  it("binds the preallocated order and return path to the authenticated customer", () => {
    const issued = issueCheckoutHandoffState("secret", { customerId: "customer", returnPath: "/courses/one" }, 1_000);
    expect(verifyCheckoutHandoffState("secret", issued.token, "customer", 2_000)).toMatchObject({ returnPath: "/courses/one", orderPublicId: issued.state.orderPublicId });
    expect(() => verifyCheckoutHandoffState("secret", issued.token, "attacker", 2_000)).toThrow("CHECKOUT_STATE_INVALID");
    expect(() => verifyCheckoutHandoffState("secret", issued.token, "customer", 1_000 + 10 * 60_000 + 1)).toThrow("CHECKOUT_STATE_INVALID");
  });
});
