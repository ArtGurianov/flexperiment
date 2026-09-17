import { describe, expect, it } from "vitest";

import { readSnapshotFile } from "@/commerce/src/seo-snapshot-io";
import { belongsInSitemap, publishableRecords } from "@/lib/seo/occurrence-publication";
import { exportExists, LEGAL_SLUGS, listExport, readExport } from "./read-export";

/**
 * robots.txt, sitemap.xml and the shape of the published route set.
 *
 * Both files 404ed in production before this work, so every assertion here is
 * about something that did not exist rather than something that regressed.
 */
describe("robots.txt", () => {
  const robots = readExport("robots.txt");

  it("is generated and points at the sitemap", () => {
    expect(robots).toContain("User-Agent: *");
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Sitemap: https://flexperiment.ru/sitemap.xml");
  });

  it("does not Disallow the surfaces that are suppressed by header instead", () => {
    // The .txt RSC payloads and the raw legal .md sources are suppressed with
    // X-Robots-Tag in nginx, not with Disallow. The two cannot be combined: a
    // crawler that obeys Disallow never fetches the URL and so never sees the
    // header, while a Disallowed URL can still be indexed URL-only.
    expect(robots).not.toContain("Disallow");
  });
});

describe("sitemap.xml", () => {
  const sitemap = readExport("sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);

  it("lists the home page and every legal document", () => {
    expect(locations).toContain("https://flexperiment.ru");
    for (const slug of LEGAL_SLUGS) {
      expect(locations).toContain(`https://flexperiment.ru/legal/${slug}`);
    }
  });

  it("lists nothing that is noindex, not a page, or not canonical", () => {
    for (const location of locations) {
      // Listing a noindex URL is a direct contradiction that search consoles
      // report as an error.
      expect(location).not.toMatch(/\/(ticket|refund|payment)/);
      expect(location).not.toMatch(/\.(txt|md)$/);
      expect(location).not.toContain("/legal/archive/");
      // The city layer is retired; its one published URL 308s instead.
      expect(location).not.toContain("/cities/");
      expect(location).not.toContain("__placeholder__");
    }
  });

  it("omits priority and changefreq rather than fabricating them", () => {
    // Google ignores both, and a changefreq on a page that has not changed is
    // noise. lastModified is omitted for the same reason: a build timestamp
    // would claim every page changed on every deploy.
    expect(sitemap).not.toContain("<priority>");
    expect(sitemap).not.toContain("<changefreq>");
    expect(sitemap).not.toContain("<lastmod>");
  });

  it("agrees exactly with what the snapshot says is listable", () => {
    const snapshot = readSnapshotFile("data/seo/occurrences.v1.json");
    const expected = [...snapshot.occurrences, ...snapshot.tombstones]
      .filter(belongsInSitemap)
      .map((record) => `https://flexperiment.ru/events/${record.event_slug}`);
    const listed = locations.filter((location) => location.includes("/events/"));
    expect(listed.sort()).toEqual(expected.sort());
  });
});

describe("the RSC payloads that are the client-side router", () => {
  it("still ships, because removing them would break in-app navigation", () => {
    // out/_next/static/chunks/846-*.js builds these requests as
    // `pathname += ".txt"`. They are navigation, not content, so they are
    // suppressed from indexing with a header and never removed or 404ed.
    expect(exportExists("index.txt")).toBe(true);
    expect(exportExists("legal/public-offer.txt")).toBe(true);
  });
});

describe("the build agrees with the committed snapshot", () => {
  const snapshot = readSnapshotFile("data/seo/occurrences.v1.json");
  const records = publishableRecords(snapshot);

  /**
   * These assertions used to pin the snapshot as EMPTY, which held only while
   * production's one occurrence was rejected on a timezone contradiction. That
   * record has been corrected, so the emptiness assertion pinned a historical
   * accident rather than a property.
   *
   * What replaces it is stronger in both directions: the export must contain a
   * page for every publishable record and a record for every page. That is
   * meaningful when the snapshot is empty (nothing may be emitted) and equally
   * meaningful when it is not (nothing extra, nothing missing) — where the old
   * version said nothing at all.
   */
  it("emits exactly one page per publishable record, and no others", () => {
    const expected = records.map((record) => `${record.event_slug}.html`).sort();
    const emitted = listExport("events").filter((entry) => entry.endsWith(".html")).sort();
    expect(emitted).toEqual(expected);
  });

  it("no longer emits a city layer at all", () => {
    // /cities/[city] was retired in favour of /schedule. The one published city
    // URL 308s at the nginx layer; nothing is built for it any more.
    expect(exportExists("cities")).toBe(false);
    expect(listExport("cities")).toEqual([]);
  });

  it("emits /schedule as the one catalogue, whatever the snapshot holds", () => {
    // A fixed route, so unlike /events/[slug] it cannot go empty.
    expect(exportExists("schedule.html")).toBe(true);
  });

  it("never ships the reserved placeholder, in either regime", () => {
    // Next refuses an empty generateStaticParams() under output: "export", so
    // each route emits one reserved `__placeholder__` file when there is
    // nothing to publish, and `pnpm build` prunes it. A URL answering 200 with
    // a 404 body is still a fabricated event URL on a public site.
    expect(exportExists("events/__placeholder__.html")).toBe(false);
    for (const segment of ["events"]) {
      expect(listExport(segment).some((entry) => entry.startsWith("__placeholder__"))).toBe(false);
    }
  });

  it("leaves no route directory behind when there is nothing to publish", () => {
    if (records.length > 0) {
      expect(exportExists("events")).toBe(true);
      return;
    }
    expect(exportExists("events")).toBe(false);
  });

  it("builds the home page and every legal page regardless", () => {
    expect(exportExists("index.html")).toBe(true);
    expect(exportExists("404.html")).toBe(true);
    for (const slug of LEGAL_SLUGS) {
      expect(exportExists(`legal/${slug}.html`)).toBe(true);
    }
  });
});
