import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import NavbarProfile from "./Navbar";
import type { NavbarConfig } from "./navbar-core";

vi.mock("next/navigation", () => ({ usePathname: () => "/ticket/abc" }));

// LAB fixture profile (FLEX-123). The full behaviour matrix lives in apps/platform/test/navbar*.test.ts*;
// this copy is byte-identical (drift test) and is smoke-checked here in the LAB build context.
const LAB: NavbarConfig = { variant: "LAB", myOrigin: "https://my.flexperiment.test",
  sessionUrl: "https://my.flexperiment.test/navbar/session", signOutUrl: "https://my.flexperiment.test/navbar/sign-out" };

describe("LAB Navbar (FLEX-123)", () => {
  it("guest goes to my sign-in in the same tab", async () => {
    render(<NavbarProfile config={LAB} fetcher={async () => Response.json({ signedIn: false })} />);
    const link = await screen.findByRole("link", { name: "Войти через my" });
    expect(link).toHaveAttribute("href", "https://my.flexperiment.test/sign-in");
    expect(link).not.toHaveAttribute("target");
  });
  it("signed-in LAB profile shows masked e-mail and «Мои билеты»", async () => {
    render(<NavbarProfile config={LAB} fetcher={async () => Response.json({ signedIn: true, displayName: null, emailMasked: "l***@e***.test" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Профиль" }));
    expect(await screen.findByText("l***@e***.test")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Мои билеты" })).toHaveAttribute("href", "https://my.flexperiment.test/tickets");
  });
});
