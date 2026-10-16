// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CourseCheckout from "../components/checkout/CourseCheckout";

vi.mock("next/navigation", () => ({ usePathname: () => "/courses/test-course" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("closed paid purchase review", () => {
  it.each(["handoff", "preview", "confirm"])("offers the separate account form when %s refuses missing consent", async phase => {
    let confirms = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/v1/me") return Response.json({ customer: { id: "fixture" }, entitlements: [] });
      if (input === `/v1/checkout/${phase}` || (phase === "confirm" && input === "/v1/checkout")) {
        if (phase === "confirm") confirms++;
        return Response.json({ code: "CONSENT_REQUIRED" }, { status: 403 });
      }
      if (input === "/v1/checkout/handoff") return Response.json({ required: false });
      return Response.json({ quoteId: "quote", state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 100, baseAmountKopecks: 100,
        discountKopecks: 0, merchantDiscountKopecks: 0, referralDiscountKopecks: 0, checkoutCodeOutcome: "NONE" });
    }));
    render(<CourseCheckout courseRef="test-course" offerRef="course:test-course" saleMode="ACCEPTANCE_ONLY" priceKopecks={100} />);
    const buy = screen.getByRole("button", { name: "Купить курс →" });
    await waitFor(() => expect(buy).toBeEnabled()); fireEvent.click(buy);
    if (phase === "confirm") fireEvent.click(await screen.findByRole("button", { name: "Подтвердить и оплатить →" }));
    expect(await screen.findByRole("link", { name: "Проверить документы аккаунта →" }))
      .toHaveAttribute("href", "/account?next=%2Fcourses%2Ftest-course");
    expect(screen.getByRole("button")).toBeDisabled();
    expect(confirms).toBe(phase === "confirm" ? 1 : 0);
  });
  it("shows the receipt contact/documents and requires one deliberate acceptance before confirm", async () => {
    const legalAcceptance = { releaseVersion: "synthetic-paid", manifestSha256: "a".repeat(64), receiptEmail: "synthetic@example.test",
      documents: [{ kind: "course_offer", version: "v1", sha256: "b".repeat(64), url: "https://canary-platform.flexperiment.ru/legal/offer" }] };
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
      calls.push({ url: input, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      if (input === "/v1/me") return Response.json({ customer: { id: "fixture" }, entitlements: [] });
      if (input === "/v1/checkout/handoff") return Response.json({ required: false });
      if (input === "/v1/checkout/preview") return Response.json({ quoteId: "quote", state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 100,
        baseAmountKopecks: 100, discountKopecks: 0, merchantDiscountKopecks: 0, referralDiscountKopecks: 0,
        checkoutCodeOutcome: "NONE", legalAcceptance });
      return Response.json({ state: "DECLINED" });
    }));
    render(<CourseCheckout courseRef="test-course" offerRef="course:test-course" saleMode="ACCEPTANCE_ONLY" priceKopecks={100} />);
    const buy = screen.getByRole("button", { name: "Купить курс →" });
    await waitFor(() => expect(buy).toBeEnabled()); fireEvent.click(buy);
    const confirm = await screen.findByRole("button", { name: "Подтвердить и оплатить →" });
    expect(confirm).toBeDisabled(); expect(screen.getByText(/synthetic@example.test/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Условия покупки" })).toHaveAttribute("href", legalAcceptance.documents[0].url);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(calls.filter(call => call.url === "/v1/checkout")).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox")); expect(confirm).toBeEnabled(); fireEvent.click(confirm);
    await waitFor(() => expect(calls.find(call => call.url === "/v1/checkout")).toMatchObject({ body: { quoteId: "quote", legalAcceptance: {
      accepted: true, receiptEmail: legalAcceptance.receiptEmail, manifestSha256: legalAcceptance.manifestSha256, releaseVersion: legalAcceptance.releaseVersion } } }));
  });
});
