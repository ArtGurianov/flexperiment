import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

describe("Dialog", () => {
  it("closes with the top-left cross or a backdrop click, without an cancel action", () => {
    const close = vi.fn();
    render(<Dialog title="Проверка" close={close}><p>Содержимое</p></Dialog>);

    expect(screen.queryByRole("button", { name: "Отмена" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть окно" }));
    expect(close).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(close).toHaveBeenCalledTimes(2);
  });
});
