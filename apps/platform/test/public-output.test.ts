import { describe, expect, it } from "vitest";
import { buildPublicSearchIndex } from "../lib/public-search";
import { analyticsConsentFromCookie, safeAnalyticsLocation } from "../lib/analytics-consent";

describe("public discovery output", () => {
  it("includes listed lessons, excludes withdrawn courses, and exposes only the public contract", () => {
    const documents = [
      { type: "course" as const, ref: "course-one", courseRef: "course-one", title: "Курс", summary: "Описание", url: "/courses/one" },
      { type: "lesson" as const, ref: "lesson-one", courseRef: "course-one", title: "Урок", summary: "Курс", url: "/courses/one/lessons/one" },
      { type: "lesson" as const, ref: "hidden", courseRef: "withdrawn", title: "Скрытый", summary: "Курс", url: "/courses/hidden/lessons/hidden" },
    ];
    const commercial = new Map([
      ["course-one", { courseRef: "course-one", offerRef: null, accessModel: "FREE" as const, withdrawn: false, saleMode: "CLOSED" as const, priceKopecks: 0 }],
      ["withdrawn", { courseRef: "withdrawn", offerRef: null, accessModel: "PAID" as const, withdrawn: true, saleMode: "CLOSED" as const, priceKopecks: 100 }],
    ]);
    const index = buildPublicSearchIndex(documents, commercial);
    expect(index.map(({ type, ref }) => `${type}:${ref}`)).toEqual(["course:course-one", "lesson:lesson-one"]);
    expect(JSON.stringify(index)).not.toMatch(/videoId|active_video|token|secret/i);
  });

  it("keeps analytics opt-in explicit and strips sensitive query parameters", () => {
    expect(analyticsConsentFromCookie("other=x; fx_consent=v1%3Aa1")).toBe("ALLOWED");
    expect(analyticsConsentFromCookie("")).toBe("UNDECIDED");
    expect(safeAnalyticsLocation("/courses/one", "?utm_source=mail&state=secret&rt=token&gclid=ad"))
      .toBe("/courses/one?gclid=ad&utm_source=mail");
    expect(safeAnalyticsLocation("/account", "?utm_source=mail")).toBeNull();
  });
});
