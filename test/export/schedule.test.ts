import { describe, expect, it } from "vitest";

import { readSnapshotFile } from "@/commerce/src/seo-snapshot-io";
import { publishableRecords } from "@/lib/seo/occurrence-publication";
import {
  actionableUpcomingEvents,
  archivedEvents,
} from "@/lib/seo/schedule-presentation";
import { toScheduleViewModel } from "@/lib/seo/schedule-view-model";
import { canonicalOf, listExport, metaName, metaProperty, readExport, textOf, titleOf } from "./read-export";

const model = () =>
  toScheduleViewModel(publishableRecords(readSnapshotFile("data/seo/occurrences.v1.json")));

/** Event hrefs in the order the document actually renders them. */
const eventHrefsInOrder = (html: string): string[] =>
  [...html.matchAll(/href="(\/events\/[^"#]+)"/g)].map((match) => match[1]);

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

  it("renders each row as CITY × DATE text, not as an image or a script payload", () => {
    // textOf collapses every whitespace class to a plain space, and the date
    // label has its own non-breaking spaces, so both sides are normalized.
    const flatten = (value: string) => value.replace(/\s+/g, " ");
    const text = flatten(textOf(html));
    for (const event of [...actionableUpcomingEvents(model()), ...archivedEvents(model())]) {
      expect(text).toContain(flatten(`${event.cityTitle} × ${event.dateLabel}`));
    }
  });

  it("lists the upcoming dates in one global chronology", () => {
    // Grouped by city, «Санкт-Петербург 25.09 / 18.10» then «Новосибирск 02.10»
    // would satisfy every other assertion in this file and still be the wrong
    // surface. This is the one that says the picker is chronological.
    const expected = actionableUpcomingEvents(model()).map((event) => event.href);
    expect(eventHrefsInOrder(html).slice(0, expected.length)).toEqual(expected);
  });

  it("carries no city anchor and no fragment navigation", () => {
    // The `/schedule#<city>` contract is deleted, not relocated. There are no
    // per-city sections to land on, and /cities/<city> now 308s to bare
    // /schedule — so an id here would be a target nothing points at.
    for (const city of model().cities) {
      expect(html).not.toContain(`id="${city.slug}"`);
    }
    expect(html).not.toContain('href="/schedule#');
    expect(html).not.toContain('href="/cities/');
  });

  it("links the archive too, because those URLs are permanent", () => {
    const archived = archivedEvents(model());
    if (archived.length === 0) return;
    expect(textOf(html)).toContain("Прошедшие и отменённые");
    for (const event of archived) {
      expect(html).toContain(`href="${event.href}"`);
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

describe("the home page's overlay boundary", () => {
  const html = readExport("index.html");
  const body = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
  /** The rendered DOM only — RSC payload scripts stripped. */
  const dom = body.replace(/<script[\s\S]*?<\/script>/g, " ");

  /**
   * The line the whole architecture rests on.
   *
   * The home page carries the schedule as SERIALIZED PROPS for a client island,
   * so the drawer opens instantly with no round trip. It must not carry it as
   * DOM content: city names and event links in the home body would be the
   * keyword-stuffed city section this redesign removed, and would duplicate
   * /schedule's content on a second URL.
   */
  it("renders no city section and no event anchors in the body", () => {
    expect(dom).not.toContain('href="/events/');
    expect(dom).not.toContain('href="/cities/');
    const text = dom.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const city of model().cities) {
      expect(text).not.toContain(city.title);
    }
  });

  it("does carry the model in the RSC payload, which is where it belongs", () => {
    for (const city of model().cities) {
      for (const event of city.upcoming) {
        expect(body).toContain(event.slug);
      }
    }
  });

  it("links the catalogue with real anchors from every booking CTA", () => {
    // Navbar, intro, price and footer. Real <a href> is what a crawler follows
    // and what a middle-click opens; the controller only intercepts the plain
    // left-click.
    expect([...dom.matchAll(/href="\/schedule"/g)]).toHaveLength(4);
  });
});

describe("every published event page", () => {
  const pages = listExport("events").filter((entry) => entry.endsWith(".html"));

  it("returns to the catalogue through exactly one semantic backlink", () => {
    // It used to be `/schedule#<city>` labelled «← Санкт-Петербург», which put
    // the city in the navigation graph. The graph is / → /schedule →
    // /events/<slug>, and this is the link that closes it for a visitor who
    // arrived from search, a messenger or a new tab — where history.back()
    // leads somewhere else entirely, or nowhere.
    for (const page of pages) {
      const html = readExport(`events/${page}`);
      const backlink = /<a[^>]*href="([^"]*)"[^>]*>←\s*Города × Даты<\/a>/.exec(html);
      expect(backlink, `no catalogue backlink in events/${page}`).not.toBeNull();
      expect(backlink?.[1]).toBe("/schedule");
    }
  });

  it("names no city as a destination and emits no fragment link", () => {
    for (const page of pages) {
      const html = readExport(`events/${page}`);
      const body = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
      const dom = body.replace(/<script[\s\S]*?<\/script>/g, " ");
      expect(dom).not.toContain('href="/schedule#');
      expect(dom).not.toContain('href="/cities/');
    }
  });
});
