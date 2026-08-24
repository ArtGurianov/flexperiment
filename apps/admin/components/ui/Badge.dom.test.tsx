import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("renders an em dash for empty or whitespace-only content instead of a blank pill", () => {
    render(<Badge>{"   "}</Badge>);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders an em dash for no children at all", () => {
    render(<Badge />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders real content untouched", () => {
    render(<Badge>PUBLISHED</Badge>);
    expect(screen.getByText("PUBLISHED")).toBeInTheDocument();
  });
});
