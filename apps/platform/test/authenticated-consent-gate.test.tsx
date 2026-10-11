// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthenticatedConsentGate from "../components/auth/AuthenticatedConsentGate";

const status = (confirmed = false) => ({ storefront: "COURSES", verifiedAccount: true, requiredChoicesConfirmed: confirmed,
  actionSequence: confirmed ? 3 : 0,
  releaseVersion: "synthetic-release", manifestSha256: "a".repeat(64), documents: ["privacy", "personal_data", "account_terms", "marketing_consent"]
    .map(kind => ({ kind, version: "synthetic-v1", sha256: "a".repeat(64), url: `https://test.invalid/${kind}` })) });
const response = (body: unknown) => Response.json(body);
const readBack = (input: RequestInfo | URL, committed = false, changes = {}) => {
  const key = new URL(input.toString(), "https://test.invalid").searchParams.get("actionKey");
  return response({ ...status(committed), ...(key ? { action: { key, outcome: committed ? "COMMITTED" : "ABSENT" } } : {}), ...changes });
};
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
  it.each(["definitive rejection", "ambiguous absence"])("permits a fresh explicit choice only after %s and authoritative read-back", async failure => {
    let attempts = 0; let committed = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        attempts++;
        if (attempts === 1) {
          if (failure === "ambiguous absence") throw new Error("transport failure before commit");
          return Response.json({ code: "AUTHENTICATED_CONSENT_INPUT_INVALID" }, { status: 409 });
        }
        committed = true; return response({ ok: true });
      }
      return readBack(input, committed);
    });
    global.fetch = fetcher;
    const button = await enter(); choose(); fireEvent.click(button);
    if (failure === "ambiguous absence") {
      const reconcile = await screen.findByRole("button", { name: "Проверить результат без повторной записи" });
      expect(button).toBeDisabled(); fireEvent.click(reconcile);
    }
    const retry = await screen.findByRole("button", { name: "Начать новую попытку" });
    expect(button).toBeDisabled();
    expect(attempts).toBe(1); fireEvent.click(retry);
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Подтвердить выбор" })).toBeEnabled();
    expect(attempts).toBe(1); choose(); fireEvent.click(screen.getByRole("button", { name: "Подтвердить выбор" }));
    expect(await screen.findByText("Protected library")).toBeInTheDocument();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init!.body as string));
    expect(posts).toHaveLength(2); expect(posts[1].actionKey).not.toBe(posts[0].actionKey);
    expect(posts[1]).toMatchObject({ expectedActionSequence: 0, marketingConsent: false });
    const reads = fetcher.mock.calls.filter(([path]) => path.toString().includes("actionKey="));
    expect(reads[0][0].toString()).toContain(posts[0].actionKey);
  });
  it.each(["failed GET", "missing action proof", "wrong action key", "committed but unconfirmed", "unknown HTTP error"])(
    "does not unlock retry for %s", async failure => {
      let posted = false;
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted = true;
          if (failure === "unknown HTTP error") return Response.json({ code: "CONSENT_WRITE_UNCONFIRMED" }, { status: 409 });
          throw new Error("lost response");
        }
        if (!posted) return response(status());
        if (failure === "failed GET") throw new Error("read unavailable");
        if (failure === "missing action proof") return response(status());
        if (failure === "wrong action key") return readBack(input, false, { action: { key: "foreign-action-key", outcome: "ABSENT" } });
        return readBack(input, false, { action: { key: new URL(input.toString(), "https://test.invalid").searchParams.get("actionKey"), outcome: "COMMITTED" } });
      });
      global.fetch = fetcher;
      const button = await enter(); choose(); fireEvent.click(button);
      const reconcile = await screen.findByRole("button", { name: "Проверить результат без повторной записи" });
      fireEvent.click(reconcile);
      await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => path.toString().includes("actionKey="))).toHaveLength(failure === "unknown HTTP error" ? 2 : 1));
      expect(screen.queryByRole("button", { name: "Начать новую попытку" })).not.toBeInTheDocument();
      expect(button).toBeDisabled(); expect(screen.queryByText("Protected library")).not.toBeInTheDocument();
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    });
  it("reloads rotated legal documents and requires new unchecked choices, never the old payload", async () => {
    let posted = false; let committed = false;
    const rotated = { releaseVersion: "synthetic-release-2", manifestSha256: "b".repeat(64),
      documents: status().documents.map(document => ({ ...document, version: "synthetic-v2", sha256: "b".repeat(64), url: `${document.url}/v2` })) };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (!posted) { posted = true; return Response.json({ code: "LEGAL_RELEASE_STALE" }, { status: 409 }); }
        committed = true; return response({ ok: true });
      }
      return readBack(input, committed, posted ? rotated : {});
    });
    global.fetch = fetcher;
    const button = await enter(); choose(); fireEvent.click(screen.getByRole("checkbox", { name: /Хочу/ })); fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("link", { name: "условия аккаунта" })).toHaveAttribute("href", "https://test.invalid/account_terms/v2"));
    for (const checkbox of screen.getAllByRole("checkbox")) expect(checkbox).not.toBeChecked();
    choose(); fireEvent.click(screen.getByRole("button", { name: "Подтвердить выбор" }));
    expect(await screen.findByText("Protected library")).toBeInTheDocument();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(init!.body as string));
    expect(posts[1]).toMatchObject({ releaseVersion: rotated.releaseVersion, manifestSha256: rotated.manifestSha256, marketingConsent: false });
    expect(posts[1].actionKey).not.toBe(posts[0].actionKey);
  });
  it("starts with independent unchecked choices and confirms required choices without marketing", async () => {
    let committed = false;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") { committed = true; return response({ ok: true }); }
      return readBack(_input, committed);
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
      return readBack(_input, committed);
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
