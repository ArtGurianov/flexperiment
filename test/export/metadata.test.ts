import { describe, expect, it } from "vitest";

import { readSnapshotFile } from "@/commerce/src/seo-snapshot-io";
import { publishableRecords } from "@/lib/seo/occurrence-publication";
import {
  canonicalOf,
  countIn,
  exportExists,
  headOf,
  LEGAL_SLUGS,
  metaName,
  metaProperty,
  readExport,
  structuredData,
  textOf,
  titleOf,
  UTILITY_ROUTES,
} from "./read-export";

/**
 * The metadata conformance matrix, asserted against generated HTML.
 *
 * Deliberately not against TypeScript source. Every defect this suite is
 * guarding was invisible in source: the root layout's `alternates` looked
 * correct until you read out/ticket.html and found the home page's canonical on
 * it, and app/page.tsx's own `twitter` object looked like an addition until the
 * built head showed it had replaced the layout's and dropped `card`.
 */
describe("the home page", () => {
  const html = readExport("index.html");

  it("has exactly one h1 and one title", () => {
    expect(countIn(html, /<h1[\s>]/g)).toBe(1);
    expect(countIn(headOf(html), /<title>/g)).toBe(1);
  });

  it("declares itself canonical", () => {
    expect(canonicalOf(html)).toBe("https://flexperiment.ru");
  });

  it("carries a location-neutral title containing the Cyrillic search term", () => {
    const title = titleOf(html) ?? "";
    expect(title).toContain("флексинг");
    // The tour's geography is Commerce's fact, not the brand copy's. A title
    // asserting a region becomes false the moment a date is scheduled outside
    // it — and the artwork still says «ВПЕРВЫЕ В СИБИРИ», which is a poster,
    // not a machine-readable claim.
    expect(title).not.toContain("Сибир");
    expect(metaName(html, "description")).not.toContain("Сибир");
    expect(textOf(html)).toContain("ВПЕРВЫЕ В СИБИРИ");
  });

  it("states the price as text a crawler can read, not only as artwork", () => {
    const text = textOf(html);
    expect(text).toContain("Базовая стоимость участия");
    expect(text).toContain("3 800 ₽");
    expect(text).toContain("3 500 ₽");
  });

  it("is not marked noindex", () => {
    expect(metaName(html, "robots")).toBeNull();
  });
});

describe("the utility routes", () => {
  it.each(UTILITY_ROUTES)("%s is noindex and owns its own metadata", (route) => {
    const html = readExport(route);

    expect(metaName(html, "robots")).toBe("noindex, nofollow");
    // The actual bug: these inherited `alternates: { canonical: "/" }` from the
    // root layout and each declared the home page as its canonical URL. noindex
    // and rel=canonical are separate controls — the fix is that they no longer
    // point anywhere, not that they point at "/".
    expect(canonicalOf(html)).toBeNull();
    expect(metaName(html, "description")).not.toContain("Арта Гурьянова");
    expect(metaProperty(html, "og:url")).toBeNull();
  });
});

describe("the 404 page", () => {
  const html = readExport("404.html");

  it("is branded rather than Next's stock page, and has a single title", () => {
    expect(countIn(headOf(html), /<title>/g)).toBe(1);
    expect(textOf(html)).toContain("Такой страницы нет");
    // The site chrome, proving it is the app's own not-found and not a
    // framework fallback.
    expect(textOf(html)).toContain("ИП Гурьянов Арт Артурович");
  });

  it("is noindex and claims no canonical URL", () => {
    expect(metaName(html, "robots")).toContain("noindex");
    // A 404 is not a duplicate of anything, so there is nothing to point at.
    expect(canonicalOf(html)).toBeNull();
  });
});

describe("the legal pages", () => {
  it.each(LEGAL_SLUGS)("/legal/%s keeps its own canonical", (slug) => {
    const html = readExport(`legal/${slug}.html`);
    expect(canonicalOf(html)).toBe(`https://flexperiment.ru/legal/${slug}`);
    expect(countIn(headOf(html), /<title>/g)).toBe(1);
  });
});

/**
 * The routes that exist in every build, plus the ones the committed snapshot
 * produces.
 *
 * Derived rather than hardcoded. The social-card assertions used to cover only
 * the static routes, because when they were written the snapshot was empty and
 * there were no event or city pages to cover — which is exactly how both routes
 * reached production emitting neither og:image nor twitter:image. A list that
 * cannot grow with the inventory cannot catch that class of defect twice.
 */
const STATIC_ROUTES = ["index.html", "404.html", ...LEGAL_SLUGS.map((slug) => `legal/${slug}.html`)];

const snapshotRoutes = (): readonly string[] => {
  const records = publishableRecords(readSnapshotFile("data/seo/occurrences.v1.json"));
  const events = records.map((record) => `events/${record.event_slug}.html`);
  const cities = [...new Set(records.map((record) => record.city))].map((city) => `cities/${city}.html`);
  return [...events, ...cities];
};

const ALL_ROUTES = [...STATIC_ROUTES, ...snapshotRoutes()];

describe("the social card", () => {
  it.each(ALL_ROUTES)("%s emits both og:image and twitter:image", (route) => {
    const html = readExport(route);
    // Both files are needed, and on the dynamic routes both must be named
    // explicitly. Next injects the app/opengraph-image.png and
    // app/twitter-image.png file conventions only where a route has not
    // declared the namespace itself — and a route whose generateMetadata
    // returns an `openGraph` or `twitter` object owns that namespace outright.
    // The event and city routes return both, so they got no injection at all.
    expect(metaProperty(html, "og:image")).toContain("opengraph-image.png");
    expect(metaName(html, "twitter:image")).toContain("twitter-image.png");
  });

  it.each(ALL_ROUTES)("%s promises a large card", (route) => {
    // The home page is the one most likely to be shared, and it is the one
    // that silently lost this to Next's shallow metadata merge.
    expect(metaName(readExport(route), "twitter:card")).toBe("summary_large_image");
  });

  it("covers the dynamic routes whenever the snapshot has any", () => {
    // Guards the guard: if snapshotRoutes() silently returned nothing, every
    // it.each above would still pass while proving nothing about event and
    // city pages. This fails instead.
    const records = publishableRecords(readSnapshotFile("data/seo/occurrences.v1.json"));
    expect(snapshotRoutes().length).toBe(
      records.length + new Set(records.map((record) => record.city)).size,
    );
    for (const route of snapshotRoutes()) expect(exportExists(route), route).toBe(true);
  });

  it("ships both 1200x630 images", () => {
    expect(exportExists("opengraph-image.png")).toBe(true);
    expect(exportExists("twitter-image.png")).toBe(true);
    expect(metaProperty(readExport("index.html"), "og:image:width")).toBe("1200");
    expect(metaProperty(readExport("index.html"), "og:image:height")).toBe("630");
  });
});

describe("Open Graph inheritance", () => {
  // The same snapshot-derived set, so the dynamic routes prove these fields in
  // generated HTML rather than having them inferred from the spread in source.
  const routes = ["index.html", "ticket.html", "404.html", "legal/public-offer.html", ...snapshotRoutes()];

  it.each(routes)("%s keeps the site-wide og fields its own object could have dropped", (route) => {
    const html = readExport(route);
    expect(metaProperty(html, "og:site_name")).toBe("FLEXPERIMENT");
    expect(metaProperty(html, "og:locale")).toBe("ru_RU");
    expect(metaProperty(html, "og:type")).not.toBeNull();
  });
});

describe("Organization structured data", () => {
  it("states only facts the repository already carries", () => {
    const graphs = structuredData(readExport("index.html"));
    expect(graphs).toHaveLength(1);
    const graph = graphs[0] as { "@graph": Record<string, unknown>[] };
    const organization = graph["@graph"].find((node) => node["@type"] === "Organization")!;

    expect(organization.legalName).toBe("ИП Гурьянов Арт Артурович");
    expect(organization.email).toBe("art@flexperiment.ru");
    // Nothing invented: the repo carries no verified values for any of these,
    // and a plausible-looking guess in structured data is a claim.
    expect(organization.sameAs).toBeUndefined();
    expect(organization.address).toBeUndefined();
    expect(organization.logo).toBeUndefined();
    expect(organization.foundingDate).toBeUndefined();
  });

  it("asserts no commercial offer from the editorial home-page price", () => {
    const raw = readExport("index.html");
    const blocks = structuredData(raw).map((graph) => JSON.stringify(graph));
    for (const block of blocks) {
      expect(block).not.toContain('"Offer"');
      expect(block).not.toContain("3800");
      expect(block).not.toContain("3500");
    }
  });

  it("cannot be broken out of by a `</script>` in any value", () => {
    // The home page's graph is all literals, so this is the weaker half of the
    // guarantee — components/structured-data-escaping.test.ts renders the event
    // graph with a hostile title, city and venue. This asserts the escaping
    // survives the real build rather than only the unit test.
    const html = readExport("index.html");
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, payload] of blocks) {
      expect(payload).not.toContain("<");
    }
  });

  it("emits no FAQPage, while keeping the FAQ as content", () => {
    // Google restricted FAQ rich results to government and health sites in
    // August 2023, so the markup buys nothing. The questions stay because they
    // are useful, not because they are eligible.
    expect(readExport("index.html")).not.toContain("FAQPage");
    expect(textOf(readExport("index.html"))).toContain("Вопросы");
  });
});
