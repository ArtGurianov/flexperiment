import { describe, expect, it } from "vitest";

import { readSnapshotFile } from "@/commerce/src/seo-snapshot-io";
import { publishableRecords } from "@/lib/seo/occurrence-publication";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import { canonicalOf, metaName, metaProperty, readExport, textOf, titleOf } from "./read-export";

const model = () =>
  toScheduleViewModel(publishableRecords(readSnapshotFile("data/seo/occurrences.v1.json")));

describe("/schedule", () => {
  const html = readExport("schedule.html");

  it("is canonical, indexable, and carries its own social card", () => {
    expect(canonicalOf(html)).toBe("https://flexperiment.ru/schedule");
    expect(metaName(html, "robots")).toBeNull();
    expect(titleOf(html)).toContain("Города и даты");
    expect(metaProperty(html, "og:image")).toContain("opengraph-image.png");
    expect(metaName(html, "twitter:image")).toContain("twitter-image.png");
    expect(metaName(html, "twitter:card")).toBe("summary_large_image");
    expect(metaProperty(html, "og:site_name")).toBe("FLEXPERIMENT");
  });

  it("links every publishable event with a real anchor", () => {
    // This route exists because the catalogue used to live only inside a
    // client-only dialog, so no crawler ever saw a city, a date, or a path to
    // an event page. Anchors are the whole point — a button would not do.
    const linked = [...html.matchAll(/href="(\/events\/[^"]+)"/g)].map((match) => match[1]).sort();
    const expected = model()
      .cities.flatMap((city) => [...city.upcoming, ...city.archived])
      .map((event) => event.href)
      .sort();
    expect([...new Set(linked)]).toEqual([...new Set(expected)]);
  });

  it("renders each city's name and dates as text, not as an image or a script payload", () => {
    // Intl.NumberFormat emits NBSP and narrow-NBSP inside a ruble amount, and
    // textOf collapses every whitespace class to a plain space. Both sides have
    // to be normalized or "3 800,00 ₽" never equals "3 800,00 ₽".
    const flatten = (value: string) => value.replace(/\s+/g, " ");
    const text = flatten(textOf(html));
    for (const city of model().cities) {
      expect(text).toContain(flatten(city.title));
      for (const event of city.upcoming) {
        expect(text).toContain(flatten(event.dateLabel));
        expect(text).toContain(flatten(event.priceLabel));
      }
    }
  });

  it("gives every city an anchor id, which is where retired /cities URLs will point", () => {
    for (const city of model().cities) {
      expect(html).toContain(`id="${city.slug}"`);
    }
  });

  it("exists and answers honestly even when nothing is announced", () => {
    // A fixed route, so unlike /events/[slug] it has no generateStaticParams to
    // go empty. With an empty snapshot it must still build and say so.
    if (model().cities.length === 0) {
      expect(textOf(html)).toContain("пока не объявлены");
    }
    expect(titleOf(html)).not.toBeNull();
  });
});

describe("the home page's price section", () => {
  const html = readExport("index.html");
  const text = textOf(html);

  /**
   * Regression guard on an SEO change that should never have been made.
   *
   * To get the price into crawlable text, an earlier pass added separately
   * typeset «3 800 ₽» and «3 500 ₽» blocks under the artwork — which redesigned
   * a section SEO had no business redesigning. The composition is back to
   * artwork plus one caption, and the readable text now lives in `alt`, where a
   * true equivalent of an image that genuinely depicts those figures belongs.
   */
  it("shows the original caption and no separately typeset figures", () => {
    expect(text).toContain("*при применении действующего промокода или 3800р");
    expect(text).not.toContain("Базовая стоимость участия");
    // The visible body must not restate the numbers on their own.
    expect(text).not.toContain("3 800 ₽");
    expect(text).not.toContain("3 500 ₽");
  });

  it("keeps the price readable through the artwork's text equivalent", () => {
    expect(html).toContain('alt="3500 ₽ с действующим промокодом; 3800 ₽ без промокода"');
    // aria-hidden would suppress that equivalent, which is what the previous
    // version did once the figures moved into the body.
    const priceImg = /<img[^>]*alt="3500 ₽[^"]*"[^>]*>/.exec(html)?.[0] ?? "";
    expect(priceImg).not.toContain("aria-hidden");
  });
});
