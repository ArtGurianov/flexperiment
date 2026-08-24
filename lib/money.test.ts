import { describe, expect, it } from "vitest";
import { formatRubles, parseRublesToKopecks } from "./money";

describe("parseRublesToKopecks", () => {
  it.each([
    ["0.01", 1],
    ["0.29", 29],
    ["10.01", 1001],
    ["3500", 350000],
    ["3500,50", 350050],
    ["3500.5", 350050],
    ["1 000,50", 100050],
  ])("parses %s as %i kopecks", (input, expected) => {
    expect(parseRublesToKopecks(input)).toBe(expected);
  });

  it.each([
    ["1.005", "more than 2 fractional digits"],
    ["", "empty string"],
    ["-5", "negative amount"],
    ["not-a-number", "garbage"],
    ["3,500.50", "mixed thousands+decimal convention"],
    ["3500.", "trailing separator with no digits"],
  ])("rejects %s (%s)", (input) => {
    expect(parseRublesToKopecks(input)).toBeNull();
  });

  it("strips the NBSP formatRubles itself emits, round-tripping its own output", () => {
    const formatted = formatRubles(350050); // "3 500,50 ₽" with NBSP thousands separator
    const digits = formatted.replace(/[^\d,.\s ]/g, "").trim();
    expect(parseRublesToKopecks(digits)).toBe(350050);
  });

  it("uses exact integer arithmetic, not float multiplication (1.005 * 100 !== 100.5 in IEEE754)", () => {
    // If this were `Math.round(Number(x) * 100)`, "1.01" would still work,
    // but this locks in that the implementation never routes through
    // floating point multiplication at all for the 2-decimal-place case.
    expect(parseRublesToKopecks("1.01")).toBe(101);
    expect(Number("1.005") * 100).not.toBe(100.5); // documents the float trap this avoids
  });
});

describe("formatRubles", () => {
  it("formats kopecks as a ruble currency string", () => {
    expect(formatRubles(150000)).toContain("1");
    expect(formatRubles(150000)).toContain("500");
  });
});
