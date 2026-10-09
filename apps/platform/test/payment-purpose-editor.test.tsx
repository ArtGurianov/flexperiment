// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfferPaymentPurposeField } from "../components/admin/OfferPaymentPurposeField";

const form = vi.hoisted(() => ({ courseRef: "one" }));
vi.mock("@payloadcms/ui", () => ({ useFormFields: (select: (fields: unknown[]) => unknown) => select([{ courseRef: { value: form.courseRef } }]) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); form.courseRef = "one"; });
const facts = { paymentPurpose: "Explicit merchant purpose", version: 3, offerRef: "course:one" };
const response = (body: unknown, status = 200) => ({ ok: status === 200, json: async () => body } as Response);

describe("native Payload offer purpose editor", () => {
  it("loads explicit text, saves with optimistic version and has no browser credential", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts))
      .mockResolvedValueOnce(response({ paymentPurpose: "New merchant purpose", version: 4 }));
    render(<OfferPaymentPurposeField />);
    const field = screen.getByRole("textbox");
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(facts.paymentPurpose));
    fireEvent.change(field, { target: { value: "New merchant purpose" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить назначение" }));
    await screen.findByText("Сохранено в offer. Существующие заказы не изменены.");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toEqual({ paymentPurpose: "New merchant purpose", expectedVersion: 3 });
    expect(fetch.mock.calls[1][1]?.headers).not.toHaveProperty("authorization");
    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });
  it("does not permit old course facts to be saved while the new course is loading", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts))
      .mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<OfferPaymentPurposeField />);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(facts.paymentPurpose));
    form.courseRef = "two"; view.rerender(<OfferPaymentPurposeField />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("reports a stale version without pretending the change was saved", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts))
      .mockResolvedValueOnce(response({ code: "CATALOG_VERSION_CONFLICT" }, 409));
    render(<OfferPaymentPurposeField />);
    const field = screen.getByRole("textbox");
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe(facts.paymentPurpose));
    fireEvent.change(field, { target: { value: "New" } }); fireEvent.click(screen.getByRole("button"));
    await screen.findByText("Offer изменился. Перезагрузите страницу перед сохранением.");
    expect(screen.queryByText("Сохранено в offer. Существующие заказы не изменены.")).toBeNull();
  });
  it("disables editing when no authoritative offer can be read", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, 503));
    render(<OfferPaymentPurposeField />);
    await screen.findByText(/Сначала настройте offer/);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  });
});
