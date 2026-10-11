// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountClient from "../components/auth/AccountClient";

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe("AccountClient", () => {
  const originalFetch = global.fetch;
  afterEach(() => { cleanup(); global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("renders the authoritative open-lesson library and purchase history", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = input.toString();
      if (path === "/v1/me") return response({ customer: { id: "customer", email_normalized: "student@example.com" }, entitlements: [] });
      if (path === "/v1/me/consents?storefront=COURSES") return response({ storefront: "COURSES", verifiedAccount: true, requiredChoicesConfirmed: true, actionSequence: 0, documents: [] });
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
      if (path === "/v1/me/consents?storefront=COURSES") return response({ storefront: "COURSES", verifiedAccount: true, requiredChoicesConfirmed: true, actionSequence: 0, documents: [] });
      if (path === "/account-courses.json") return response({ courses: [] });
      if (path === "/v1/me/orders") return response({ orders: [] });
      throw new Error(`unhandled fetch: ${path}`);
    });

    render(<AccountClient nextPath="/account" />);

    expect(await screen.findByText(/Доступных уроков пока нет/)).toBeInTheDocument();
    expect(screen.getByText("Покупок пока нет.")).toBeInTheDocument();
  });

  it("preserves authenticated purchase history when required course consents are absent", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === "/v1/me") return response({ customer: { id: "customer", email_normalized: "student@example.test" } });
      if (input.toString() === "/v1/me/consents?storefront=COURSES") return response({ storefront: "COURSES", verifiedAccount: true,
        requiredChoicesConfirmed: false, actionSequence: 0, releaseVersion: null, manifestSha256: null, documents: [] });
      if (input.toString() === "/v1/me/orders") return response({ orders: [{ orderPublicId: "synthetic-order", title: "Historical course",
        state: "FULFILLED", amountKopecks: 100, currency: "RUB", createdAt: "2026-10-01T10:00:00Z" }] });
      throw new Error("Protected library must not be requested");
    });
    global.fetch = fetcher;
    render(<AccountClient nextPath="/account" />);
    expect(await screen.findByText("synthetic-order")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("Доступ остаётся закрытым");
    expect(screen.queryByRole("heading", { name: "Можно открыть сейчас" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([path]) => path.toString() === "/account-courses.json")).toBe(false);
    expect(screen.getByRole("button", { name: "Выйти из аккаунта" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "art@flexperiment.ru" })).toHaveAttribute("href", "mailto:art@flexperiment.ru");
  });
  it.each([true, false])("logout remains usable outside the gate; session revoked=%s is independently checked", async revoked => {
    let signOut = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = input.toString();
      if (path === "/v1/auth/sign-out" && init?.method === "POST") { signOut = true; return response({ success: true }); }
      if (path === "/v1/me") return response({ customer: signOut && revoked ? null : { id: "customer", email_normalized: "student@example.test" } });
      if (path === "/v1/me/consents?storefront=COURSES") return response({ storefront: "COURSES", verifiedAccount: true,
        requiredChoicesConfirmed: false, actionSequence: 0, releaseVersion: null, manifestSha256: null, documents: [] });
      if (path === "/v1/me/orders") return response({ orders: [] });
      if (path === "/v1/legal/current?storefront=COURSES") return Response.json({}, { status: 404 });
      throw new Error("Unexpected request");
    });
    global.fetch = fetcher; render(<AccountClient nextPath="/account" />);
    fireEvent.click(await screen.findByRole("button", { name: "Выйти из аккаунта" }));
    if (revoked) expect(await screen.findByRole("textbox", { name: "Электронная почта" })).toBeInTheDocument();
    else {
      expect(await screen.findByText("Не удалось подтвердить выход. Проверьте соединение и попробуйте снова.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "art@flexperiment.ru" })).toBeInTheDocument();
    }
    expect(fetcher.mock.calls.some(([path]) => path.toString() === "/account-courses.json")).toBe(false);
    expect(fetcher.mock.calls.filter(([path]) => path.toString() === "/v1/me")).toHaveLength(2);
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
    const personalData = screen.getByRole("checkbox", { name: /Согласен/ });
    const accountTerms = screen.getByRole("checkbox", { name: /Принимаю/ });
    const marketing = screen.getByRole("checkbox", { name: /Хочу получать/ });
    expect(personalData).toBeRequired();
    expect(accountTerms).toBeRequired();
    expect(marketing).not.toBeRequired();
    for (const choice of [personalData, accountTerms, marketing]) expect(choice).not.toBeChecked();
    expect(personalData.closest("label")!.querySelectorAll("a")).toHaveLength(1);
    expect(accountTerms.closest("label")!.querySelectorAll("a")).toHaveLength(1);
    expect(personalData.closest("label")).not.toHaveTextContent(/условия аккаунта|политик/);
    expect(accountTerms.closest("label")).not.toHaveTextContent(/персональных данных/);
    fireEvent.change(screen.getByRole("textbox", { name: "Электронная почта" }), { target: { value: "student@example.com" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Согласен/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Принимаю/ }));
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
        accountTermsAccepted: true,
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
