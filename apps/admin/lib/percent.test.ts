import { describe, expect, it } from "vitest";
import { formatBasisPoints, parsePercentToBasisPoints } from "./percent";

describe("percent UI values", () => {
  it("converts decimal percentages without floating point arithmetic", () => {
    expect(parsePercentToBasisPoints("10")).toBe(1_000);
    expect(parsePercentToBasisPoints("1,25")).toBe(125);
    expect(parsePercentToBasisPoints("1.234")).toBeNull();
    expect(formatBasisPoints(1_000)).toBe("10,00%");
  });
});
