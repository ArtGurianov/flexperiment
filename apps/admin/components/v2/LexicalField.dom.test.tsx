import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LexicalField } from "./LexicalField";
import type { LexicalContent } from "./editorial-model";

describe("minimal Lexical content field", () => {
  it("does not mark a new empty editor as changed during initialization", async () => {
    const onChange = vi.fn<(value: LexicalContent) => void>();
    render(<LexicalField label="Текст курса" value={null} onChange={onChange} />);
    expect(await screen.findByRole("textbox", { name: "Текст курса" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens saved paragraph and text content", async () => {
    const onChange = vi.fn<(value: LexicalContent) => void>();
    const value: LexicalContent = { root: { type: "root", version: 1, children: [
      { type: "paragraph", version: 1, children: [
        { type: "text", version: 1, text: "Hello", detail: 0, format: 0, mode: "normal", style: "" },
      ] },
    ] } };
    render(<LexicalField label="Текст курса" value={value} onChange={onChange} />);
    expect(await screen.findByRole("textbox", { name: "Текст курса" })).toHaveTextContent("Hello");
    expect(screen.getByRole("button", { name: "Полужирный" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).not.toHaveBeenCalled();
  });
});
