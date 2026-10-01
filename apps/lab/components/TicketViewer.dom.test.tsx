import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import TicketViewer from "../app/ticket/TicketViewer";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  history.replaceState(null, "", "/ticket");
});

describe("TicketViewer", () => {
  it("announces loading while an authorized ticket request is pending", () => {
    history.replaceState(null, "", "/ticket#ticket-capability");
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<TicketViewer />);

    expect(screen.getByRole("status")).toHaveTextContent("Открываем билет…");
  });

  it("announces an unavailable ticket link as an alert", async () => {
    render(<TicketViewer />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Ссылка на билет недействительна или больше недоступна.");
  });
});
