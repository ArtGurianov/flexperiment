// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CourseCheckout from "../components/checkout/CourseCheckout";

vi.mock("next/navigation", () => ({ usePathname: () => "/courses/test-course" }));
beforeEach(() => { sessionStorage.clear(); history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("closed paid purchase review", () => {
  it.each(["preview", "confirm"])("offers the separate account form when %s refuses missing consent", async phase => {
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
  it("sends the displayed price and warns when the quote differs from it (ART-341)", async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
      calls.push({ url: input, body: options?.body ? JSON.parse(String(options.body)) : undefined });
      if (input === "/v1/me") return Response.json({ customer: { id: "fixture" }, entitlements: [] });
      if (input === "/v1/checkout/handoff") return Response.json({ required: false });
      return Response.json({ quoteId: "quote", state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 150_000,
        baseAmountKopecks: 150_000, discountKopecks: 0, merchantDiscountKopecks: 0, referralDiscountKopecks: 0, checkoutCodeOutcome: "NONE",
        priceNotice: { code: "PRICE_CHANGED_SINCE_DISPLAY", quotedAmountKopecks: 150_000, displayedAmountKopecks: 100_000 } });
    }));
    render(<CourseCheckout courseRef="test-course" offerRef="course:test-course" saleMode="PUBLIC" priceKopecks={100_000} />);
    const buy = screen.getByRole("button", { name: "Купить курс →" });
    await waitFor(() => expect(buy).toBeEnabled()); fireEvent.click(buy);
    expect(await screen.findByText(/Цена изменилась: было 1\s000\s₽, сейчас 1\s500\s₽\./)).toBeInTheDocument();
    expect(calls.find(call => call.url === "/v1/checkout/preview")).toMatchObject({ body: { displayedAmountKopecks: 100_000 } });
    expect(calls.filter(call => call.url === "/v1/checkout")).toHaveLength(0);
  });
});


describe("ART-379 direct checkout and reload", () => {
  it("restores promo and exact preview/payment keys, re-reads the quote and requires fresh deliberate consent", async () => {
    const legalAcceptance = { releaseVersion: "v1", manifestSha256: "a".repeat(64), receiptEmail: "buyer@example.test",
      documents: [{ kind: "course_offer", version: "v1", sha256: "b".repeat(64), url: "https://platform.test/offer" }] };
    const calls: Array<{ path: string; options?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      if (path === "/v1/me") return Response.json({ customer: { id: "buyer" }, entitlements: [] });
      return Response.json({ quoteId: "same-quote", state: "PRICE_REVIEW_REQUIRED", finalAmountKopecks: 9501, baseAmountKopecks: 10001,
        merchantDiscountKopecks: 0, referralDiscountKopecks: 500, discountKopecks: 500, checkoutCodeOutcome: "NOT_APPLIED_ARRIVAL_PRIORITY", legalAcceptance });
    }));
    const first = render(<CourseCheckout courseRef="one" offerRef="course:one" saleMode="PUBLIC" priceKopecks={10001} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Купить курс →" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Промокод"), { target: { value: "PARTNER20" } });
    fireEvent.click(screen.getByRole("button", { name: "Купить курс →" }));
    expect(await screen.findByText(/сохранена скидка по вашей рекомендации/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Подтвердить и оплатить →" })).toBeDisabled();
    const original = calls.find(c => c.path === "/v1/checkout/preview")!;
    expect(JSON.parse(String(original.options?.body))).toMatchObject({ checkoutCode: "PARTNER20" });
    first.unmount();
    render(<CourseCheckout courseRef="one" offerRef="course:one" saleMode="PUBLIC" priceKopecks={20000} />);
    expect(await screen.findByRole("link", { name: "Условия покупки" })).toBeInTheDocument();
    const repeats = calls.filter(c => c.path === "/v1/checkout/preview");
    expect(repeats).toHaveLength(2);
    expect(repeats[1].options?.headers).toEqual(original.options?.headers);
    expect(JSON.parse(String(repeats[1].options?.body)).checkoutCode).toBe("PARTNER20");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(calls.some(c => c.path.includes("handoff") || c.path === "/v1/checkout")).toBe(false);
    expect(screen.getByText(/^95,01\s₽$/)).toBeInTheDocument();
  });
  it("keeps unknown resolution before acceptance and never starts payment or a browser bounce", async () => {
    const fetcher = vi.fn(async (path: string) => Response.json(path === "/v1/me" ? { customer: { id: "buyer" } } : { state: "RESOLUTION_PENDING", orderPublicId: "same-order" }));
    vi.stubGlobal("fetch", fetcher);
    render(<CourseCheckout courseRef="one" offerRef="course:one" saleMode="PUBLIC" priceKopecks={10000} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Купить курс →" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Купить курс →" }));
    expect(await screen.findByText(/Уточняем цену/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Подтвердить и оплатить →" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/me", "/v1/checkout/preview"]);
  });
});
