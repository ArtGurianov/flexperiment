// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CheckoutReturnPage from "../app/(frontend)/checkout/return/page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const response = (body: unknown, status = 200) => Response.json(body, { status });

describe("CheckoutReturnPage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    replace.mockClear();
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    window.history.replaceState({}, "", "/");
    vi.restoreAllMocks();
  });

  it("returns the Refref handoff token to the original same-origin course path", async () => {
    window.history.replaceState({}, "", "/checkout/return?state=handoff-state&rt=handoff-token");
    global.fetch = vi.fn(async () => response({
      phase: "HANDOFF", returnPath: "/courses/one", orderPublicId: "order-one",
    }));

    render(<CheckoutReturnPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/courses/one?rt=handoff-token&state=handoff-state"));
  });

  it("reconciles an accepted payment before returning to the course", async () => {
    window.history.replaceState({}, "", "/checkout/return?state=payment-state");
    global.fetch = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/v1/checkout/handoff/return")
      ? response({ phase: "PAYMENT_RETURN", returnPath: "/courses/one", orderPublicId: "order-one" })
      : response({ state: "PAID", orderPublicId: "order-one" }));

    render(<CheckoutReturnPage />);

    expect(await screen.findByText("Платёж принят. Открываем доступ…")).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/courses/one?payment=paid"));
    expect(vi.mocked(global.fetch)).toHaveBeenNthCalledWith(2, "/v1/checkout/order-one", {
      cache: "no-store", credentials: "same-origin",
    });
  });

  it("hands a still-pending order to the existing client observer", async () => {
    window.history.replaceState({}, "", "/checkout/return?state=payment-state");
    global.fetch = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith("/v1/checkout/handoff/return")
      ? response({ phase: "PAYMENT_RETURN", returnPath: "/courses/one", orderPublicId: "order-one" })
      : response({ state: "PENDING", orderPublicId: "order-one" }));

    render(<CheckoutReturnPage />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/courses/one?payment=pending&order=order-one"));
  });
});
