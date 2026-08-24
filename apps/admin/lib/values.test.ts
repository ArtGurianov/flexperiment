import { describe, expect, it } from "vitest";
import { maybeMoney, maybeNumber, renderMaybe } from "./values";

describe("maybeNumber", () => {
  it("treats an absent counter as unknown, not zero", () => {
    expect(maybeNumber(undefined)).toEqual({ known: false });
    expect(maybeNumber(null)).toEqual({ known: false });
  });

  it("treats a genuine zero as known", () => {
    expect(maybeNumber(0)).toEqual({ known: true, value: 0 });
  });

  it("treats an unparseable value as unknown", () => {
    expect(maybeNumber("not-a-number")).toEqual({ known: false });
  });

  it("parses a numeric string", () => {
    expect(maybeNumber("42")).toEqual({ known: true, value: 42 });
  });
});

describe("renderMaybe", () => {
  it("renders the em dash for an unknown value, never a formatted zero", () => {
    expect(renderMaybe(maybeNumber(undefined), (v) => String(v))).toBe("—");
  });

  it("formats a known value", () => {
    expect(renderMaybe(maybeNumber(3), (v) => `${v}!`)).toBe("3!");
  });
});

describe("maybeMoney", () => {
  it("renders — for a missing counter instead of ₽0,00", () => {
    expect(maybeMoney(undefined)).toBe("—");
  });

  it("formats a present kopeck amount as rubles", () => {
    expect(maybeMoney(150000)).toContain("1");
  });
});
