import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createTestQueryClient, QueryClientWrapper } from "../../lib/test-query-client";
import { RefundAction } from "./RefundAction";

describe("RefundAction", () => {
  it("retains a typed amount while a poll lowers the ceiling, then blocks submit (A6)", async () => {
    const client = createTestQueryClient();
    const user = userEvent.setup();
    const view = render(<RefundAction orderId="order-1" max={100_000} close={() => {}} />, {
      wrapper: (props) => <QueryClientWrapper client={client}>{props.children}</QueryClientWrapper>,
    });
    const amount = screen.getByLabelText(/Сумма/);
    await user.clear(amount);
    await user.type(amount, "1000");

    view.rerender(<RefundAction orderId="order-1" max={50_000} close={() => {}} />);

    expect(amount).toHaveValue("1000");
    expect(screen.getByText(/Доступно не больше 500/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Создать refund/ })).toBeDisabled();
  });
});
