// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthenticatedConsentGate from "../components/auth/AuthenticatedConsentGate";

const status = (confirmed = false) => ({ storefront: "COURSES", verifiedAccount: true, requiredChoicesConfirmed: confirmed,
  releaseVersion: "synthetic-release", manifestSha256: "a".repeat(64), documents: ["privacy", "personal_data", "account_terms", "marketing_consent"]
    .map(kind => ({ kind, version: "synthetic-v1", sha256: "a".repeat(64), url: `https://test.invalid/${kind}` })) });
const response = (body: unknown) => Response.json(body);
const enter = async () => {
  render(<AuthenticatedConsentGate><p>Protected library</p></AuthenticatedConsentGate>);
  const button = await screen.findByRole("button", { name: "Подтвердить выбор" });
  return button;
};
const choose = () => {
  fireEvent.click(screen.getByRole("checkbox", { name: /Согласен/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Принимаю/ }));
};
const originalFetch = global.fetch;
afterEach(() => { cleanup(); global.fetch = originalFetch; vi.restoreAllMocks(); });
describe("authenticated consent UI admission and reconciliation", () => {
  it("starts with independent unchecked choices and confirms required choices without marketing", async () => {
    let committed = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { committed = true; return response({ ok: true }); }
      return response(status(committed));
    });
    global.fetch = fetcher;
    const button = await enter();
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(screen.queryByText("Protected library")).not.toBeInTheDocument();
    choose(); fireEvent.click(button);
    expect(await screen.findByText("Protected library")).toBeInTheDocument();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1]!.body as string)).toMatchObject({ personalDataConsent: true, accountTermsAccepted: true,
      marketingConsent: false, releaseVersion: "synthetic-release", manifestSha256: "a".repeat(64) });
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });
  it.each(["lost POST response", "failed read-back"])("reconciles %s after COMMIT using GET only", async failure => {
    let committed = false; let failReadBack = true;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        committed = true;
        if (failure === "lost POST response") throw new Error("synthetic transport failure");
        return response({ ok: true });
      }
      if (committed && failReadBack) { failReadBack = false; throw new Error("synthetic GET failure"); }
      return response(status(committed));
    });
    global.fetch = fetcher;
    const button = await enter(); choose(); fireEvent.click(button);
    const reconcile = await screen.findByRole("button", { name: "Проверить результат без повторной записи" });
    expect(screen.queryByText("Protected library")).not.toBeInTheDocument();
    expect(button).toBeDisabled();
    fireEvent.click(reconcile);
    if (failure === "lost POST response") {
      await screen.findByText("Не удалось проверить результат. Повторная запись не выполнялась.");
      fireEvent.click(reconcile);
    }
    expect(await screen.findByText("Protected library")).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each(["unverified", "missing legal", "wrong storefront", "status failure"])("keeps content closed for %s", async condition => {
    global.fetch = vi.fn(async () => {
      if (condition === "status failure") throw new Error("synthetic error");
      return response({ ...status(), ...(condition === "unverified" ? { verifiedAccount: false } : {}),
        ...(condition === "missing legal" ? { documents: [], releaseVersion: null } : {}),
        ...(condition === "wrong storefront" ? { storefront: "LAB" } : {}) });
    });
    render(<AuthenticatedConsentGate><p>Protected library</p></AuthenticatedConsentGate>);
    await screen.findByRole("alert");
    expect(screen.queryByText("Protected library")).not.toBeInTheDocument();
  });
  it("discards a late committed response after the account gate is unmounted", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
      ? new Promise<Response>(resolve => { finish = resolve; }) : response(status()));
    global.fetch = fetcher;
    const button = await enter(); choose(); fireEvent.click(button);
    await waitFor(() => expect(finish).toBeDefined()); cleanup();
    finish(response({ ok: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
