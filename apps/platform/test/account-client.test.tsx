// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("submits the active legal document versions and hashes for registration", async () => {
    const hash = "a".repeat(64);
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = input.toString();
      if (path === "/v1/me") return response({ customer: null });
      if (path === "/v1/legal/current?storefront=COURSES") return response({
        version: "stage-a-v1",
        manifest: { stage: "A", documents: ["privacy", "personal_data", "account_terms", "marketing_consent"].map((kind) => ({
          kind, version: `${kind}-v1`, sha256: hash, url: `https://flexperiment.ru/legal/${kind}`,
        })) },
      });
      if (path === "/v1/auth/sign-in/magic-link" && init?.method === "POST") return response({ ok: true });
      throw new Error(`unhandled fetch: ${path}`);
    });

    render(<AccountClient nextPath="/courses" />);
    const submit = await screen.findByRole("button", { name: "Получить ссылку →" });
    expect(screen.getByRole("link", { name: "обработкой персональных данных" })).toHaveAttribute("href", "https://flexperiment.ru/legal/personal_data");
    fireEvent.change(screen.getByRole("textbox", { name: "Электронная почта" }), { target: { value: "student@example.com" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Согласен/ }));
    fireEvent.click(submit);

    await waitFor(() => expect(vi.mocked(global.fetch)).toHaveBeenCalledWith("/v1/auth/sign-in/magic-link", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        email: "student@example.com",
        storefront: "COURSES",
        metadata: { storefront: "COURSES" },
        callbackURL: "http://localhost:3000/courses",
        captchaToken: "",
        personalDataConsent: true,
        personalDataVersion: "personal_data-v1",
        personalDataSha256: hash,
        accountTermsVersion: "account_terms-v1",
        accountTermsSha256: hash,
        marketingConsent: false,
        marketingDocumentVersion: "marketing_consent-v1",
        marketingDocumentSha256: hash,
      }),
    })));
  });
});
