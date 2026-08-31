import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NotifyMeForm from "./NotifyMeForm";

vi.mock("@/components/SmartCaptcha", () => ({
  default: ({ onToken, resetKey }: { onToken: (token: string | null) => void; resetKey: number }) => (
    <button type="button" data-testid="captcha" data-reset-key={resetKey} onClick={() => onToken("captcha-proof")}>Solve captcha</button>
  ),
}));

const props = (onConflict?: (code: string) => void) => ({
  endpoint: "/v1/public/occurrence-notifications",
  intro: "Notify me",
  submitLabel: "Submit notification",
  successText: "Saved",
  consentPurpose: "for this notification.",
  buildBody: (base: { email: string; pd_consent_accepted: true; captcha_token: string }) => ({ ...base, occurrence_id: "00000000-0000-4000-8000-000000000001" }),
  onConflict,
});

describe("NotifyMeForm", () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; vi.restoreAllMocks(); });

  it("does not submit without a captcha token and requires consent after the captcha is solved", () => {
    global.fetch = vi.fn();
    render(<NotifyMeForm {...props()} />);
    const form = screen.getByRole("button", { name: "Submit notification" }).closest("form")!;
    const submit = screen.getByRole("button", { name: "Submit notification" });
    expect(submit).toBeDisabled();
    fireEvent.submit(form);
    expect(global.fetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("captcha"));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(submit).toBeEnabled();
  });

  it("resets captcha after successful and failed submissions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ accepted: true }) } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: { code: "NOTIFICATIONS_NOT_AVAILABLE" } }) } as Response);
    global.fetch = fetchMock;
    const first = render(<NotifyMeForm {...props()} />);
    fireEvent.click(screen.getByTestId("captcha"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Submit notification" }).closest("form")!);
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // Success removes the form and its one-time captcha widget altogether.
    expect(screen.queryByTestId("captcha")).not.toBeInTheDocument();
    first.unmount();

    render(<NotifyMeForm {...props()} />);
    fireEvent.click(screen.getByTestId("captcha"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Submit notification" }).closest("form")!);
    await waitFor(() => expect(screen.getByText(/Не удалось сохранить запрос/)).toBeInTheDocument());
    expect(screen.getByTestId("captcha")).toHaveAttribute("data-reset-key", "1");
  });

  it("reconciles an already-available response instead of leaving a dead-end error", async () => {
    const onConflict = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: { code: "OCCURRENCE_ALREADY_AVAILABLE" } }) } as Response);
    render(<NotifyMeForm {...props(onConflict)} />);
    fireEvent.click(screen.getByTestId("captcha"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.submit(screen.getByRole("button", { name: "Submit notification" }).closest("form")!);
    await waitFor(() => expect(onConflict).toHaveBeenCalledWith("OCCURRENCE_ALREADY_AVAILABLE"));
    expect(screen.queryByText(/Не удалось сохранить запрос/)).not.toBeInTheDocument();
    expect(screen.getByTestId("captcha")).toHaveAttribute("data-reset-key", "1");
  });
});
