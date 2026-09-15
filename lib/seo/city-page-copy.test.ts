import { describe, expect, it } from "vitest";

import { cityPageCopy } from "./city-page-copy";

/**
 * A city page outlives its dates, and its metadata has to say so.
 *
 * The page body already handled this — it renders «Ближайшие даты в этом городе
 * пока не объявлены» above a «Прошедшие и отменённые» list — but the title and
 * description still promised «Ближайшие мастер-классы … даты, площадка и
 * стоимость участия» unconditionally, and that is the version a search result
 * shows.
 */
describe("cityPageCopy", () => {
  it("advertises dates when there are dates to advertise", () => {
    const copy = cityPageCopy({ cityTitle: "Новосибирск", hasUpcoming: true });
    expect(copy.title).toContain("Мастер-классы по флексингу в городе Новосибирск");
    expect(copy.description).toContain("Ближайшие мастер-классы");
    expect(copy.description).toContain("даты, площадка и стоимость участия");
  });

  it("describes an archive-only city as an archive", () => {
    const copy = cityPageCopy({ cityTitle: "Томск", hasUpcoming: false });
    expect(copy.title).toBe("FLEXPERIMENT в городе Томск — прошедшие мастер-классы");
    // The claim that would have been false: that there are dates, a venue and a
    // price to come.
    expect(copy.description).not.toContain("даты, площадка и стоимость участия");
    expect(copy.description).toContain("пока не объявлены");
    expect(copy.description).toContain("прошедшие и отменённые");
  });

  it("names the city in both branches, since that is what the page is for", () => {
    for (const hasUpcoming of [true, false]) {
      const copy = cityPageCopy({ cityTitle: "Кемерово", hasUpcoming });
      expect(copy.title).toContain("Кемерово");
      expect(copy.description).toContain("Кемерово");
    }
  });
});
