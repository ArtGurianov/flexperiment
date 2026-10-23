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
  it("restores the guest's frozen promo on reload and shows a rejected-code message before any payment", async () => {
    const token = "t".repeat(43);
    sessionStorage.setItem("lab-guest-v1:lab:one", JSON.stringify({ accessToken: token, previewKey: "same-preview", paymentKey: "same-pay", email: "guest@example.com", checkoutCode: "PARTNER20" }));
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.endsWith("/start")) return response({ orderPublicId: "order" });
      expect(JSON.parse(String(options?.body))).toMatchObject({ checkoutCode: "PARTNER20" });
      return response({ ...quote, checkoutCodeOutcome: "NOT_APPLIED_CAMPAIGN_PAUSED" });
    });
    vi.stubGlobal("fetch", fetcher);
    render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    expect(await screen.findByText("Кампания приостановлена; код не применён.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Подтвердить и оплатить" })).toBeDisabled();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/lab/guest/start", "/v1/checkout/preview"]);
  });
  it("retires the old checkout on the server before new keys and a changed promo can be used", async () => {
    const first = { accessToken: "t".repeat(43), previewKey: "old-preview", paymentKey: "old-pay", email: "guest@example.com", checkoutCode: "OLD" };
    sessionStorage.setItem("lab-guest-v1:lab:one", JSON.stringify(first));
    const bodies: Array<{ path: string; options?: RequestInit }> = [];
    const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
      bodies.push({ path, options });
      if (path.endsWith("/start")) return response({ orderPublicId: "order" });
      if (path.endsWith("/restart")) return response({ restartAllowed: true });
      return response({ state: "DECLINED", orderPublicId: "order" });
    });
    vi.stubGlobal("fetch", fetcher); render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    await screen.findByText(/Платёж отклонён/);
    expect(screen.getByLabelText("Промокод")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Начать новый заказ" }));
    await screen.findByText(/Можно проверить условия нового заказа/);
    expect(sessionStorage.getItem("lab-guest-v1:lab:one")).toBeNull();
    fireEvent.change(screen.getByLabelText("Промокод"), { target: { value: "NEW" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить условия" }));
    await waitFor(() => expect(bodies.filter(b => b.path === "/v1/checkout/preview")).toHaveLength(2));
    const latest = bodies.filter(b => b.path === "/v1/checkout/preview")[1];
    expect(JSON.parse(String(latest.options?.body)).checkoutCode).toBe("NEW");
    expect(latest.options?.headers).not.toMatchObject({ "Idempotency-Key": first.previewKey });
    expect(latest.options?.headers).not.toMatchObject({ Authorization: `Bearer ${first.accessToken}` });
  });
  it.each(["uncertain", "offline"])("keeps old capability/keys if restart is %s", async condition => {
    const first = { accessToken: "t".repeat(43), previewKey: "old-preview", paymentKey: "old-pay", email: "guest@example.com", checkoutCode: "OLD" };
    sessionStorage.setItem("lab-guest-v1:lab:one", JSON.stringify(first));
    const fetcher = vi.fn(async (path: string) => {
      if (path.endsWith("/start")) return response({ orderPublicId: "order" });
      if (path.endsWith("/restart")) {
        if (condition === "offline") throw new TypeError("offline");
        return response({ code: "LAB_CHECKOUT_RESTART_UNSAFE" }, 409);
      }
      return response({ state: "RESOLUTION_PENDING", orderPublicId: "order" });
    });
    vi.stubGlobal("fetch", fetcher); render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    await screen.findByText(/Уточняем условия/);
    const saved = sessionStorage.getItem("lab-guest-v1:lab:one");
    fireEvent.click(screen.getByRole("button", { name: "Начать новый заказ" }));
    await screen.findByText(/Заказ и ключи сохранены/);
    expect(sessionStorage.getItem("lab-guest-v1:lab:one")).toBe(saved);
    expect(screen.getByLabelText("Промокод")).toBeDisabled();
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual(["/v1/lab/guest/start", "/v1/checkout/preview", "/v1/lab/guest/restart"]);
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

 describe("second review: guest page restoration", () => {
  it.each(["PENDING", "CUSTOMER_ACTION_REQUIRED", "CREATE_UNKNOWN"])("restores %s without start or automatic bank navigation", async state => {
    const saved = JSON.stringify({ accessToken: "t".repeat(43), orderPublicId: "order", previewKey: "preview", paymentKey: "pay", email: "guest@example.test" });
    sessionStorage.setItem("lab-guest-v1:lab:one", saved);
    const request = vi.fn(async () => response({ state, orderPublicId: "order", checkoutUrl: "https://bank.example.test/pay" }));
    vi.stubGlobal("fetch", request); render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    expect(await screen.findByRole("link", { name: "Продолжить оплату" })).toHaveAttribute("href", "https://bank.example.test/pay");
    expect(request).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledWith("/v1/checkout/preview", expect.any(Object));
    expect(sessionStorage.getItem("lab-guest-v1:lab:one")).toBe(saved);
  });
  it("shows a paid ticket and permits deliberate safe restart without discarding the ticket link", async () => {
    sessionStorage.setItem("lab-guest-v1:lab:one", JSON.stringify({ accessToken: "t".repeat(43), orderPublicId: "order", previewKey: "preview", paymentKey: "pay", email: "guest@example.test" }));
    const request = vi.fn(async (path: string) => response(path.endsWith("/restart") ? { restartAllowed: true } : { state: "PAID", orderPublicId: "order" }));
    vi.stubGlobal("fetch", request); render(<LabGuestCheckout offerRef="lab:one" displayedAmountKopecks={10000} />);
    await screen.findByText(/Заказ оплачен/);
    const ticket = screen.getByRole("link", { name: "Проверить заказ и билет" }).getAttribute("href");
    fireEvent.click(screen.getByRole("button", { name: "Начать новый заказ" }));
    await screen.findByText(/Можно проверить условия нового заказа/);
    expect(sessionStorage.getItem("lab-guest-v1:lab:one")).toBeNull();
    expect(screen.getByRole("link", { name: "Проверить заказ и билет" })).toHaveAttribute("href", ticket);
    expect(request.mock.calls.map(([path]) => path)).toEqual(["/v1/checkout/preview", "/v1/lab/guest/restart"]);
  });
});
