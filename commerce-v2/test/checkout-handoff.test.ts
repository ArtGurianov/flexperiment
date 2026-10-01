import { describe, expect, it } from "vitest";
import {
  issueCheckoutHandoffState,
  issueCheckoutPaymentReturnState,
  verifyCheckoutHandoffState,
  verifyCheckoutNavigationState,
} from "../src/checkout-handoff";

describe("Refref browser handoff state", () => {
  it("binds the preallocated order and return path to the authenticated customer", () => {
    const issued = issueCheckoutHandoffState("secret", { customerId: "customer", returnPath: "/courses/one", storefront: "COURSES" }, 1_000);
    expect(verifyCheckoutHandoffState("secret", issued.token, "customer", 2_000)).toMatchObject({
      phase: "HANDOFF", returnPath: "/courses/one", storefront: "COURSES", orderPublicId: issued.state.orderPublicId,
    });
    expect(() => verifyCheckoutHandoffState("secret", issued.token, "attacker", 2_000)).toThrow("CHECKOUT_STATE_INVALID");
    expect(() => verifyCheckoutHandoffState("secret", issued.token, "customer", 1_000 + 10 * 60_000 + 1)).toThrow("CHECKOUT_STATE_INVALID");
  });

  it("mints a customer-bound payment return without exposing the handoff token", () => {
    const handoff = issueCheckoutHandoffState("secret", { customerId: "customer", returnPath: "/courses/one", storefront: "COURSES" }, 1_000);
    const paymentReturn = issueCheckoutPaymentReturnState("secret", handoff.state, 2_000);

    expect(paymentReturn.token).not.toBe(handoff.token);
    expect(verifyCheckoutNavigationState("secret", paymentReturn.token, "customer", 3_000)).toMatchObject({
      phase: "PAYMENT_RETURN",
      orderPublicId: handoff.state.orderPublicId,
      returnPath: "/courses/one",
      storefront: "COURSES",
    });
    expect(() => verifyCheckoutHandoffState("secret", paymentReturn.token, "customer", 3_000)).toThrow("CHECKOUT_STATE_INVALID");
    expect(() => verifyCheckoutNavigationState("secret", paymentReturn.token, "attacker", 3_000)).toThrow("CHECKOUT_STATE_INVALID");
  });
});
