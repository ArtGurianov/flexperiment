import { describe, expect, it } from "vitest";
import { publicOrderNumber } from "../src/crypto";

describe("public order numbers", () => {
  it("uses an immutable-reference format with 80 random bits", () => {
    const numbers = Array.from({ length: 1_000 }, publicOrderNumber);
    expect(numbers.every((value) => /^FX-[A-F0-9]{20}$/.test(value))).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
