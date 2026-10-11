// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("reconciles a committed write after failed GET using refresh only, without another POST", async () => {
    let committed = facts;
    let postCount = 0;
    let getCount = 0;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      if (options?.method === "POST") {
        postCount += 1; committed = { ...facts, version: 2, accessModel: "PAID", priceKopecks: 500 };
        return response({ ...committed, cacheRefresh: "CONFIRMED" });
      }
      if (++getCount === 2) throw new Error("network unavailable after commit");
      return response(committed);
    });
    render(<CourseCommercialSummaryField />); await screen.findByText("Версия 1 · Продажи: CLOSED");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "PAID" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "5" } }); fireEvent.click(save());
    await waitFor(() => expect((save() as HTMLButtonElement).disabled).toBe(true));
    expect(screen.queryByText("Commerce подтвердил запись. Продажи закрыты.")).toBeNull();
    const refresh = screen.getByRole("button", { name: "Обновить данные" });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refresh); await screen.findByText("Версия 2 · Продажи: CLOSED");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("PAID");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("5");
    expect(postCount).toBe(1); expect(fetch).toHaveBeenCalledTimes(4);
    expect(screen.getByRole("status").textContent).toContain("Свежие данные Commerce загружены");
  });
  it("does not revive cached A facts while a fresh A→B→A read is pending", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts)).mockImplementation(() => new Promise(() => {}));
    const view = render(<CourseCommercialSummaryField />); await screen.findByText("Версия 1 · Продажи: CLOSED");
    form.courseRef = "two"; view.rerender(<CourseCommercialSummaryField />);
    form.courseRef = "one"; view.rerender(<CourseCommercialSummaryField />);
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Версия 1 · Продажи: CLOSED")).toBeNull();
  });
  it("ignores a late POST completion from an old A editor after A→B→A, without a second write", async () => {
    let finishPost!: (value: Response) => void;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(response(facts))
      .mockImplementationOnce(() => new Promise(resolve => { finishPost = resolve; }))
      .mockResolvedValueOnce(response({ ...facts, version: 3 }))
      .mockResolvedValueOnce(response({ ...facts, version: 5 }))
      .mockResolvedValueOnce(response({ ...facts, version: 2 }));
    const view = render(<CourseCommercialSummaryField />); await screen.findByText("Версия 1 · Продажи: CLOSED");
    fireEvent.click(save()); form.courseRef = "two"; view.rerender(<CourseCommercialSummaryField />);
    await screen.findByText("Версия 3 · Продажи: CLOSED");
    form.courseRef = "one"; view.rerender(<CourseCommercialSummaryField />); await screen.findByText("Версия 5 · Продажи: CLOSED");
    await act(async () => finishPost(response({ version: 2 })));
    expect(screen.getByText("Версия 5 · Продажи: CLOSED")).toBeTruthy();
    expect(fetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
