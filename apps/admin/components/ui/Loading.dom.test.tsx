import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Loading } from "./Loading";

describe("Loading", () => {
  it("announces an in-progress state to assistive technology", () => {
    render(<Loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Загружаем authoritative state…");
  });
});
