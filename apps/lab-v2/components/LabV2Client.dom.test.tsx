import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import LabV2Client from "./LabV2Client";

vi.mock("../../../lib/commerce-api", () => ({ commerceApiUrl: (path: string) => path }));
const catalogue = { schema: "flexperiment.lab-catalogue/1", paymentMode: "disabled", cities: [], occurrences: [] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { cleanup();vi.unstubAllGlobals(); });

describe("separate LAB V2 entrypoint", () => {
  it("uses only V2 read contracts and keeps empty catalogue/login/payment closed", async () => {
    const fetcher = vi.fn(async (path: string) => response(path === "/v1/me" ? { customer: null } : catalogue));vi.stubGlobal("fetch", fetcher);
    render(<LabV2Client />);await screen.findByText("Опубликованных встреч пока нет.");
    expect(fetcher.mock.calls.map(([path]) => path).sort()).toEqual(["/v1/lab/catalogue", "/v1/me"]);
    expect(screen.queryByRole("button", { name: /Получить ссылку/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "refunds@flexperiment.ru" })).toHaveAttribute("href", "mailto:refunds@flexperiment.ru");
    expect(screen.queryByRole("button", { name: /возврат/i })).not.toBeInTheDocument();
    for (const [, init] of fetcher.mock.calls as unknown as [string, RequestInit][]) expect(init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  });
  it("refuses a legacy/malformed response without silently falling back", async () => {
    const fetcher = vi.fn(async (path: string) => response(path ? { tour: [], customer: null } : {}));vi.stubGlobal("fetch", fetcher);
    render(<LabV2Client />);await screen.findByRole("alert");
    expect(fetcher.mock.calls).toHaveLength(2);expect(fetcher.mock.calls.every(([path]) => !path.includes("/public/"))).toBe(true);
  });
  it("renders published facts but never creates a payment or exposes a buy action", async () => {
    const event = { occurrenceRef: "fixture-event", offerRef: "lab:fixture", cityId: "fixture", title: "Isolated published fixture", startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T12:00:00Z", timezone: "Europe/Moscow", amountKopecks: 12345, currency: "RUB", venue: { status: "CONFIRMED", name: null, address: null }, soldOut: false };
    vi.stubGlobal("fetch", vi.fn(async (path: string) => response(path === "/v1/me" ? { customer: null } : { ...catalogue, occurrences: [event] })));
    render(<LabV2Client />);await screen.findByText(event.title);expect(screen.getByRole("button", { name: "Покупка закрыта" })).toBeDisabled();
    expect(screen.getByText("Адрес сообщим участникам")).toBeInTheDocument();
  });
  it("shows a TBA disclosure and a sold-out occurrence without a buy action", async () => {
    const event = { occurrenceRef: "fixture-event", offerRef: "lab:fixture", cityId: "fixture", title: "Isolated sold-out fixture", startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T12:00:00Z", timezone: "Europe/Moscow", amountKopecks: 12345, currency: "RUB",
      venue: { status: "TO_BE_ANNOUNCED", disclosureText: "Площадку объявим за неделю", announceBy: "2026-10-25T10:00:00Z" }, soldOut: true };
    vi.stubGlobal("fetch", vi.fn(async (path: string) => response(path === "/v1/me" ? { customer: null } : { ...catalogue, occurrences: [event] })));
    render(<LabV2Client />);await screen.findByText(event.title);
    expect(screen.getByText("Площадку объявим за неделю")).toBeInTheDocument();expect(screen.getByRole("button", { name: "Мест нет" })).toBeDisabled();
  });
  it("renders the price and Offer JSON-LD from the same live Commerce response (ART-341)", async () => {
    const event = { occurrenceRef: "lab:november", offerRef: "lab:november", cityId: "nsk", title: "LAB в ноябре", startsAt: "2026-11-01T09:00:00Z", endsAt: "2026-11-01T17:00:00Z", timezone: "Asia/Novosibirsk", amountKopecks: 250000, currency: "RUB", venue: { status: "CONFIRMED", name: "Студия", address: "Красный проспект, 1" }, soldOut: false };
    const live = (amountKopecks: number, soldOut = false) => vi.stubGlobal("fetch", vi.fn(async (path: string) => response(path === "/v1/me" ? { customer: null }
      : { ...catalogue, cities: [{ cityId: "nsk", slug: "nsk", title: "Новосибирск" }], occurrences: [{ ...event, amountKopecks, soldOut }] })));
    const offer = () => JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!)[0].offers;
    live(250000);
    const first = render(<LabV2Client />);await screen.findByText(event.title);
    expect(screen.getByText(/2\s*500,00\s*₽/)).toBeInTheDocument();
    expect(offer()).toEqual({ "@type": "Offer", price: "2500.00", priceCurrency: "RUB" });
    first.unmount();vi.unstubAllGlobals();

    // A Control Room price change reaches the next page load, visible price and JSON-LD together.
    live(300000, true);
    render(<LabV2Client />);await screen.findByText(event.title);
    expect(screen.getByText(/3\s*000,00\s*₽/)).toBeInTheDocument();
    expect(offer()).toEqual({ "@type": "Offer", price: "3000.00", priceCurrency: "RUB", availability: "https://schema.org/SoldOut" });
  });
  it("keeps the V2 entrypoint free of build-time occurrence or price data", () => {
    const root = join(process.cwd(), "apps", "lab-v2");
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (["node_modules", ".next", "out"].includes(entry.name) ? [] : sources(join(dir, entry.name)))
        : /\.(tsx?|json)$/.test(entry.name) && !entry.name.includes(".test.") ? [join(dir, entry.name)] : []);
    for (const file of sources(root)) expect(readFileSync(file, "utf8")).not.toMatch(/occurrences\.v1|data\/seo|amountKopecks:\s*\d/);
  });
  it("loads only owned LAB order history and clears it after confirmed sign-out", async () => {
    const order = { orderPublicId: "fixture-order", title: "Owned LAB fixture", offerRef: "lab:fixture", productKind: "LAB", state: "FULFILLED", amountKopecks: 12345, currency: "RUB", createdAt: "2026-10-11T00:00:00Z" };
    const fetcher = vi.fn(async (path: string) => response(path === "/v1/me" ? { customer: { id: "fixture", email_normalized: "fixture@invalid.example" } } : path === "/v1/me/orders" ? { orders: [order, { ...order, title: "Foreign storefront fixture", productKind: "ONLINE_COURSE" }] } : path === "/v1/auth/sign-out" ? { success: true } : catalogue));vi.stubGlobal("fetch", fetcher);
    render(<LabV2Client />);await screen.findByText(order.title);expect(screen.queryByText("Foreign storefront fixture")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выйти из аккаунта" }));
    await waitFor(() => expect(screen.queryByText(order.title)).not.toBeInTheDocument());
    expect(fetcher).toHaveBeenCalledWith("/v1/auth/sign-out", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
  });
});
