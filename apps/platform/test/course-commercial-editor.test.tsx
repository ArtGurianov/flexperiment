// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CourseCommercialSummaryField } from "../components/admin/CourseCommercialSummaryField";
const form = vi.hoisted(() => ({ courseRef: "one" }));
vi.mock("@payloadcms/ui", () => ({ useFormFields: (select: (fields: unknown[]) => unknown) => select([{ courseRef: { value: form.courseRef } }]) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); form.courseRef = "one"; });
const facts = { version: 1, accessModel: "FREE", priceKopecks: 0, saleMode: "CLOSED", withdrawn: false };
const response = (body: unknown, status = 200) => ({ ok: status === 200, json: async () => body } as Response);
const save = () => screen.getByRole("button", { name: "Сохранить в Commerce" });
describe("native Payload access and price control", () => {
  it("creates a FREE offer only after explicit save and independent GET read-back", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response({ state: "UNCONFIGURED", version: 0 }))
      .mockResolvedValueOnce(response({ ...facts, cacheRefresh: "CONFIRMED" })).mockResolvedValueOnce(response(facts));
    render(<CourseCommercialSummaryField />); await screen.findByText("Продукт ещё не настроен.");
    expect(fetch).toHaveBeenCalledTimes(1); fireEvent.click(save()); await screen.findByText("Commerce подтвердил запись. Продажи закрыты.");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ accessModel: "FREE", priceKopecks: 0, expectedVersion: 0 });
    expect(fetch.mock.calls[1][1]?.headers).not.toHaveProperty("authorization"); expect(fetch).toHaveBeenCalledTimes(3);
    expect(save().getAttribute("type")).toBe("button");
  });
  it("converts decimal rubles to integer kopecks without rounding and does not open sales", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts))
      .mockResolvedValueOnce(response({ version: 2 })).mockResolvedValueOnce(response({ ...facts, accessModel: "PAID", priceKopecks: 12345, version: 2 }));
    render(<CourseCommercialSummaryField />); await screen.findByText("Версия 1 · Продажи: CLOSED");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "PAID" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "123,45" } }); fireEvent.click(save());
    await screen.findByText("Commerce подтвердил запись. Продажи закрыты.");
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body))).toMatchObject({ accessModel: "PAID", priceKopecks: 12345, expectedVersion: 1 });
  });
  it.each(["0", "-1", "1.001", "NaN"])("refuses invalid paid price %s before the mutation", async price => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(facts)); render(<CourseCommercialSummaryField />);
    await screen.findByText("Версия 1 · Продажи: CLOSED"); fireEvent.change(screen.getByRole("combobox"), { target: { value: "PAID" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: price } }); fireEvent.click(save());
    await screen.findByText("Укажите положительную цену с точностью до копейки."); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("blocks stale cross-course state and waits for fresh facts", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts)).mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<CourseCommercialSummaryField />); await screen.findByText("Версия 1 · Продажи: CLOSED");
    form.courseRef = "two"; view.rerender(<CourseCommercialSummaryField />);
    await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(true));
  });
  it("does not claim success or permit blind retries when independent GET contradicts POST", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts)).mockResolvedValueOnce(response({ version: 2 }))
      .mockResolvedValueOnce(response(facts)); render(<CourseCommercialSummaryField />); await screen.findByText("Версия 1 · Продажи: CLOSED");
    fireEvent.click(save()); await screen.findByText("Независимая проверка не подтвердила запись. Обновите данные.");
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });
});
