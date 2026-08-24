import { describe, expect, it } from "vitest";
import { formatDuration, formatDurationBetween, formatHoursAndMinutes, minutesToMilliseconds, parseHoursAndMinutes } from "./duration";

describe("operator duration input", () => {
  it("accepts both decimal separators as hours and minutes without floating-point conversion", () => {
    expect(parseHoursAndMinutes("1,30")).toBe(90);
    expect(parseHoursAndMinutes("0.05")).toBe(5);
    expect(parseHoursAndMinutes("2")).toBe(120);
    expect(parseHoursAndMinutes("1,60")).toBeNull();
    expect(parseHoursAndMinutes("1,5,0")).toBeNull();
  });

  it("round-trips stored event instants and derives ISO-safe minute offsets", () => {
    expect(formatDurationBetween("2026-10-01T10:00:00.000Z", "2026-10-01T11:35:00.000Z")).toBe("1,35");
    expect(formatHoursAndMinutes(95)).toBe("1,35");
    expect(formatDuration(95)).toBe("1 ч 35 мин");
    expect(new Date(Date.parse("2026-10-01T10:00:00.000Z") + minutesToMilliseconds(95)).toISOString()).toBe("2026-10-01T11:35:00.000Z");
  });
});
