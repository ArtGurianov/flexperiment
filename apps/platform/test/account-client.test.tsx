// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountClient from "../components/auth/AccountClient";

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe("AccountClient", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("renders the authoritative open-lesson library and purchase history", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = input.toString();
      if (path === "/v1/me") return response({ customer: { id: "customer", email_normalized: "student@example.com" }, entitlements: [] });
      if (path === "/account-courses.json") return response({ courses: [{
        courseRef: "course-1",
        title: "Практический курс",
        url: "/courses/practice",
        access: "ENTITLED",
        lessons: [{ lessonRef: "lesson-1", title: "Первый урок", sectionTitle: "Старт", url: "/courses/practice/lessons/first", access: "ENTITLED" }],
      }] });
      if (path === "/v1/me/orders") return response({ orders: [{
        orderPublicId: "FX-V2-1",
        state: "FULFILLED",
        amountKopecks: 120000,
        currency: "RUB",
        title: "Практический курс",
        offerRef: "course:course-1",
        productKind: "ONLINE_COURSE",
        createdAt: "2026-09-30T10:00:00.000Z",
      }] });
      throw new Error(`unhandled fetch: ${path}`);
    });

    render(<AccountClient nextPath="/account" />);

    expect(await screen.findByRole("heading", { name: "Практический курс" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Первый урок" })).toHaveAttribute("href", "/courses/practice/lessons/first");
    expect(screen.getByText("FX-V2-1")).toBeInTheDocument();
    expect(screen.getByText(/1[\s\u00a0]?200\s*₽/)).toBeInTheDocument();
  });

  it("keeps the account route useful when the signed-in customer has no access yet", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = input.toString();
      if (path === "/v1/me") return response({ customer: { id: "customer", email_normalized: "new@example.com" }, entitlements: [] });
      if (path === "/account-courses.json") return response({ courses: [] });
      if (path === "/v1/me/orders") return response({ orders: [] });
      throw new Error(`unhandled fetch: ${path}`);
    });

    render(<AccountClient nextPath="/account" />);

    expect(await screen.findByText(/Доступных уроков пока нет/)).toBeInTheDocument();
    expect(screen.getByText("Покупок пока нет.")).toBeInTheDocument();
  });
});
