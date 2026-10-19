import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LabGuestCheckout from "./LabGuestCheckout";
import LabGuestTicket from "./LabGuestTicket";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../lib/commerce-api", () => ({ commerceApiUrl: (path: string) => path }));
const occurrence = { title: "LAB Тест", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T17:00:00Z", timezone: "Asia/Novosibirsk",
  venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1" } };
const quote = { state: "PRICE_REVIEW_REQUIRED", quoteId: "quote", finalAmountKopecks: 10000, expiresAt: "2026-10-19T11:00:00Z", occurrence,
  labLegal: { releaseVersion: "lab-b", manifestSha256: "a".repeat(64), documents: [{ kind: "course_offer", version: "lab-offer", url: "https://lab.test/legal/offer" }] } };
const response = (data: unknown, status = 200) => Response.json(data, { status });
beforeEach(() => { sessionStorage.clear(); history.replaceState(null, "", "/"); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("guest LAB browser flow", () => {
  it("previews without login and never creates payment before explicit consent and confirmation", async () => {
    const fetcher = vi.fn(async (path: string) => response(path.endsWith("/start") ? { orderPublicId: "order" } : quote)); vi.stubGlobal("fetch", fetcher);
    render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    fireEvent.change(screen.getByLabelText("Email для билета и чека"), { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить условия" }));
    await screen.findByText("LAB Тест");
    expect(screen.getByText("Студия, Красный проспект, 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Подтвердить и оплатить" })).toBeDisabled();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/lab/guest/start", "/v1/checkout/preview"]);
    expect(fetcher.mock.calls.every(([path]) => !path.includes("auth") && !path.includes("/me"))).toBe(true);
    const persisted = JSON.parse(sessionStorage.getItem("lab-guest-v1:lab:one")!);
    expect(persisted.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(persisted.orderPublicId).toBe("order");
  });
  it("replays the same persisted capability and preview key after a lost answer", async () => {
    let failed = false;
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith("/start")) return response({ orderPublicId: "order" });
      if (!failed) { failed = true; throw new Error("lost ACK"); } return response(quote);
    }); vi.stubGlobal("fetch", fetcher);
    const { unmount } = render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    fireEvent.change(screen.getByLabelText("Email для билета и чека"), { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить условия" })); await screen.findByRole("alert");
    const original = sessionStorage.getItem("lab-guest-v1:lab:one"); unmount();
    render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    fireEvent.change(screen.getByLabelText("Email для билета и чека"), { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить условия" })); await screen.findByText("LAB Тест");
    expect(sessionStorage.getItem("lab-guest-v1:lab:one")).toBe(original);
  });
  it.each([
    { code: "PRICE_CHANGED_SINCE_DISPLAY", quotedAmountKopecks: 300_000, displayedAmountKopecks: 250_000 },
    { code: "CATALOG_PRICE_CHANGED_AFTER_QUOTE", quotedAmountKopecks: 250_000, currentAmountKopecks: 300_000 },
  ] as const)("shows $code beside the amount before explicit payment, including a restored session", async (priceNotice) => {
    const token = "t".repeat(43);
    sessionStorage.setItem("lab-guest-v1:lab:one", JSON.stringify({ accessToken: token, previewKey: "persisted-preview", paymentKey: "persisted-payment", email: "guest@example.com" }));
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/start")) return response({ orderPublicId: "order" });
      if (path === "/v1/checkout") return response({ state: "PAID", orderPublicId: "order" });
      expect(JSON.parse(String(options?.body))).toEqual({ offerRef: "lab:one", displayedAmountKopecks: 250_000 });
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}`, "Idempotency-Key": "persisted-preview" });
      return response({ ...quote, finalAmountKopecks: priceNotice.quotedAmountKopecks, priceNotice });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={250_000} />);
    fireEvent.change(screen.getByLabelText("Email для билета и чека"), { target: { value: "guest@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить условия" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(priceNotice.code === "PRICE_CHANGED_SINCE_DISPLAY"
      ? /Цена изменилась: было 2\s500 ₽, сейчас 3\s000 ₽/
      : /Цена в каталоге изменилась на 3\s000 ₽; для этого расчёта сохраняется 2\s500 ₽/);
    expect(screen.getByText(/^К оплате:/)).toHaveTextContent(priceNotice.code === "PRICE_CHANGED_SINCE_DISPLAY" ? /3\s000 ₽/ : /2\s500 ₽/);
    expect(fetcher.mock.calls.some(([path]) => path === "/v1/checkout")).toBe(false);
    const confirm = screen.getByRole("button", { name: "Подтвердить и оплатить" });
    expect(confirm).toBeDisabled();
    for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
    expect(confirm).toBeEnabled();
    expect(fetcher.mock.calls.some(([path]) => path === "/v1/checkout")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/v1/checkout", expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": "persisted-payment" }),
    })));
  });
  it("does not redeem a recovery link on GET/page load; sends tokens in POST and retains replay after failure", async () => {
    history.replaceState(null, "", `/ticket#recover=${"r".repeat(43)}`);
    const fetcher = vi.fn(async () => response({ code: "TEMPORARY" }, 503)); vi.stubGlobal("fetch", fetcher);
    render(<LabGuestTicket />); await screen.findByRole("button", { name: "Восстановить билет" });
    expect(location.hash).toBe(""); expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Восстановить билет" })); await screen.findByRole("status");
    expect(fetcher).toHaveBeenCalledWith("/v1/lab/guest/recover/confirm", expect.objectContaining({ method: "POST" }));
    expect(sessionStorage.getItem(`lab-ticket-replacement-v1:${"r".repeat(43)}`)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("handles a recovery hash opened in an existing ticket tab without redeeming automatically", async () => {
    vi.stubGlobal("fetch", vi.fn()); render(<LabGuestTicket />);
    history.replaceState(null, "", `/ticket#recover=${"r".repeat(43)}`);
    fireEvent(window, new HashChangeEvent("hashchange"));
    await screen.findByRole("button", { name: "Восстановить билет" });
    expect(fetch).not.toHaveBeenCalled(); expect(location.hash).toBe("");
  });
  it("shows used/void tickets without QR and can recover with email alone", async () => {
    history.replaceState(null, "", `/ticket#access=${"t".repeat(43)}`);
    const fetcher = vi.fn(async (path: string) => response(path.endsWith("/ticket")
      ? { orderPublicId: "order", status: "USED", usedAt: "2026-11-01T09:00:00Z", occurrence } : { accepted: true })); vi.stubGlobal("fetch", fetcher);
    render(<LabGuestTicket />); await screen.findByText("Проход уже отмечен");
    expect(screen.queryByRole("img")).not.toBeInTheDocument(); expect(location.hash).toBe("");
    fireEvent.change(screen.getByLabelText("Email заказа"), { target: { value: "guest@example.com" } });
    fireEvent.change(screen.getByLabelText("Номер заказа (необязательно)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Отправить ссылку на билет" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/v1/lab/guest/recover", expect.objectContaining({ body: JSON.stringify({ email: "guest@example.com" }) })));
  });
});
