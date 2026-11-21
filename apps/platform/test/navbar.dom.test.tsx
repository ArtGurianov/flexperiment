// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NavbarProfile from "../components/navbar/Navbar";
import type { NavbarConfig } from "../components/navbar/navbar-core";
import fixtures from "./fixtures/navbar-sessions.json";

vi.mock("next/navigation", () => ({ usePathname: () => "/courses/flex-basics" }));

const LMS = fixtures.config.LMS as NavbarConfig;
const LAB = fixtures.config.LAB as NavbarConfig;
const json = (body: unknown, status = 200) => Response.json(body, { status });

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("FLEX-123 Navbar profile slot", () => {
  it("reserves a stable slot while loading and shows the guest action in the same tab", async () => {
    let release!: () => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(json(fixtures.answers.signedOut)); }));
    const { container } = render(<NavbarProfile config={LMS} fetcher={fetcher} />);
    expect(container.querySelector("[aria-hidden='true']")).toBeInTheDocument();
    await act(async () => release());
    const link = await screen.findByRole("link", { name: "Войти через my" });
    expect(link).toHaveAttribute("href", "/auth/lms/start?next=%2Fcourses%2Fflex-basics");
    expect(link).not.toHaveAttribute("target");
  });

  it("shows the name, opens an accessible popover with my links and closes on Esc with focus return", async () => {
    const fetcher = vi.fn(async () => json(fixtures.answers.lmsNamed));
    render(<NavbarProfile config={LMS} fetcher={fetcher} />);
    const trigger = await screen.findByRole("button", { name: "Курсант" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("b***@e***.test")).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); // re-check on opening
    expect(screen.getByText("b***@e***.test")).toBeInTheDocument();
    for (const [name, path] of [["Личный кабинет", "/"], ["Мои курсы", "/courses"], ["Мои билеты", "/tickets"]]) {
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAttribute("href", `https://my.flexperiment.test${path}`);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
    screen.getByRole("link", { name: "Мои курсы" }).focus();
    fireEvent.keyDown(screen.getByRole("link", { name: "Мои курсы" }), { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByText("b***@e***.test")).not.toBeInTheDocument();
  });

  it("uses a neutral profile button without a name (LAB fixture)", async () => {
    render(<NavbarProfile config={LAB} fetcher={async () => json(fixtures.answers.labUnnamed)} />);
    expect(await screen.findByRole("button", { name: "Профиль" })).toBeInTheDocument();
  });

  it("clears the profile immediately on sign-out and keeps it cleared when a stale answer arrives", async () => {
    let stale!: (r: Response) => void;
    let gets = 0;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "POST") return new Response(null, { status: 204 });
      gets += 1;
      return gets === 1 ? json(fixtures.answers.lmsNamed) : new Promise<Response>((resolve) => { stale = resolve; });
    });
    render(<NavbarProfile config={LMS} fetcher={fetcher} />);
    fireEvent.click(await screen.findByRole("button", { name: "Курсант" }));
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(await screen.findByRole("link", { name: "Войти через my" })).toBeInTheDocument();
    await act(async () => stale(json(fixtures.answers.lmsNamed)));
    expect(screen.queryByText("b***@e***.test")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Курсант" })).not.toBeInTheDocument();
  });

  it("re-checks on focus and drops a revoked profile", async () => {
    let answer = json(fixtures.answers.lmsNamed);
    render(<NavbarProfile config={LMS} fetcher={async () => answer.clone()} />);
    await screen.findByRole("button", { name: "Курсант" });
    answer = json(fixtures.answers.signedOut);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByRole("link", { name: "Войти через my" })).toBeInTheDocument();
  });

  it("keeps a working link to my when the check fails", async () => {
    render(<NavbarProfile config={LAB} fetcher={async () => { throw new TypeError("offline"); }} />);
    const link = await screen.findByRole("link", { name: "Личный кабинет my" });
    expect(link).toHaveAttribute("href", "https://my.flexperiment.test/");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("marks the slot as excluded from analytics and session recording", async () => {
    const { container } = render(<NavbarProfile config={LMS} fetcher={async () => json(fixtures.answers.signedOut)} />);
    const slot = container.firstElementChild!;
    expect(slot).toHaveClass("ym-hide-content", "ym-disable-keys");
    expect(slot).toHaveAttribute("data-analytics-exclude");
  });
});
