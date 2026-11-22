import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import LabV2Client from "./LabV2Client";
import LabInterestLink from "./LabInterestLink";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../lib/commerce-api", () => ({ commerceApiUrl: (path: string) => path }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ""; });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const event = { occurrenceRef: "lab:dec", cityId: "nsk", title: "LAB в декабре", startsAt: "2026-12-05T09:00:00Z", endsAt: "2026-12-05T17:00:00Z",
  timezone: "Asia/Novosibirsk", amountKopecks: 250000, currency: "RUB", venue: { status: "CONFIRMED", name: "Студия", address: "Адрес" } };
const consent = { version: "e-draft", text: "Согласие на уведомление о старте продаж (фикстура)", textSha256: "b".repeat(64) };
const showcase = (available = true) => ({ schema: "flexperiment.lab-showcase/1", sales: { state: "CLOSED", reason: "OFFERS_CLOSED" },
  interest: { available, consent }, cities: [{ cityId: "nsk", slug: "nsk", title: "Новосибирск" }], occurrences: [{ ...event, sales: "CLOSED" }] });
const stub = (available = true, interestStatus = 202) => {
  const fetcher = vi.fn(async (path: string, ...rest: [RequestInit?]) => { void rest;
    if (path === "/v1/lab/showcase") return response(showcase(available));
    if (path === "/v1/lab/catalogue") return response({ schema: "flexperiment.lab-catalogue/1", paymentMode: "mock", cities: [], occurrences: [] });
    if (path === "/v1/me") return response({ customer: null });
    if (path === "/v1/lab/interest") return response({ accepted: true }, interestStatus);
    throw new Error(`unexpected ${path}`);
  });
  vi.stubGlobal("fetch", fetcher); return fetcher;
};

describe("FLEX-8 LAB showcase UI", () => {
  it("shows dates, prices and a clear closed status without any buy action", async () => {
    const fetcher = stub(); render(<LabV2Client />);
    await screen.findByText(event.title);
    expect(screen.getAllByRole("status").some((node) => /Продажи закрыты/.test(node.textContent ?? ""))).toBe(true);
    expect(screen.getByText(/2\s*500,00\s*₽/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Продажи закрыты" })).toBeDisabled();
    expect(screen.queryByLabelText("Email для билета и чека")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([path]) => String(path).includes("checkout") || String(path).includes("guest/start"))).toBe(false);
  });

  it("requires the separate unticked consent and sends only email, city and the consent hash", async () => {
    const fetcher = stub(); render(<LabV2Client />);
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "fan@example.test" } });
    fireEvent.change(screen.getByLabelText("Город"), { target: { value: "nsk" } });
    const submit = screen.getByRole("button", { name: "Оставить предзапись" });
    const box = screen.getByRole("checkbox"); expect(box).not.toBeChecked(); expect(submit).toBeDisabled();
    fireEvent.click(box); fireEvent.click(submit);
    expect(await screen.findByText(/Проверьте почту/)).toBeInTheDocument();
    const call = fetcher.mock.calls.find(([path]) => path === "/v1/lab/interest")!;
    expect(JSON.parse(String(call[1]!.body))).toEqual({ email: "fan@example.test", cityId: "nsk", consent: { version: "e-draft", textSha256: "b".repeat(64) } });
  });

  it("says pre-registration is unavailable when the server cannot send confirmations", async () => {
    stub(false); render(<LabV2Client />);
    expect(await screen.findByText("Предзапись временно недоступна.")).toBeInTheDocument();
  });
});

describe("FLEX-8 confirm and withdraw links", () => {
  it.each([["confirm", "/v1/lab/interest/confirm", /Предзапись подтверждена/], ["withdraw", "/v1/lab/interest/withdraw", /отказались от уведомлений/]])(
    "posts the %s token from the fragment and clears it from the address bar", async (kind, path, text) => {
      const fetcher = vi.fn(async () => response({ ok: true })); vi.stubGlobal("fetch", fetcher);
      window.history.replaceState(null, "", `/interest#${kind}=token-value`);
      render(<LabInterestLink />);
      expect(await screen.findByText(text)).toBeInTheDocument();
      expect(fetcher).toHaveBeenCalledWith(path, expect.objectContaining({ method: "POST", body: JSON.stringify({ token: "token-value" }) }));
      expect(window.location.hash).toBe("");
    });
  it("reports an invalid link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ code: "LAB_INTEREST_TOKEN_INVALID" }, 422)));
    window.history.replaceState(null, "", "/interest#confirm=stale");
    render(<LabInterestLink />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/недействительна/);
  });
});
