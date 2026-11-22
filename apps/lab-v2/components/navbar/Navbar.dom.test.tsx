import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Navbar from "./Navbar";

vi.mock("next/navigation", () => ({ usePathname: () => "/ticket" }));

// LAB fixture (FLEX-123): guest-only until LAB moves to my. Behaviour matrix: apps/platform/test/navbar*.
describe("LAB Navbar (FLEX-123)", () => {
  it("shows a same-tab «Войти через my» without reading any session", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<Navbar myOrigin="https://my.flexperiment.test" />);
    const link = await screen.findByRole("link", { name: "Войти через my" });
    expect(link).toHaveAttribute("href", "https://my.flexperiment.test/sign-in");
    expect(link).not.toHaveAttribute("target");
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Выйти" })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
